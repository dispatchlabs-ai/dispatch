import { z } from "zod";
import { readRestrictedConfigurationFile } from "../storage/restricted-config-file.js";
import { DockerContainerDriver, type DockerDriverOptions, type DockerEngineTransport } from "./docker-driver.js";
import { LauncherError, type ContainerSpec } from "./launcher.js";

export type ExeDriverOptions = DockerDriverOptions & { vm: string; engineId: string; apiKeyFile: string };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const eventSchema = z.object({ stdout: z.string().optional(), stderr: z.string().optional(), exit_code: z.number().int().optional() });

/** Run the unchanged worker container on an operator-provisioned exe.dev VM.
 * Docker's immutable IDs/removal are the retirement fence, not mutable VM names.
 * The narrowly scoped exe API key stays in the launcher, outside every worker. */
export class ExeContainerDriver extends DockerContainerDriver {
  private constructor(options: DockerDriverOptions, environment: (spec: ContainerSpec) => Record<string, string>, transport: DockerEngineTransport,
    private readonly location: string) { super(options, environment, transport); }
  override get providerKey(): string { return `exe:${this.location}`; }
  static async open(options: ExeDriverOptions, workerEnvironment: (spec: ContainerSpec) => Record<string, string>): Promise<ExeContainerDriver> {
    const { vm, engineId, apiKeyFile, ...docker } = options;
    z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).parse(vm);
    z.string().uuid().parse(engineId);
    z.string().startsWith("/").parse(apiKeyFile);
    if (docker.environment?.DISPATCH_WORKER_PROTOCOL !== "remote-v1"
      || new URL(docker.environment.DISPATCH_BACKEND_INTERNAL_URL ?? "").protocol !== "https:")
      throw new Error("exe.dev workers require remote-v1 storage/commands over HTTPS.");
    if ((docker.requestTimeoutMs ?? 25_000) > 25_000 || (docker.stopGraceSeconds ?? 10) > 20)
      throw new Error("exe.dev command deadlines must fit its 30-second HTTPS API window.");
    const secret = await readRestrictedConfigurationFile(apiKeyFile, true);
    const token = secret.toString("utf8").trim();
    secret.fill(0);
    if (!token || /\s/.test(token)) throw new Error("Invalid exe.dev API credential file.");
    const transport: DockerEngineTransport = async ({ method, path, body, timeoutMs }) => {
      const arguments_ = ["sudo", "-n", "curl", "--silent", "--show-error", "--max-time", String(Math.max(1, Math.floor(timeoutMs / 1000) - 1)),
        "--unix-socket", docker.socketPath ?? "/var/run/docker.sock", "--request", method,
        "--write-out", "\\n%{http_code}", "--header", "Content-Type: application/json",
        ...(body === undefined ? [] : ["--data-binary", JSON.stringify(body)]), `http://localhost${path}`];
      try {
        // A VM can be renamed and its old name reused. Pin the Docker daemon too,
        // so another machine's empty inventory can never prove retirement.
        const guard = `test "$(sudo -n docker --host ${quote(`unix://${docker.socketPath ?? "/var/run/docker.sock"}`)} info --format '{{.ID}}')" = ${quote(engineId)} || exit 70`;
        const command = `ssh ${quote(vm)} ${quote(`${guard}; ${arguments_.map(quote).join(" ")}`)}`;
        if (Buffer.byteLength(command) > 64 * 1024) throw new Error("exe.dev command exceeds its request size limit.");
        const response = await fetch("https://exe.dev/exec", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain", Accept: "application/x-ndjson" },
          body: command,
        });
        if (!response.ok) throw new Error("exe.dev command failed.");
        const events = (await response.text()).trim().split("\n").filter(Boolean).map(line => eventSchema.parse(JSON.parse(line)));
        if (events.at(-1)?.exit_code !== 0) throw new Error("Remote Docker command failed.");
        const output = Buffer.concat(events.filter(event => event.stdout !== undefined)
          .map(event => Buffer.from(event.stdout!, "base64"))).toString("utf8");
        const end = output.lastIndexOf("\n");
        const status = Number(output.slice(end + 1));
        if (end < 0 || !Number.isInteger(status) || status < 100 || status > 599) throw new Error("Invalid remote Docker response.");
        return { status, body: end ? JSON.parse(output.slice(0, end)) : undefined };
      } catch {
        // Provider errors can contain the original command, including environment
        // secrets. Never attach their bodies/causes to logs or launcher status.
        throw new LauncherError(503, "exe.dev Docker transport failed; outcome may be uncertain.");
      }
    };
    return new ExeContainerDriver({ ...docker, requestTimeoutMs: docker.requestTimeoutMs ?? 25_000,
      stopGraceSeconds: docker.stopGraceSeconds ?? 10 }, workerEnvironment, transport, `${vm}:${engineId}`);
  }
}
