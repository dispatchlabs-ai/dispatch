import { dispatchCommand, ServiceError, type ServiceOperations, type ServiceMetadata, type ServiceExpectation, type ServiceCommand } from "./protocol.js";
import { serviceRequest } from "./client.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, lstat, unlink, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { defaultAgent } from "./definition.js";
import { createRunner } from "./index.js";
import { run, type Adapter } from "./run.js";
import type { ModelChoice } from "./gateway.js";
import { connectHostModels, type HostModelsConfig } from "./host-models.js";
import { serviceSettings, type ServicePolicy } from "./settings.js";
import { privateStateDirectory } from "./private-state.js";

export type ServiceConfig = ServicePolicy & HostModelsConfig & {
  root: string;
  stateRoot: string;
  cwd: string;
  socket?: string;
  /** Put TLS in front of a network listener; its private token authorizes this installation. */
  http?: { host?: string; port: number; tokenFile: string };
  namespace?: string;
  names?: string[];
  updateDefinitions?: boolean | "when-idle";
  /** Disable factory schedules without disabling recovery of admitted work. */
  schedules?: boolean;
  definitionResources?: boolean;
  adapters?: { module: string; optionsFile: string }[];
};
export type ServiceListener = string | { host?: string; port: number; authorize(request: IncomingMessage): boolean | Promise<boolean> };

async function writeSnapshot(response: ServerResponse, snapshot: unknown) {
  if (response.destroyed) return;
  if (response.write(JSON.stringify({ snapshot }) + "\n")) return;
  await new Promise<void>(resolve => {
    const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
    response.once("drain", done); response.once("close", done);
  });
}
export type ServiceAdapterContext = {
  cwd: string;
  connectModels: (models: ReturnType<typeof createModels>) => Promise<ModelChoice[]>;
};
/** Bind a company-owned ChatService without creating another native owner.
 * Closing the listener disconnects clients only; the caller still owns service.close(). */
export async function serveService(owner: ServiceOperations | (() => ServiceOperations | undefined), listener: ServiceListener, adapters: Awaited<ReturnType<typeof run>>["adapters"] = [], metadata: ServiceMetadata = {},
  options: { /** Observes each dispatched command and its completion; reads included. */ onCommand?: (method: ServiceCommand["method"], phase: "start" | "end") => void } = {}) {
  const socket = typeof listener === "string" ? listener : undefined;
  if (socket) {
    if (resolve(socket) !== socket) throw new Error("socket must be an absolute path.");
    const socketDirectory = dirname(socket);
    await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(socketDirectory);
    if (!directory.isDirectory() || (directory.mode & 0o077) || directory.uid !== process.getuid?.()) throw new Error("The service socket needs an owner-only directory.");
  } else if (typeof listener === "string" || typeof listener.authorize !== "function") {
    throw new Error("A network listener needs an authorization binding.");
  }
  const server = createServer(async (incoming, response) => {
    response.setHeader("content-type", "application/json");
    if (incoming.method !== "POST" || !["/v1/commands", "/v1/watch"].includes(incoming.url ?? "")) {
      response.writeHead(404).end(JSON.stringify({ error: "Use the agent client API." })); return;
    }
    const service = typeof owner === "function" ? owner() : owner;
    if (!service) {
      response.writeHead(503).end(JSON.stringify({ error: "Service is starting." })); return;
    }
    try {
      if (typeof listener !== "string" && !await listener.authorize(incoming)) {
        response.writeHead(401).end(JSON.stringify({ error: "Unauthorized." })); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const command = payload.command ?? payload;
      const expected: ServiceExpectation | undefined = payload.expected;
      // Compare in this same request before dispatch. A separate info preflight
      // cannot bind a Unix pathname that another installation may replace.
      if (expected && ((expected.stateRoot !== undefined && expected.stateRoot !== metadata.stateRoot) ||
          (expected.identity !== undefined && expected.identity !== metadata.identity)))
        throw new ServiceError("The service owner identity changed. Reconnect using the intended installation; no command was dispatched.", 409);
      if (incoming.url === "/v1/watch") {
        if (typeof payload.id !== "string" || !payload.id) throw new Error("A conversation ID is required.");
        let watch: Awaited<ReturnType<ServiceOperations["watch"]>> | undefined;
        let disconnected = false;
        response.setHeader("content-type", "application/x-ndjson");
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-accel-buffering", "no");
        response.once("close", () => { disconnected = true; void watch?.stop().catch(() => {}); });
        watch = await service.watch(payload.id, snapshot => writeSnapshot(response, snapshot));
        if (disconnected) await watch.stop();
        else void watch.closed.then(() => response.end(), error => {
          if (!response.destroyed) response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Observation failed." }) + "\n");
        });
        return;
      }
      let result;
      if (command.method === "info") result = metadata;
      else if (command.method === "status") {
        if (!service.activity) throw new ServiceError("This service does not expose activity.", 409);
        const activity = await service.activity();
        const adapterBusy = (await Promise.all(adapters.map(adapter => adapter.busy?.() ?? false))).some(Boolean);
        result = { ...activity, adapterBusy, busy: activity.busy || adapterBusy };
      } else {
        const observation = new AbortController();
        const disconnected = () => observation.abort();
        response.once("close", disconnected);
        options.onCommand?.(command.method, "start");
        try { result = await dispatchCommand(service, command, observation.signal); }
        finally { response.off("close", disconnected); options.onCommand?.(command.method, "end"); }
      }
      response.end(JSON.stringify({ result }));
    } catch (error) {
      const status = (error as { status?: number }).status === 409 ? 409 : 400;
      const message = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      if (response.headersSent) response.end(message + "\n");
      else response.writeHead(status).end(message);
    }
  });
  // Large attachments and slow local uploads have no application size/time ceiling.
  server.requestTimeout = 0;
  let listening = false;
  try {
    const exists = socket && await lstat(socket).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (socket && exists) {
      if (!exists.isSocket()) throw new Error("The service socket path is not a socket.");
      await serviceRequest(socket, { method: "agents" }).then(() => {
        throw new Error("A service is already listening on this socket.");
      }, async error => {
        if (error.code !== "ECONNREFUSED") throw error;
        await unlink(socket);
      });
    }
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      const ready = () => { server.off("error", reject); accept(); };
      if (typeof listener === "string") server.listen(listener, ready);
      else server.listen(listener.port, listener.host ?? "127.0.0.1", ready);
    });
    listening = true;
    if (socket) await chmod(socket, 0o600);
  } catch (error) { if (listening) server.close(); throw error; }
  let closing: Promise<void> | undefined;
  return { address: server.address(), close: () => closing ??= new Promise<void>((accept, reject) => {
    server.close(error => error ? reject(error) : accept());
    server.closeAllConnections();
  }) };
}

/** One supervised service owns native sessions; local clients never own its lifetime. */
export async function startService(config: ServiceConfig) {
  const settings = serviceSettings(config);
  for (const field of ["root", "stateRoot", "cwd"] as const) {
    if (!config[field] || resolve(config[field]) !== config[field]) throw new Error(`${field} must be an absolute path.`);
  }
  if (!config.socket && !config.http) throw new Error("Configure a socket or HTTP listener.");
  const modelConnections: Awaited<ReturnType<typeof connectHostModels>>[] = [];
  const connectModels: ServiceAdapterContext["connectModels"] = async models => {
    const connection = await connectHostModels(config, models);
    modelConnections.push(connection);
    return connection.choices;
  };
  const closeModels = async () => {
    const results = await Promise.allSettled(modelConnections.map(connection => connection.close()));
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "Could not close service model providers.");
  };
  const preparedAdapters: Awaited<ReturnType<typeof run>>["adapters"] = [];
  let runtime: Awaited<ReturnType<typeof run>> | undefined;
  const listeners: Awaited<ReturnType<typeof serveService>>[] = [];
  try {
    const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
    await connectModels(models);
    const adapters: Adapter[] = [];
    for (const adapter of config.adapters ?? []) {
      const modulePath = adapter.module.startsWith(".") || adapter.module.startsWith("/")
        ? pathToFileURL(resolve(config.root, adapter.module)).href : adapter.module;
      const module = await import(modulePath);
      const options = JSON.parse(await readFile(adapter.optionsFile, "utf8"));
      adapters.push(await module.createAdapter(options, { cwd: config.cwd, connectModels } satisfies ServiceAdapterContext));
    }
    await privateStateDirectory(config.stateRoot);
    const metadata: ServiceMetadata = { stateRoot: await realpath(config.stateRoot), defaultAgent: await defaultAgent(config.root).catch(() => undefined) };
    if (config.socket) listeners.push(await serveService(() => runtime?.service, config.socket, preparedAdapters, metadata));
    if (config.http) {
      const secret = (await readFile(config.http.tokenFile, "utf8")).trim();
      if (!secret) throw new Error("The service token file is empty.");
      const digest = (value: string) => createHash("sha256").update(value).digest();
      const expected = digest(`Bearer ${secret}`);
      listeners.push(await serveService(() => runtime?.service, { ...config.http,
        authorize: request => timingSafeEqual(digest(request.headers.authorization ?? ""), expected),
      }, preparedAdapters, metadata));
    }
    const runner = createRunner({ namespace: config.namespace });
    runtime = await run({ ...config, runner, models, adapters, settings });
    preparedAdapters.push(...runtime.adapters);
  } catch (error) {
    try { await Promise.all(listeners.map(listener => listener.close())); } finally {
      try { await runtime?.close(); } finally { await closeModels(); }
    }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { ...runtime, close: () => closing ??= (async () => {
    try { await Promise.all(listeners.map(listener => listener.close())); } finally {
      try { await runtime!.close(); } finally { await closeModels(); }
    }
  })() };
}

export { serviceRequest, connectClient } from "./client.js";
export type * from "./protocol.js";
export { ServiceError } from "./protocol.js";
export { connectInTerminal } from "./service-terminal.js";
export type { ServiceTerminalOptions } from "./service-terminal.js";
