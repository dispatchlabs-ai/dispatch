import { createServer, request } from "node:http";
import { chmod, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRunner } from "./index.js";
import { run, type Adapter } from "./run.js";
import { refreshGatewayModels, type ModelChoice, type GatewayAliases } from "./gateway.js";
import type { ChatService } from "./chat.js";
import type { InstanceMessage } from "./messages.js";
import { serviceSettings, type ServicePolicy } from "./settings.js";

export type ServiceConfig = ServicePolicy & {
  root: string;
  stateRoot: string;
  cwd: string;
  socket: string;
  namespace?: string;
  names?: string[];
  updateDefinitions?: boolean;
  gateway: { origin: string; credentialFile: string; aliases?: GatewayAliases };
  adapters?: { module: string; optionsFile: string }[];
};
export type ServiceAdapterContext = {
  cwd: string;
  connectModels: (models: ReturnType<typeof createModels>) => Promise<ModelChoice[]>;
};
export type ServiceCommand =
  | { method: "agents" | "chats" | "status" | "schedules" }
  | { method: "create"; agent: string; key: string; title?: string }
  | { method: "snapshot" | "stop"; id: string }
  | { method: "compact"; id: string; instructions?: string }
  | { method: "send"; id: string; text: string; requestId: string }
  | { method: "message"; from: string; message: InstanceMessage; requestId: string }
  | { method: "message-status"; from: string; taskId: number }
  | { method: "receipt"; id: string; submissionId: number };

async function dispatch(service: ChatService, command: ServiceCommand) {
  switch (command.method) {
    case "agents": return service.agents.map(({ id, description, model }) => ({ id, description, model }));
    case "chats": return service.list();
    case "schedules": return service.schedules();
    case "create":
      if (typeof command.key !== "string" || !command.key.trim()) throw new Error("A stable conversation key is required.");
      return service.create(command.agent, "cli", command.key, command.title);
    case "snapshot": return service.snapshot(command.id);
    case "compact": return service.compact(command.id, command.instructions);
    case "stop": await service.stop(command.id); return {};
    case "send": return service.submit(command.id, command.text, command.requestId, "followUp", "cli");
    case "receipt": return service.receipt(command.id, command.submissionId);
    case "message": return service.message(command.from, command.message, command.requestId);
    case "message-status": return service.messageStatus(command.from, command.taskId);
    default: throw new Error("Unknown service command.");
  }
}

/** One service owns native sessions; adapters and local clients share that owner. */
export async function startService(config: ServiceConfig) {
  const settings = serviceSettings(config);
  for (const field of ["root", "stateRoot", "cwd", "socket"] as const) {
    if (!config[field] || resolve(config[field]) !== config[field]) throw new Error(`${field} must be an absolute path.`);
  }
  const socketDirectory = dirname(config.socket);
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  const directory = await stat(socketDirectory);
  if ((directory.mode & 0o077) || directory.uid !== process.getuid?.()) {
    throw new Error("The service socket needs an owner-only directory.");
  }
  const connectModels: ServiceAdapterContext["connectModels"] = async models => {
    const { key } = JSON.parse(await readFile(config.gateway.credentialFile, "utf8"));
    return refreshGatewayModels(config.gateway.origin, models, key, config.gateway.aliases);
  };
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  await connectModels(models);
  const adapters: Adapter[] = [];
  for (const adapter of config.adapters ?? []) {
    const module = await import(pathToFileURL(resolve(adapter.module)).href);
    const options = JSON.parse(await readFile(adapter.optionsFile, "utf8"));
    adapters.push(await module.createAdapter(options, { cwd: config.cwd, connectModels } satisfies ServiceAdapterContext));
  }
  const runner = createRunner({ namespace: config.namespace });
  let runtime: Awaited<ReturnType<typeof run>> | undefined;
  const server = createServer(async (incoming, response) => {
    response.setHeader("content-type", "application/json");
    if (incoming.method !== "POST" || incoming.url !== "/v1/commands") {
      response.writeHead(404).end(JSON.stringify({ error: "Use POST /v1/commands." })); return;
    }
    if (!runtime) {
      response.writeHead(503).end(JSON.stringify({ error: "Service is starting." })); return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error("Command is too large.");
        chunks.push(chunk);
      }
      const command = JSON.parse(Buffer.concat(chunks).toString());
      let result;
      if (command.method === "status") {
        const activity = await runtime.service.activity();
        const adapterBusy = (await Promise.all(runtime.adapters.map(adapter => adapter.busy?.() ?? false))).some(Boolean);
        result = { ...activity, adapterBusy, busy: activity.busy || adapterBusy };
      } else result = await dispatch(runtime.service, command);
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  let listening = false;
  try {
    // A crashed Unix server may leave its socket. Probe it before removing only
    // a refused endpoint; never replace another running service.
    const exists = await stat(config.socket).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (exists) {
      if (!exists.isSocket()) throw new Error("The service socket path is not a socket.");
      await serviceRequest(config.socket, { method: "agents" }).then(() => {
        throw new Error("A service is already listening on this socket.");
      }, async error => {
        if (error.code !== "ECONNREFUSED") throw error;
        await unlink(config.socket);
      });
    }
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(config.socket, () => { server.off("error", reject); accept(); });
    });
    listening = true;
    await chmod(config.socket, 0o600);
    runtime = await run({ ...config, runner, models, adapters, settings });
  } catch (error) { await runtime?.close(); if (listening) server.close(); throw error; }
  let closing: Promise<void> | undefined;
  return {
    ...runtime,
    close: () => closing ??= (async () => {
      await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
      await runtime!.close();
    })(),
  };
}

/** Local CLI/API access never opens a second session writer. */
export function serviceRequest(socketPath: string, command: ServiceCommand): Promise<unknown> {
  return new Promise((accept, reject) => {
    const outgoing = request({ socketPath, path: "/v1/commands", method: "POST", headers: { "content-type": "application/json" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (value.error) reject(new Error(value.error)); else accept(value.result);
        } catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify(command));
  });
}
