import { createHash } from "node:crypto";
import { request } from "node:http";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { launchRequestSchema, LauncherError, type ContainerDriver, type ContainerSpec, type LauncherContainer } from "./launcher.js";

const text = z.string().min(1).refine(value => !value.includes("\0"));
const containerId = z.string().regex(/^[a-f0-9]{64}$/);
const environmentSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().refine(value => !value.includes("\0")));
const configSchema = z.object({
  installationId: text.max(200),
  socketPath: text.refine(isAbsolute).default("/var/run/docker.sock"),
  apiVersion: z.string().regex(/^v1\.[0-9]+$/).default("v1.47"),
  image: z.string().regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@)?sha256:[a-f0-9]{64}$/),
  network: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).refine(value => !["host", "none", "bridge"].includes(value)),
  user: z.string().regex(/^[1-9][0-9]*(?::[1-9][0-9]*)?$/),
  command: z.array(text).min(1).optional(),
  entrypoint: z.array(text).min(1).optional(),
  workingDirectory: text.refine(isAbsolute).default("/workspace"),
  environment: environmentSchema.default({}),
  memoryBytes: z.number().int().safe().min(6 * 1024 * 1024),
  nanoCpus: z.number().int().safe().positive(),
  pidsLimit: z.number().int().safe().positive(),
  stopGraceSeconds: z.number().int().min(1).max(600).default(30),
  requestTimeoutMs: z.number().int().min(100).max(900_000).default(60_000),
}).strict();
export type DockerDriverOptions = z.input<typeof configSchema>;

const prefix = "ai.dispatch.worker.";
const labels = {
  installationId: `${prefix}installation`, attemptId: `${prefix}attempt`, conversationId: `${prefix}conversation`,
  storeId: `${prefix}store`, configurationRevision: `${prefix}revision`, name: `${prefix}name`,
  role: `${prefix}role`, policy: `${prefix}policy`,
};
const reservedEnvironment = {
  installationId: "DISPATCH_INSTALLATION_ID", attemptId: "DISPATCH_WORKER_ATTEMPT_ID",
  conversationId: "DISPATCH_CONVERSATION_ID", storeId: "DISPATCH_POSTGRES_STORE_ID",
  configurationRevision: "DISPATCH_WORKER_CONFIGURATION_REVISION",
} as const;
const inspectSchema = z.object({
  Id: containerId, Name: text, Image: text,
  Config: z.object({
    Labels: z.record(z.string(), z.string()), User: z.string(), Env: z.array(z.string()).nullable(),
    Cmd: z.array(z.string()).nullable(), Entrypoint: z.array(z.string()).nullable(), WorkingDir: z.string(),
    StopSignal: z.string().optional(), Volumes: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  State: z.object({ Status: z.string(), Running: z.boolean(), Paused: z.boolean(), Restarting: z.boolean(), Dead: z.boolean() }),
  HostConfig: z.object({
    Privileged: z.boolean(), NetworkMode: z.string(), RestartPolicy: z.object({ Name: z.string() }),
    AutoRemove: z.boolean(), CapAdd: z.array(z.string()).nullable(), CapDrop: z.array(z.string()).nullable(),
    SecurityOpt: z.array(z.string()).nullable(), Binds: z.array(z.string()).nullable(),
    Memory: z.number(), NanoCpus: z.number(), PidsLimit: z.number().nullable(), Init: z.boolean().optional(),
    PortBindings: z.record(z.string(), z.unknown()).nullable(), PublishAllPorts: z.boolean(),
    PidMode: z.string(), IpcMode: z.string(), Devices: z.array(z.unknown()).nullable(),
  }),
  Mounts: z.array(z.unknown()),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ NetworkID: z.string() })) }),
});
type Inspection = z.infer<typeof inspectSchema>;

/** Unix-socket Engine API v1.47. Operator configuration is fixed at construction, never supplied
 * by an HTTP lifecycle request. No host mounts, named volumes, devices, published ports, shared
 * host namespaces or Docker socket enter worker containers. Writable container layers are disposable.
 * Images must already be present; this driver never pulls mutable tags or runs shell commands.
 */
export class DockerContainerDriver implements ContainerDriver {
  private readonly config: z.output<typeof configSchema>;
  private readonly policy: string;
  private imageId?: string;

  constructor(options: DockerDriverOptions, private readonly workerEnvironment: (spec: ContainerSpec) => Record<string, string> = () => ({})) {
    this.config = configSchema.parse(options);
    if (this.config.requestTimeoutMs <= this.config.stopGraceSeconds * 1000)
      throw new Error("Docker request timeout must exceed the graceful-stop interval.");
    if (Object.values(reservedEnvironment).some(key => key in this.config.environment))
      throw new Error("Operator environment cannot override worker identity variables.");
    // Nonsecret policy identity. Environment VALUES stay out of labels, errors and status.
    const { environment, socketPath: _socket, apiVersion: _api, requestTimeoutMs: _timeout, ...policy } = this.config;
    this.policy = createHash("sha256").update(JSON.stringify({ ...policy, environmentKeys: Object.keys(environment).sort() })).digest("hex");
  }

  async list(installationId: string): Promise<LauncherContainer[]> {
    this.assertInstallation(installationId);
    const filter = JSON.stringify({ label: [`${labels.installationId}=${installationId}`] });
    const response = await this.call("GET", `/containers/json?all=true&filters=${encodeURIComponent(filter)}`, [200]);
    const inventory = z.array(z.object({ Id: containerId })).parse(response.body);
    const result: LauncherContainer[] = [];
    for (const row of inventory) {
      const inspected = await this.inspect(row.Id);
      if (inspected) result.push(this.describe(inspected)); // A concurrent confirmed removal is safe to omit.
    }
    return result;
  }

  async create(spec: ContainerSpec): Promise<void> {
    const parsed = launchRequestSchema.extend({ installationId: text.max(200), name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).max(200) }).strict().parse(spec);
    this.assertInstallation(parsed.installationId);
    const imageId = await this.resolveImage();
    const network = z.object({ Id: containerId, Driver: z.literal("bridge"), Scope: z.literal("local"), Name: text }).parse(
      (await this.call("GET", `/networks/${encodeURIComponent(this.config.network)}`, [200])).body,
    );
    if (["host", "none", "bridge"].includes(network.Name)) throw new Error("Workers require an operator-owned private bridge network.");
    const workerLabels: Record<string, string> = { [labels.role]: "conversation", [labels.policy]: this.policy };
    for (const key of ["installationId", "attemptId", "conversationId", "storeId", "configurationRevision", "name"] as const) workerLabels[labels[key]] = parsed[key];
    const environment = this.environment(parsed);
    for (const key of Object.keys(reservedEnvironment) as Array<keyof typeof reservedEnvironment>) environment[reservedEnvironment[key]] = parsed[key];
    const body = {
      Image: imageId, User: this.config.user, WorkingDir: this.config.workingDirectory,
      ...(this.config.command ? { Cmd: this.config.command } : {}),
      ...(this.config.entrypoint ? { Entrypoint: this.config.entrypoint } : {}),
      Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`), Labels: workerLabels,
      StopSignal: "SIGTERM", StopTimeout: this.config.stopGraceSeconds,
      AttachStdin: false, AttachStdout: false, AttachStderr: false, OpenStdin: false, Tty: false,
      HostConfig: {
        NetworkMode: network.Id, RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, AutoRemove: false,
        Init: true, Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
        Memory: this.config.memoryBytes, NanoCpus: this.config.nanoCpus, PidsLimit: this.config.pidsLimit,
        PublishAllPorts: false, IpcMode: "private", LogConfig: { Type: "local", Config: { "max-size": "10m", "max-file": "2" } },
      },
      NetworkingConfig: { EndpointsConfig: { [network.Id]: {} } },
    };
    const created = await this.call("POST", `/containers/create?name=${encodeURIComponent(parsed.name)}`, [201, 409], body);
    // A name conflict can be a lost create response, never permission to adopt changed inputs.
    const idOrName = created.status === 201 ? z.object({ Id: containerId }).parse(created.body).Id : parsed.name;
    const inspected = await this.inspect(idOrName);
    if (!inspected) throw new LauncherError(503, "Docker creation is unresolved.");
    const actual = this.describe(inspected);
    if ((["installationId", "attemptId", "conversationId", "storeId", "configurationRevision", "name"] as const).some(key => actual[key] !== parsed[key]))
      throw new LauncherError(409, "Existing Docker container has different launch identity.");
    await this.checkPolicy(inspected);
    if (created.status === 201 && actual.state !== "created") throw new LauncherError(503, "Docker create did not leave a stopped container.");
  }

  async start(id: string): Promise<void> {
    containerId.parse(id); // Names and abbreviated IDs are never accepted for effects.
    const inspected = await this.inspect(id);
    if (!inspected) throw new LauncherError(409, "Worker container no longer exists.");
    const actual = this.describe(inspected);
    await this.checkPolicy(inspected);
    if (actual.state === "running") return;
    if (actual.state !== "created") throw new LauncherError(409, "Only a never-started worker may be started.");
    // Launcher journals this immutable ID before calling start and never resends an uncertain start.
    await this.call("POST", `/containers/${id}/start`, [204, 304]);
  }

  async retire(id: string): Promise<void> {
    containerId.parse(id);
    const inspected = await this.inspect(id);
    if (!inspected) return;
    this.describe(inspected); // Installation/role identity, not current policy: old versions must be drainable.
    await this.call("POST", `/containers/${id}/update`, [200, 404], { RestartPolicy: { Name: "no", MaximumRetryCount: 0 } });
    await this.call("POST", `/containers/${id}/stop?t=${this.config.stopGraceSeconds}`, [204, 304, 404, 409]);
    // Stop alone is reversible. Removal kills paused/stuck workers too and defeats a delayed start.
    await this.call("DELETE", `/containers/${id}?force=true&v=true`, [204, 404]);
    if (await this.inspect(id)) throw new LauncherError(503, "Docker worker removal is unresolved.");
  }

  private async resolveImage(): Promise<string> {
    if (this.imageId) return this.imageId;
    const image = z.object({
      Id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      Config: z.object({ Volumes: z.record(z.string(), z.unknown()).nullable().optional() }),
    }).parse((await this.call("GET", `/images/${encodeURIComponent(this.config.image)}/json`, [200])).body);
    if (Object.keys(image.Config.Volumes ?? {}).length) throw new Error("Worker images cannot declare persistent or anonymous volumes.");
    this.imageId = image.Id;
    return image.Id;
  }

  private async inspect(idOrName: string): Promise<Inspection | undefined> {
    const response = await this.call("GET", `/containers/${encodeURIComponent(idOrName)}/json`, [200, 404]);
    return response.status === 404 ? undefined : inspectSchema.parse(response.body);
  }

  private describe(inspected: Inspection): LauncherContainer {
    const values = inspected.Config.Labels;
    this.assertInstallation(values[labels.installationId]);
    if (values[labels.role] !== "conversation") throw new LauncherError(409, "Docker container is not a managed conversation worker.");
    const identity = launchRequestSchema.parse({
      attemptId: values[labels.attemptId], conversationId: values[labels.conversationId],
      storeId: values[labels.storeId], configurationRevision: values[labels.configurationRevision],
    });
    const name = inspected.Name.replace(/^\//, "");
    if (values[labels.name] !== name) throw new LauncherError(409, "Docker worker name/label mismatch.");
    const state = inspected.State;
    const observed = state.Paused || state.Restarting || state.Dead ? "unknown"
      : state.Running && state.Status === "running" ? "running"
      : !state.Running && state.Status === "created" ? "created"
      : !state.Running && state.Status === "exited" ? "exited" : "unknown";
    return { ...identity, id: inspected.Id, name, installationId: this.config.installationId, state: observed };
  }

  private async checkPolicy(inspected: Inspection): Promise<void> {
    const host = inspected.HostConfig;
    const config = inspected.Config;
    const networks = Object.values(inspected.NetworkSettings.Networks);
    const network = z.object({ Id: containerId, Name: text }).parse((await this.call("GET", `/networks/${encodeURIComponent(this.config.network)}`, [200])).body);
    const env = new Map((config.Env ?? []).map(item => { const equal = item.indexOf("="); return [item.slice(0, equal), item.slice(equal + 1)]; }));
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const identity = this.describe(inspected);
    if (config.Labels[labels.policy] !== this.policy || inspected.Image !== await this.resolveImage()
      || config.User !== this.config.user || config.WorkingDir !== this.config.workingDirectory || config.StopSignal !== "SIGTERM"
      || (this.config.command && !same(config.Cmd, this.config.command)) || (this.config.entrypoint && !same(config.Entrypoint, this.config.entrypoint))
      || Object.entries(this.environment(identity)).some(([key, value]) => env.get(key) !== value)
      || (Object.keys(reservedEnvironment) as Array<keyof typeof reservedEnvironment>).some(key => env.get(reservedEnvironment[key]) !== identity[key])
      || host.Privileged || host.AutoRemove || host.RestartPolicy.Name !== "no" || host.Init !== true
      || (host.CapAdd?.length ?? 0) !== 0 || !same(host.CapDrop, ["ALL"])
      || !(host.SecurityOpt ?? []).some(value => value === "no-new-privileges:true" || value === "no-new-privileges")
      || (host.Binds?.length ?? 0) !== 0 || inspected.Mounts.length !== 0 || Object.keys(config.Volumes ?? {}).length !== 0
      || host.Memory !== this.config.memoryBytes || host.NanoCpus !== this.config.nanoCpus || host.PidsLimit !== this.config.pidsLimit
      || host.PublishAllPorts || Object.keys(host.PortBindings ?? {}).length !== 0 || host.PidMode !== "" || host.IpcMode !== "private"
      || (host.Devices?.length ?? 0) !== 0 || host.NetworkMode !== network.Id || networks.length !== 1
      || !Object.keys(inspected.NetworkSettings.Networks).every(key => key === network.Id || key === network.Name)
      // Docker can defer endpoint attachment until start; HostConfig still pins the immutable network.
      || (networks[0].NetworkID !== network.Id && !(identity.state === "created" && networks[0].NetworkID === "")))
      throw new LauncherError(409, "Docker worker does not match the pinned operator policy.");
  }

  private environment(spec: ContainerSpec) {
    const dynamic = environmentSchema.parse(this.workerEnvironment(spec));
    if (Object.keys(dynamic).some(key => key in this.config.environment || Object.values(reservedEnvironment).includes(key as typeof reservedEnvironment[keyof typeof reservedEnvironment])))
      throw new Error("Derived worker environment collides with operator or identity settings.");
    return { ...this.config.environment, ...dynamic };
  }

  private assertInstallation(installationId: string) {
    if (installationId !== this.config.installationId) throw new LauncherError(409, "Docker driver installation mismatch.");
  }

  private call(method: string, path: string, accepted: number[], body?: unknown): Promise<{ status: number; body: unknown }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.config.socketPath, method, path: `/${this.config.apiVersion}${path}`, agent: false,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
      });
      // Absolute deadline, including connect and response body; an idle socket timeout alone is insufficient.
      const timer = setTimeout(() => req.destroy(new Error("Docker request deadline exceeded; outcome may be uncertain.")), this.config.requestTimeoutMs);
      req.on("error", () => { clearTimeout(timer); reject(new LauncherError(503, "Docker transport failed; outcome may be uncertain.")); });
      req.on("response", response => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) req.destroy(new Error("Docker response exceeded transport bound."));
          else chunks.push(chunk);
        });
        response.on("error", () => { clearTimeout(timer); reject(new LauncherError(503, "Docker response interrupted; outcome may be uncertain.")); });
        response.on("end", () => {
          clearTimeout(timer);
          const status = response.statusCode ?? 0;
          if (!accepted.includes(status)) { reject(new LauncherError(503, `Docker Engine returned HTTP ${status}; outcome may be uncertain.`)); return; }
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status, body: text ? JSON.parse(text) : undefined });
          } catch { reject(new LauncherError(503, "Docker returned invalid JSON; outcome may be uncertain.")); }
        });
      });
      req.end(payload);
    });
  }
}
