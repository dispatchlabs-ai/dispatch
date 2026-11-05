#!/usr/bin/env node
/** Fixed native entrypoint. Only the immutable application chooses its adapter. */
import { createServer, request } from "node:http";
import { chmod, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { WorkspaceEnvironment, type WorkspaceTransport } from "@dispatch/runner";
import { refreshGatewayModels } from "@dispatch/runner/gateway";
import { createRemoteStorage } from "./storage.js";
import type { FleetAssignment, FleetRunContext, FleetRunModule } from "./types.js";

const runtimeRoot = process.env.RUNTIME_DIRECTORY;
const directory = process.env.STATE_DIRECTORY;
const credentials = process.env.CREDENTIALS_DIRECTORY;
if (!runtimeRoot || !directory || !credentials) throw new Error("Start through the isolated fleet service.");
const assignment: FleetAssignment = JSON.parse(await readFile(join(credentials, "assignment"), "utf8"));
const manifest = JSON.parse(await readFile(assignment.release.manifest, "utf8"));
const descriptor = manifest.fleet;
const root = await realpath(manifest.definitionsRoot);
const modulePath = await realpath(resolve(root, descriptor.module));
if (!modulePath.startsWith(root + "/") || descriptor.format !== 1 || !assignment.fleet) throw new Error("Invalid pinned run adapter.");
const socketPath = join(runtimeRoot, "relay.sock");

function relay<T>(path: string, body?: unknown, options: { method?: "GET" | "POST"; signal?: AbortSignal } = {},
  onFrame?: (frame: any) => void): Promise<T> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((accept, reject) => {
    const outgoing = request({ socketPath, path, method: options.method ?? "POST", signal: options.signal,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        text += chunk;
        if (!onFrame || response.statusCode !== 200) return;
        let newline: number;
        while ((newline = text.indexOf("\n")) >= 0) {
          const line = text.slice(0, newline); text = text.slice(newline + 1);
          try { onFrame(JSON.parse(line)); } catch (error) { outgoing.destroy(); reject(error); }
        }
      });
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Relay interrupted; reconcile retained state before repeating an effect.")));
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error(text || `Relay HTTP ${response.statusCode}`);
          if (onFrame) { if (text.trim()) onFrame(JSON.parse(text)); accept(undefined as T); }
          else accept(text ? JSON.parse(text) : undefined);
        } catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject); outgoing.end(payload);
  });
}

const workspace: WorkspaceTransport = {
  run: assignment.run,
  async request<T>(value: Record<string, unknown>, signal?: AbortSignal,
    output?: Parameters<WorkspaceTransport["request"]>[2], context?: Parameters<WorkspaceTransport["request"]>[3]): Promise<T> {
    if (!value.stream) return relay<T>("/workspace", value, { signal });
    let result: T | undefined;
    await relay("/workspace", value, { signal }, frame => {
      if (frame.error) throw new Error(frame.error.message);
      if (frame.result !== undefined) result = frame.result;
      if (typeof frame.output === "string") output?.(frame.output, context!, { stream: frame.stream });
    });
    if (result === undefined) throw new Error("Workspace stream ended without a result; inspect before retrying.");
    return result;
  },
};

// Pi's HTTP providers use a loopback adapter. Its random token is local only;
// the root coordinator owns every upstream model credential and authorization.
const localToken = randomBytes(32).toString("hex");
const modelProxy = createServer(async (incoming, outgoing) => {
  if (incoming.headers.authorization !== `Bearer ${localToken}` || !incoming.url?.startsWith("/v1/")) {
    outgoing.writeHead(403).end(); return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const forwarded = request({ socketPath, path: incoming.url, method: incoming.method,
      headers: { "content-type": "application/json", "content-length": body.length } }, response => {
      outgoing.writeHead(response.statusCode ?? 502, { "content-type": response.headers["content-type"] ?? "application/json" });
      response.on("error", () => outgoing.destroy()); response.pipe(outgoing);
    });
    forwarded.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.on("close", () => forwarded.destroy()); forwarded.end(body);
  } catch { if (!outgoing.headersSent) outgoing.writeHead(400); outgoing.end(); }
});
await new Promise<void>(done => modelProxy.listen(0, "127.0.0.1", done));
const modelOrigin = `http://127.0.0.1:${(modelProxy.address() as { port: number }).port}`;
const environments = new Set<WorkspaceEnvironment>();
const context: FleetRunContext = {
  assignment, root, namespace: descriptor.namespace, roles: descriptor.roles,
  stateRoot: join(directory, "native"), runtimeRoot,
  async storage(agent) {
    const role = typeof agent === "string" ? agent : agent.id;
    if (!descriptor.roles.includes(role)) throw new Error("Store is outside this immutable run profile.");
    return createRemoteStorage(role, socketPath);
  },
  workspace,
  env(target) { const env = new WorkspaceEnvironment(workspace, target.cwd ?? "/workspace"); environments.add(env); return env; },
  relay,
  async emit(event) { await relay("/events", event); },
  async connectModels(aliases) {
    const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
    const choices = await refreshGatewayModels(modelOrigin, models, localToken, aliases);
    return { models, choices };
  },
};
const adapter = await import(pathToFileURL(modulePath).href) as FleetRunModule;
const run = await adapter.createRun(context);
const controllers = new Set<AbortController>();
const server = createServer(async (incoming, outgoing) => {
  const controller = new AbortController(); controllers.add(controller);
  outgoing.once("close", () => { if (!outgoing.writableEnded) controller.abort(); });
  try {
    if (incoming.method !== "POST" || incoming.url !== "/commands") throw new Error("Unknown native endpoint.");
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const command = JSON.parse(Buffer.concat(chunks).toString());
    const result = command.tool === "status" ? await run.status() : await run.command(command, controller.signal);
    outgoing.end(JSON.stringify({ ok: true, result }));
  } catch (error) {
    outgoing.writeHead(409).end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  } finally { controllers.delete(controller); }
});
const socket = join(runtimeRoot, "worker.sock");
await rm(socket, { force: true });
await new Promise<void>(done => server.listen(socket, done));
await chmod(socket, 0o600);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  if (closing) return; closing = true;
  server.close(); for (const controller of controllers) controller.abort();
  void (async () => {
    try { await run.close(); for (const env of environments) await env.cleanup(); }
    finally { modelProxy.closeAllConnections(); modelProxy.close(); process.exit(0); }
  })();
});
