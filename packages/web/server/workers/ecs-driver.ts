import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ECSClient, DescribeTasksCommand, ListTasksCommand, RunTaskCommand, StopTaskCommand, type RunTaskCommandInput, type Task } from "@aws-sdk/client-ecs";
import { z } from "zod";
import { fromHttp } from "@aws-sdk/credential-provider-http";
import { LauncherError, type ContainerDriver, type ContainerSpec, type LauncherContainer } from "./launcher.js";

const text = z.string().min(1).max(200);
const configSchema = z.object({
  installationId: text, region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  cluster: z.string().regex(/^arn:aws(?:-us-gov)?:ecs:[^:]+:\d{12}:cluster\/.+$/),
  taskDefinition: z.string().regex(/^arn:aws(?:-us-gov)?:ecs:[^:]+:\d{12}:task-definition\/.+:\d+$/),
  containerName: text, subnets: z.array(z.string().regex(/^subnet-[a-f0-9]+$/)).min(1),
  securityGroups: z.array(z.string().regex(/^sg-[a-f0-9]+$/)).min(1),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  capacityProvider: z.enum(["FARGATE", "FARGATE_SPOT"]).default("FARGATE"),
  assignPublicIp: z.boolean().default(false),
  configurationRevision: text, platformVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default("1.4.0"),
  requestTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  retirementTimeoutMs: z.number().int().min(1000).max(900_000).default(180_000),
}).strict();
export type EcsDriverOptions = z.input<typeof configSchema>;
const prefix = "dispatch:";
const reserved = ["DISPATCH_INSTALLATION_ID", "DISPATCH_WORKER_ATTEMPT_ID", "DISPATCH_CONVERSATION_ID", "DISPATCH_POSTGRES_STORE_ID", "DISPATCH_WORKER_CONFIGURATION_REVISION", "DISPATCH_WORKER_TOKEN"];

/** Standalone Fargate tasks, NOT desired-count services. No transparent SDK retries.
 * RunTask can execute before its response arrives. The launcher owns the durable
 * pre-call intent and must never retry an ambiguous launch, even with clientToken.
 */
export class EcsContainerDriver implements ContainerDriver {
  private readonly config: z.output<typeof configSchema>;
  private readonly client: ECSClient;
  constructor(options: EcsDriverOptions, private readonly workerEnvironment: (spec: ContainerSpec) => Record<string, string>) {
    this.config = configSchema.parse(options);
    if (reserved.some(key => key in this.config.environment)) throw new Error("Operator environment cannot override worker identity.");
    this.client = new ECSClient({ region: this.config.region, maxAttempts: 1, credentials: fromHttp() });
  }
  async create(_spec: ContainerSpec): Promise<void> { throw new Error("ECS does not support stopped-container creation."); }
  async start(_id: string): Promise<void> { throw new Error("ECS tasks cannot be restarted."); }
  private request(spec: ContainerSpec): RunTaskCommandInput {
    if (spec.installationId !== this.config.installationId || spec.configurationRevision !== this.config.configurationRevision)
      throw new LauncherError(409, "Worker configuration does not match the pinned ECS configuration.");
    const environment = { ...this.config.environment, ...this.workerEnvironment(spec),
      DISPATCH_INSTALLATION_ID: spec.installationId, DISPATCH_WORKER_ATTEMPT_ID: spec.attemptId,
      DISPATCH_CONVERSATION_ID: spec.conversationId, DISPATCH_POSTGRES_STORE_ID: spec.storeId,
      DISPATCH_WORKER_CONFIGURATION_REVISION: spec.configurationRevision };
    const tags = Object.entries({ installationId: spec.installationId, attemptId: spec.attemptId,
      conversationId: spec.conversationId, storeId: spec.storeId, configurationRevision: spec.configurationRevision, name: spec.name })
      .map(([key, value]) => ({ key: prefix + key, value }));
    return {
      cluster: this.config.cluster, taskDefinition: this.config.taskDefinition,
      capacityProviderStrategy: [{ capacityProvider: this.config.capacityProvider, weight: 1 }],
      count: 1, platformVersion: this.config.platformVersion,
      clientToken: createHash("sha256").update(JSON.stringify([spec.installationId, spec.attemptId])).digest("hex"),
      startedBy: createHash("sha256").update(spec.installationId).digest("hex").slice(0, 36),
      enableExecuteCommand: false, tags,
      networkConfiguration: { awsvpcConfiguration: { subnets: this.config.subnets, securityGroups: this.config.securityGroups, assignPublicIp: this.config.assignPublicIp ? "ENABLED" : "DISABLED" } },
      overrides: { containerOverrides: [{ name: this.config.containerName,
        environment: Object.entries(environment).map(([name, value]) => ({ name, value })) }] },
    };
  }
  launchFingerprint(spec: ContainerSpec): string {
    return createHash("sha256").update(JSON.stringify(this.request(spec))).digest("hex");
  }
  async run(spec: ContainerSpec, fingerprint: string): Promise<LauncherContainer> {
    const request = this.request(spec);
    if (createHash("sha256").update(JSON.stringify(request)).digest("hex") !== fingerprint)
      throw new LauncherError(503, "Launch configuration changed after committed intent.");
    const response = await this.client.send(new RunTaskCommand(request), this.deadline());
    if (response.failures?.length || response.tasks?.length !== 1 || !response.tasks[0]?.taskArn)
      throw new LauncherError(503, "ECS launch outcome unresolved; do not repeat the launch.");
    // Return the immutable identity immediately, without a second AWS request that
    // might fail before the launcher journals it. Describe verifies tags afterwards.
    return { ...spec, id: response.tasks[0].taskArn, state: "unknown" };
  }
  async inspectTask(id: string): Promise<LauncherContainer> {
    return this.decode((await this.describeTasks([id]))[0]!);
  }
  private async describeTasks(ids: string[]): Promise<Task[]> {
    for (const id of ids) this.validateArn(id);
    const response = await this.client.send(new DescribeTasksCommand({ cluster: this.config.cluster, tasks: ids, include: ["TAGS"] }), this.deadline());
    const tasks = response.tasks ?? [];
    if (response.failures?.length || tasks.length !== ids.length || new Set(tasks.map(task => task.taskArn)).size !== ids.length
      || tasks.some(task => !task.taskArn || !ids.includes(task.taskArn)))
      throw new LauncherError(503, "ECS task identity unavailable; absence is not retirement evidence.");
    return tasks;
  }
  async list(installationId: string): Promise<LauncherContainer[]> {
    if (installationId !== this.config.installationId) throw new Error("Installation mismatch.");
    const result: LauncherContainer[] = [];
    const arns = new Set<string>();
    for (const desiredStatus of ["RUNNING", "STOPPED"] as const) {
      let nextToken: string | undefined;
      const seen = new Set<string>();
      do {
        const response = await this.client.send(new ListTasksCommand({ cluster: this.config.cluster, desiredStatus, nextToken }), this.deadline());
        for (const arn of response.taskArns ?? []) arns.add(arn);
        nextToken = response.nextToken;
        if (nextToken && seen.has(nextToken)) throw new LauncherError(503, "ECS inventory pagination failed.");
        if (nextToken) seen.add(nextToken);
      } while (nextToken);
    }
    const ids = [...arns];
    // DescribeTasks accepts at most 100 IDs per request. Describe every page;
    // partial results or missing identities still fail the entire inventory.
    for (let offset = 0; offset < ids.length; offset += 100) {
      for (const task of await this.describeTasks(ids.slice(offset, offset + 100))) {
        // Actual STOPPED is terminal for Fargate; retained diagnostic tasks cannot
        // execute again. Pending/stopping/unknown tasks still require full identity.
        if (task.lastStatus !== "STOPPED") result.push(this.decode(task));
      }
    }
    return result;
  }
  async retire(id: string): Promise<void> {
    const before = await this.inspectTask(id);
    if (before.state === "exited") return;
    await this.client.send(new StopTaskCommand({ cluster: this.config.cluster, task: id, reason: "Dispatch immutable attempt retirement" }), this.deadline());
    const until = Date.now() + this.config.retirementTimeoutMs;
    while (Date.now() < until) {
      if ((await this.inspectTask(id)).state === "exited") return;
      await delay(1000);
    }
    throw new LauncherError(503, "Task termination remains unresolved; replacement is blocked.");
  }
  private decode(task: Task): LauncherContainer {
    const values = new Map((task.tags ?? []).map(tag => [tag.key, tag.value]));
    const value = (key: string) => text.parse(values.get(prefix + key));
    const installationId = value("installationId");
    // Dedicated worker cluster: an unexpected/untagged task blocks inventory rather
    // than becoming an invisible executor. Backend/launcher use a different cluster.
    if (installationId !== this.config.installationId || task.clusterArn !== this.config.cluster)
      throw new LauncherError(503, "Unexpected task in the dedicated worker cluster.");
    const address = task.attachments?.flatMap(item => item.type === "ElasticNetworkInterface" ? item.details ?? [] : [])
      .find(item => item.name === "privateIPv4Address")?.value;
    if (address !== undefined && !isIPv4(address)) throw new LauncherError(503, "Invalid task ENI address.");
    const state = task.lastStatus === "STOPPED" ? "exited" : task.lastStatus === "RUNNING" ? "running" : "unknown";
    return { id: task.taskArn!, installationId, attemptId: value("attemptId"), conversationId: value("conversationId"),
      storeId: value("storeId"), configurationRevision: value("configurationRevision"), name: value("name"), state,
      ...(address ? { address } : {}) };
  }
  private validateArn(id: string) {
    const prefix = this.config.cluster.replace(":cluster/", ":task/") + "/";
    if (!id.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(id.slice(prefix.length))) throw new LauncherError(503, "Task ARN outside the configured worker cluster.");
  }
  private deadline() { return { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) }; }
}
