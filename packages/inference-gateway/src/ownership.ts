import { randomUUID } from "node:crypto";
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { DescribeTasksCommand, ECSClient, StopTaskCommand, type Task } from "@aws-sdk/client-ecs";
import { HttpError } from "./config.js";

type Owner = { taskArn: string; generation: string; heartbeatAt: number; phase: string; stoppedTaskArn?: string };
type Target = { local: true } | { local: false; address: string };
const key = { id: { S: "provider-owner" } };
const unavailable = () => new HttpError(503, "provider_owner_unavailable");

/** Ownership ends only after ECS confirms STOPPED, never merely when a heartbeat expires. */
export class EcsOwnership {
  private readonly dynamo: DynamoDBClient;
  private readonly ecs: ECSClient;
  private readonly generation = randomUUID();
  private taskArn = "";
  private draining = false;
  private timer?: NodeJS.Timeout;
  private target?: Target;
  private observedAt = 0;

  constructor(private readonly options: { region: string; clusterArn: string; service: string; table: string }) {
    const settings = { region: options.region, maxAttempts: 2 };
    this.dynamo = new DynamoDBClient(settings);
    this.ecs = new ECSClient(settings);
  }

  private async owner(): Promise<Owner | undefined> {
    const result = await this.dynamo.send(new GetItemCommand({ TableName: this.options.table, Key: key, ConsistentRead: true }), { abortSignal: AbortSignal.timeout(5000) });
    if (!result.Item) return undefined;
    const item = result.Item;
    if (!item.taskArn?.S || !item.generation?.S || !item.heartbeatAt?.N || !item.phase?.S) throw unavailable();
    return { taskArn: item.taskArn.S, generation: item.generation.S, heartbeatAt: Number(item.heartbeatAt.N), phase: item.phase.S, stoppedTaskArn: item.stoppedTaskArn?.S };
  }

  private async task(taskArn: string): Promise<Task | undefined> {
    const prefix = this.options.clusterArn.replace(":cluster/", ":task/") + "/";
    if (!taskArn.startsWith(prefix)) throw unavailable();
    const result = await this.ecs.send(new DescribeTasksCommand({ cluster: this.options.clusterArn, tasks: [taskArn] }), { abortSignal: AbortSignal.timeout(5000) });
    const task = result.tasks?.find((item) => item.taskArn === taskArn);
    if (task && (task.clusterArn !== this.options.clusterArn || task.group !== `service:${this.options.service}`)) throw unavailable();
    return task;
  }

  private async claim(previous?: Owner) {
    const values: Record<string, AttributeValue> = previous ? { ":task": { S: previous.taskArn }, ":generation": { S: previous.generation } } : {};
    try {
      await this.dynamo.send(new PutItemCommand({
        TableName: this.options.table,
        Item: { ...key, taskArn: { S: this.taskArn }, generation: { S: this.generation }, heartbeatAt: { N: String(Date.now()) }, phase: { S: "active" } },
        ConditionExpression: previous ? "taskArn = :task AND generation = :generation" : "attribute_not_exists(id)",
        ...(previous ? { ExpressionAttributeValues: values } : {}),
      }), { abortSignal: AbortSignal.timeout(5000) });
      process.stdout.write(`${JSON.stringify({ event: "provider_owner_acquired", taskArn: this.taskArn })}\n`);
    } catch (error) {
      // A timed-out successful write is resolved by the next strongly consistent read.
      if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
    }
  }

  private async heartbeat(phase: string) {
    await this.dynamo.send(new UpdateItemCommand({
      TableName: this.options.table, Key: key,
      UpdateExpression: "SET heartbeatAt = :now, phase = :phase",
      ConditionExpression: "taskArn = :task AND generation = :generation",
      ExpressionAttributeValues: { ":now": { N: String(Date.now()) }, ":phase": { S: phase }, ":task": { S: this.taskArn }, ":generation": { S: this.generation } },
    }), { abortSignal: AbortSignal.timeout(5000) });
  }

  private async tick() {
    const self = await this.task(this.taskArn);
    if (!self) throw unavailable();
    if (self.desiredStatus === "STOPPED" || ["DEACTIVATING", "STOPPING", "DEPROVISIONING", "STOPPED"].includes(self.lastStatus ?? "")) {
      await this.beginDrain();
      return;
    }
    if (self.desiredStatus !== "RUNNING" || self.lastStatus !== "RUNNING") return;
    if (this.draining) return;
    const owner = await this.owner();
    if (!owner) { await this.claim(); return; }
    if (owner.taskArn === this.taskArn) {
      if (owner.generation !== this.generation || owner.phase !== "active") throw unavailable();
      await this.heartbeat("active");
      this.target = { local: true };
      this.observedAt = Date.now();
      return;
    }
    const previous = await this.task(owner.taskArn);
    if (previous?.lastStatus === "STOPPED" || owner.stoppedTaskArn === owner.taskArn) {
      await this.claim(owner);
      this.target = undefined;
      return;
    }
    if (Date.now() - owner.heartbeatAt > 30_000) {
      this.target = undefined;
      // Expiry only authorizes fencing the old process. It never authorizes a second writer.
      if (previous) await this.ecs.send(new StopTaskCommand({ cluster: this.options.clusterArn, task: owner.taskArn, reason: "Provider owner heartbeat expired" }), { abortSignal: AbortSignal.timeout(5000) });
      return;
    }
    if (owner.phase !== "active" || previous?.lastStatus !== "RUNNING" || previous.desiredStatus !== "RUNNING") { this.target = undefined; return; }
    const address = previous.attachments?.flatMap((attachment) => attachment.details ?? []).find((detail) => detail.name === "privateIPv4Address")?.value;
    if (!address || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw unavailable();
    this.target = { local: false, address };
    this.observedAt = Date.now();
  }

  async start() {
    const metadata = process.env.ECS_CONTAINER_METADATA_URI_V4;
    if (!metadata || !metadata.startsWith("http://169.254.170.2/")) throw new Error("ECS task metadata is required");
    const response = await fetch(`${metadata}/task`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("Cannot read ECS task metadata");
    const data = await response.json() as { TaskARN?: string };
    if (!data.TaskARN) throw new Error("Missing ECS task identity");
    this.taskArn = data.TaskARN;
    const poll = async () => {
      try { await this.tick(); } catch { this.target = undefined; process.stderr.write('{"event":"provider_coordination_unavailable"}\n'); }
      if (!this.draining) this.timer = setTimeout(poll, 3000);
    };
    await poll();
  }

  route(): Target {
    if (this.draining || !this.target || Date.now() - this.observedAt > 15_000) throw unavailable();
    return this.target;
  }

  async assertOwner() {
    const owner = await this.owner();
    if (owner?.taskArn !== this.taskArn || owner.generation !== this.generation) throw unavailable();
  }

  async beginDrain() {
    this.draining = true;
    this.target = undefined;
    clearTimeout(this.timer);
    const owner = await this.owner();
    if (owner?.taskArn === this.taskArn && owner.generation === this.generation) await this.heartbeat("draining");
  }

  close() { clearTimeout(this.timer); this.dynamo.destroy(); this.ecs.destroy(); }
}
