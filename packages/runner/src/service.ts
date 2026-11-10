import { createServer, request } from "node:http";
import { chmod, mkdir, readFile, lstat, unlink, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { defaultAgent } from "./definition.js";
import { createRunner } from "./index.js";
import { run, type Adapter } from "./run.js";
import type { ModelChoice } from "./gateway.js";
import { connectHostModels, type HostModelsConfig } from "./host-models.js";
import type { ChatService, Chat, ChatSnapshot } from "./chat.js";
import type { AttachmentFile } from "./chat-content.js";
import type { InstanceMessage } from "./messages.js";
import { serviceSettings, type ServicePolicy } from "./settings.js";

export type ServiceConfig = ServicePolicy & HostModelsConfig & {
  root: string;
  stateRoot: string;
  cwd: string;
  socket: string;
  namespace?: string;
  names?: string[];
  updateDefinitions?: boolean;
  /** Disable factory schedules without disabling recovery of admitted work. */
  schedules?: boolean;
  definitionResources?: boolean;
  adapters?: { module: string; optionsFile: string }[];
};
export type ServiceAdapterContext = {
  cwd: string;
  connectModels: (models: ReturnType<typeof createModels>) => Promise<ModelChoice[]>;
};
export type ServiceOperations = Pick<ChatService, "list" | "create" | "snapshot" | "submit" | "stop" | "artifact"> &
  Partial<Pick<ChatService, "find" | "activity" | "schedules" | "compact" | "receipt" | "message" | "messageStatus" | "waitForIdle">> & {
    agents: { id: string; description: string; model?: import("./definition.js").LoadedAgent["model"] }[];
  };
export type ServiceMetadata = { stateRoot?: string; defaultAgent?: string;
  /** Stable trusted installation identity for opaque/custom facades without one native root. */
  identity?: string;
};
export type ServiceExpectation = { stateRoot?: string; identity?: string };
export type ServiceCommand =
  | { method: "agents" | "chats" | "status" | "schedules" | "info" }
  | { method: "create"; agent: string; key: string; title?: string; source?: Chat["source"] }
  | { method: "snapshot" | "stop"; id: string }
  | { method: "drain" }
  | { method: "find"; key: string; agent?: string }
  | { method: "compact"; id: string; instructions?: string }
  | { method: "artifact"; id: string; artifactId: string }
  | { method: "send"; id: string; text: string; requestId: string; mode?: "followUp" | "steer"; source?: Chat["source"]; files?: AttachmentFile[] }
  | { method: "message"; from: string; message: InstanceMessage; requestId: string }
  | { method: "message-status"; from: string; taskId: number }
  | { method: "receipt"; id: string; submissionId: number };

async function dispatch(service: ServiceOperations, command: ServiceCommand, signal?: AbortSignal) {
  switch (command.method) {
    case "agents": return service.agents.map(({ id, description, model }) => ({ id, description, model }));
    case "chats": return service.list();
    case "schedules": return service.schedules?.() ?? [];
    case "create":
      if (typeof command.key !== "string" || !command.key.trim()) throw new Error("A stable conversation key is required.");
      return service.create(command.agent, command.source ?? "cli", command.key, command.title);
    case "find": {
      if (!service.find) throw new ServiceError("This service does not support key lookup.", 409);
      if (command.agent) return await service.find(command.agent, command.key) ?? null;
      const found = (await Promise.all(service.agents.map(agent => service.find!(agent.id, command.key)))).filter(chat => chat !== undefined);
      if (found.length > 1) throw new Error("This session key selects multiple agents. Supply its original agent.");
      return found[0] ?? null;
    }
    case "snapshot": return service.snapshot(command.id);
    case "compact": if (!service.compact) throw new ServiceError("Unsupported service operation.", 409); return service.compact(command.id, command.instructions);
    case "artifact": {
      const { artifact, bytes } = await service.artifact(command.id, command.artifactId);
      return { artifact, dataBase64: bytes.toString("base64") };
    }
    case "drain": if (!service.waitForIdle) throw new ServiceError("This owner does not support drain.", 409); await service.waitForIdle(signal); return {};
    case "stop": await service.stop(command.id); return {};
    case "send": return service.submit(command.id, command.text, command.requestId, command.mode ?? "followUp", command.source ?? "cli", command.files);
    case "receipt": if (!service.receipt) throw new ServiceError("Unsupported service operation.", 409); return service.receipt(command.id, command.submissionId);
    case "message": if (!service.message) throw new ServiceError("Unsupported service operation.", 409); return service.message(command.from, command.message, command.requestId);
    case "message-status": if (!service.messageStatus) throw new ServiceError("Unsupported service operation.", 409); return service.messageStatus(command.from, command.taskId);
    default: throw new Error("Unknown service command.");
  }
}

/** Bind a company-owned ChatService without creating another native owner.
 * Closing the listener disconnects clients only; the caller still owns service.close(). */
export async function serveService(owner: ServiceOperations | (() => ServiceOperations | undefined), socket: string, adapters: Awaited<ReturnType<typeof run>>["adapters"] = [], metadata: ServiceMetadata = {}) {
  if (resolve(socket) !== socket) throw new Error("socket must be an absolute path.");
  const socketDirectory = dirname(socket);
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(socketDirectory);
  if (!directory.isDirectory() || (directory.mode & 0o077) || directory.uid !== process.getuid?.()) {
    throw new Error("The service socket needs an owner-only directory.");
  }
  const server = createServer(async (incoming, response) => {
    response.setHeader("content-type", "application/json");
    if (incoming.method !== "POST" || incoming.url !== "/v1/commands") {
      response.writeHead(404).end(JSON.stringify({ error: "Use POST /v1/commands." })); return;
    }
    const service = typeof owner === "function" ? owner() : owner;
    if (!service) {
      response.writeHead(503).end(JSON.stringify({ error: "Service is starting." })); return;
    }
    try {
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
        try { result = await dispatch(service, command, observation.signal); }
        finally { response.off("close", disconnected); }
      }
      response.end(JSON.stringify({ result }));
    } catch (error) {
      const status = (error as { status?: number }).status === 409 ? 409 : 400;
      response.writeHead(status).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  // Large attachments and slow local uploads have no application size/time ceiling.
  server.requestTimeout = 0;
  let listening = false;
  try {
    const exists = await lstat(socket).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (exists) {
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
      server.listen(socket, () => { server.off("error", reject); accept(); });
    });
    listening = true;
    await chmod(socket, 0o600);
  } catch (error) { if (listening) server.close(); throw error; }
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= new Promise<void>((accept, reject) => {
    server.close(error => error ? reject(error) : accept());
    server.closeAllConnections();
  }) };
}

/** One supervised service owns native sessions; local clients never own its lifetime. */
export async function startService(config: ServiceConfig) {
  const settings = serviceSettings(config);
  for (const field of ["root", "stateRoot", "cwd", "socket"] as const) {
    if (!config[field] || resolve(config[field]) !== config[field]) throw new Error(`${field} must be an absolute path.`);
  }
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
  let listener: Awaited<ReturnType<typeof serveService>> | undefined;
  try {
    const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
    await connectModels(models);
    const adapters: Adapter[] = [];
    for (const adapter of config.adapters ?? []) {
      const module = await import(pathToFileURL(resolve(adapter.module)).href);
      const options = JSON.parse(await readFile(adapter.optionsFile, "utf8"));
      adapters.push(await module.createAdapter(options, { cwd: config.cwd, connectModels } satisfies ServiceAdapterContext));
    }
    listener = await serveService(() => runtime?.service, config.socket, preparedAdapters, { stateRoot: await realpath(config.stateRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return config.stateRoot;
    }), defaultAgent: await defaultAgent(config.root).catch(() => undefined) });
    const runner = createRunner({ namespace: config.namespace });
    runtime = await run({ ...config, runner, models, adapters, settings });
    preparedAdapters.push(...runtime.adapters);
  } catch (error) {
    try { await listener?.close(); } finally {
      try { await runtime?.close(); } finally { await closeModels(); }
    }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { ...runtime, close: () => closing ??= (async () => {
    try { await listener!.close(); } finally {
      try { await runtime!.close(); } finally { await closeModels(); }
    }
  })() };
}

export type ServiceResults = {
  info: ServiceMetadata;
  drain: Record<string, never>;
  agents: { id: string; description: string; model?: import("./definition.js").LoadedAgent["model"] }[];
  chats: Chat[];
  find: Chat | null;
  create: Chat;
  snapshot: ChatSnapshot;
  send: { submissionId: number };
  stop: Record<string, never>;
  receipt: Awaited<ReturnType<ChatService["receipt"]>>;
  artifact: { artifact: import("./artifacts.js").Artifact; dataBase64: string };
  status: Awaited<ReturnType<ChatService["activity"]>> & { adapterBusy: boolean };
  schedules: Awaited<ReturnType<ChatService["schedules"]>>;
  compact: Awaited<ReturnType<ChatService["compact"]>>;
  message: Awaited<ReturnType<ChatService["message"]>>;
  "message-status": Awaited<ReturnType<ChatService["messageStatus"]>>;
};

export class ServiceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Local CLI/API access never opens a second session writer. */
export function serviceRequest<C extends ServiceCommand>(socketPath: string, command: C, options: { signal?: AbortSignal; expected?: ServiceExpectation } = {}): Promise<ServiceResults[C["method"]]> {
  return new Promise((accept, reject) => {
    const outgoing = request({ socketPath, signal: options.signal, path: "/v1/commands", method: "POST", headers: { "content-type": "application/json" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (value.error) reject(new ServiceError(value.error, response.statusCode ?? 500)); else accept(value.result);
        } catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify(options.expected ? { command, expected: options.expected } : command));
  });
}

export { connectInTerminal } from "./service-terminal.js";
export type { ServiceTerminalOptions } from "./service-terminal.js";

export { discoverSessionService } from "./session-service.js";
export type { SessionEndpoint } from "./session-service.js";
