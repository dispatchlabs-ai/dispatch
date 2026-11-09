import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import {
  RemoteStorage,
  type StorageReply,
  type StorageRequest,
} from "@dispatch/remote";
import { createModels } from "@earendil-works/pi-ai/models";
import * as runner from "@dispatch/runner";
import {
  connectHostModels,
  type HostModelsConfig,
} from "@dispatch/runner/host-models";
import { serviceSettings, type ServicePolicy } from "@dispatch/runner/settings";
import { readDocument } from "@dispatch/backend/central";
import { createProvenance } from "@dispatch/backend/provenance";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Storage, Cursor } from "@earendil-works/pi-durable";
export interface WorkerConfig {
  service: string;
  run: string;
  tokenFile: string;
  allowLoopback?: boolean;
  definitionsRoot: string;
  stateRoot: string;
  names: string[];
  host: HostModelsConfig & ServicePolicy & { cwd: string };
}
async function scan<T>(
  read: (cursor?: Cursor) => Promise<{ items: readonly T[]; next?: Cursor }>,
) {
  const result: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await read(cursor);
    result.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return result;
}
/** Check while the storage reservation/native owner is held, before resume/abort. */
async function admit(
  service: runner.ChatService,
  selected?: { agent: string; conversationId: number },
  stop = false,
) {
  for (const [agent, host] of service.hosts) {
    if (stop && agent !== selected?.agent) continue;
    if ((await host.harness.inspect(context)).scheduling !== "paused") continue;
    const allowed = new Set<number>();
    if (agent === selected?.agent) {
      allowed.add(selected.conversationId);
      const conversations = await scan((cursor) =>
        host.storage.scanConversations({}, 250, cursor, context),
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of conversations)
          if (
            item.owner &&
            allowed.has(item.owner.conversationId) &&
            !allowed.has(item.id)
          ) {
            allowed.add(item.id);
            changed = true;
          }
      }
    }
    const tasks = await scan((cursor) =>
      host.storage.scanTasks({}, 250, cursor, context),
    );
    const submissions = await scan((cursor) =>
      host.storage.scanSubmissions({}, 250, cursor, context),
    );
    if (
      tasks.some(
        (task) =>
          task.state.status !== "terminal" &&
          (!allowed.has(task.conversationId) ||
            String(task.kind).includes("schedule") ||
            String(task.kind).includes("agent-loop")),
      ) ||
      submissions.some(
        (item) =>
          ["queued", "placed"].includes(item.status) &&
          !allowed.has(item.conversationId),
      )
    ) {
      const error = new Error(
        "Suspended work outside this conversation ownership tree. Finish or stop it in its original owner, then retry. No unrelated work was resumed.",
      );
      Object.assign(error, { status: 409 });
      throw error;
    }
  }
}
export async function startWorker(config: WorkerConfig) {
  const url = new URL("/workers", config.service);
  url.searchParams.set("run", config.run);
  if (
    url.protocol !== "https:" &&
    !(
      config.allowLoopback &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1"
    )
  )
    throw new Error(
      "Worker service requires HTTPS (or explicit synthetic loopback).",
    );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  if (token.length < 32) throw new Error("Worker token too short.");
  let socket: WebSocket;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const calls = new Map<
    string,
    {
      resolve(value: StorageReply): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let service: runner.ChatService | undefined;
  let connection: Awaited<ReturnType<typeof connectHostModels>> | undefined;
  let opening: Promise<runner.ChatService> | undefined;
  const native = runner.createRunner();
  const storageCall = (agent: string, request: StorageRequest) =>
    new Promise<StorageReply>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Disconnected storage transport."));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error("Storage response uncertain."));
      }, 15000);
      calls.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "storage", id, agent, request }));
    });
  async function own() {
    if (service) return service;
    if (opening) return opening;
    opening = (async () => {
      process.env.DISPATCH_SESSION_STATE_ROOT = config.stateRoot;
      const models = createModels({
        authContext: {
          env: async () => undefined,
          fileExists: async () => false,
        },
      });
      connection = await connectHostModels(config.host, models);
      for (const provider of models.getProviders())
        models.setProvider(runner.withPrivateProviderErrors(provider));
      const opened: Storage[] = [];
      try {
        service = await native.ChatService.open({
          root: config.definitionsRoot,
          stateRoot: config.stateRoot,
          names: config.names,
          models,
          demo: false,
          resume: false,
          cwd: config.host.cwd,
          definitionResources: true,
          settings: serviceSettings(config.host),
          storage: async (agent) => {
            const storage = await RemoteStorage.open((request) =>
              storageCall(agent.id, request),
            );
            opened.push(storage);
            const saved = (await readDocument(
              storage,
              "dispatch.runner",
            )) as any;
            const extensions = [
              "dispatch.schedules",
              "dispatch.definition-resources",
              ...(agent.messages?.length
                ? [`dispatch.instance-messages.${agent.id}`]
                : []),
            ];
            if (
              saved?.fingerprint &&
              (saved.fingerprint !== agent.fingerprint ||
                saved.execution !== "live" ||
                saved.cwd !== config.host.cwd ||
                saved.artifactVersion !== 1 ||
                saved.hostExtensions?.some(
                  (name: string) => !extensions.includes(name),
                ))
            )
              throw Object.assign(
                new Error(
                  "Saved native definition/host differs. Use the original release and host bindings; no migration was applied.",
                ),
                { status: 409 },
              );
            return storage;
          },
        });
        return service;
      } catch (error) {
        await Promise.allSettled(opened.map((store) => store.close(context)));
        await connection.close();
        throw error;
      }
    })();
    try {
      return await opening;
    } finally {
      opening = undefined;
    }
  }
  // Mutations serialize only at admission to this native work scope, never a
  // principal-wide execution queue; Pi owns concurrent conversations/tasks.
  let mutation = Promise.resolve();
  async function execute(value: any) {
    try {
      let result;
      if (value.method === "observe") {
        if (service) {
          try {
            const { conversation } = await service.resolve(value.args[0]);
            result = await createProvenance(
              conversation,
              context,
              "dispatch",
            )(await service.snapshot(value.args[0]));
          } catch {
            result = null;
          }
        } else result = null;
      } else {
        const methods = ["create", "submit", "stop", "artifact"];
        if (!methods.includes(value.method) || !Array.isArray(value.args))
          throw new Error("Invalid worker command.");
        if (value.method === "artifact" && !service)
          throw Object.assign(
            new Error(
              "Artifact bytes require the original retained worker owner. History remains read-only.",
            ),
            { status: 409 },
          );
        const owner = service ?? (await own());
        if (value.method === "artifact") {
          const artifact = await owner.artifact(value.args[0], value.args[1]);
          result = {
            ...artifact,
            bytes: Buffer.from(artifact.bytes).toString("base64"),
          };
        } else {
          if (value.method !== "create") await owner.resolve(value.args[0]);
          const [agent, number] = String(value.args[0]).split(":");
          await admit(
            owner,
            value.method === "create"
              ? undefined
              : { agent, conversationId: Number(number) },
            value.method === "stop",
          );
          if (value.method === "submit")
            for (const host of owner.hosts.values()) host.harness.resume();
          if (value.method === "create")
            result = await owner.create(
              value.args[0],
              value.args[1],
              value.args[2],
            );
          if (value.method === "submit")
            result = await owner.submit(
              value.args[0],
              value.args[1],
              value.args[2],
              value.args[3],
              value.args[4],
            );
          if (value.method === "stop") await owner.stop(value.args[0]);
        }
      }
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "result", id: value.id, result }));
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: "result",
            id: value.id,
            status: (error as any).status,
            error:
              (error as any).status === 409
                ? (error as Error).message
                : "Native operation failed; preserve request identity and reconcile with its original owner.",
          }),
        );
    }
  }
  function connect() {
    socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
      followRedirects: false,
      maxPayload: 0,
    });
    socket.on("error", () => {});
    socket.on("message", (bytes) => {
      let value;
      try {
        value = JSON.parse(String(bytes));
      } catch {
        socket.close(1003, "Invalid frame");
        return;
      }
      if (value.type === "storage-reply") {
        const call = calls.get(value.id);
        if (call) {
          calls.delete(value.id);
          clearTimeout(call.timer);
          call.resolve(value.reply);
        }
      }
      if (value.type === "command") {
        if (value.method === "observe") void execute(value);
        else
          mutation = mutation.then(
            () => execute(value),
            () => execute(value),
          );
      }
    });
    socket.on("close", () => {
      for (const call of calls.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("Connection lost; storage receipt uncertain."));
      }
      calls.clear();
      // Retain this process and its native reservation. Never create another
      // owner, retry application commands or auto-resume on reconnect.
      if (!stopped) timer = setTimeout(connect, 1000);
    });
  }
  connect();
  return {
    close: async () => {
      stopped = true;
      clearTimeout(timer);
      await mutation;
      await service?.close();
      await connection?.close();
      socket.close();
    },
  };
}
