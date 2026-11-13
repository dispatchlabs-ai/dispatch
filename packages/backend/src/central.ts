import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { PostgresStorage, PostgresStorageService } from "@dispatch/postgres";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { prepareContent, projectChatTurns, projectChatTools, type AttachmentFile, projectChatMessages, type Chat as NativeChat } from "@dispatch/runner";
import type { Storage, Cursor, ConversationId } from "@earendil-works/pi-durable";
import type { Chat, Snapshot, Agent } from "./contracts.js";
import { AdmissionError } from "./config.js";
export interface RunBinding {
  id: string;
  tokenFile: string;
  agents: Agent[];
}
export interface CentralConfig {
  databaseUrlFile: string;
  databaseCaFile?: string;
  workerPort: number;
  workerHost?: string;
  runs: RunBinding[];
}
export const storeId = (run: string, agent: string) => `${run}:${agent}`;
export const chatId = (run: string, agent: string, conversation: number) =>
  `${run}/${agent}/${conversation}`;
async function pages<T>(
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
export async function readDocument(storage: Storage, kind: string) {
  const record = await storage.findDocument(
    { kind, scope: { kind: "session" } },
    "current",
    context,
  );
  return record
    ? (await storage.document(record.id, "current", context))?.value
    : undefined;
}
/** Central service owns storage and route authority. Workers initiate connections.
 * A disconnected worker reservation is never replaced, even after service restart. */
export async function openCentralRuntime(config: CentralConfig) {
  const options = {
    connectionString: (await readFile(config.databaseUrlFile, "utf8")).trim(),
    ...(config.databaseCaFile
      ? { ca: await readFile(config.databaseCaFile, "utf8") }
      : {}),
  };
  const bindings = new Map(config.runs.map((run) => [run.id, run]));
  if (
    bindings.size !== config.runs.length ||
    config.runs.some((run) => !/^[a-z][a-z0-9-]*$/.test(run.id))
  )
    throw new Error("Unique run bindings required.");
  const sessions = new Map<string, WebSocket>();
  const calls = new Map<
    string,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      run: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const secrets = new Map(
    await Promise.all(
      config.runs.map(
        async (run) =>
          [run.id, (await readFile(run.tokenFile, "utf8")).trim()] as const,
      ),
    ),
  );
  if ([...secrets.values()].some((token) => token.length < 32))
    throw new Error("Worker tokens must be at least 32 characters.");
  const storage = new PostgresStorageService(options, (id) =>
    config.runs.some((run) =>
      run.agents.some((agent) => storeId(run.id, agent.id) === id),
    ),
  );
  const server = createServer((req, res) =>
    res
      .writeHead(req.method === "GET" && req.url === "/health" ? 200 : 404)
      .end(),
  );
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 0 });
  server.on("upgrade", (request, socket, head) => {
    let run: string;
    try {
      run =
        new URL(request.url ?? "/", "http://local").searchParams.get("run") ??
        "";
    } catch {
      socket.destroy();
      return;
    }
    const token = Buffer.from(
      request.headers.authorization?.replace(/^Bearer /, "") ?? "",
    );
    const expected = Buffer.from(secrets.get(run) ?? "");
    if (
      request.url?.split("?")[0] !== "/workers" ||
      !expected.length ||
      token.length !== expected.length ||
      !timingSafeEqual(token, expected) ||
      sessions.has(run)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      sessions.set(run, ws);
      ws.on("message", async (bytes) => {
        let value: any;
        try {
          value = JSON.parse(String(bytes));
          if (value.type === "storage") {
            if (
              !bindings
                .get(run)!
                .agents.some((agent) => agent.id === value.agent)
            )
              throw new Error("Agent not bound.");
            const reply = await storage.request(
              storeId(run, value.agent),
              value.request,
            );
            if (ws.readyState === WebSocket.OPEN)
              ws.send(
                JSON.stringify({ type: "storage-reply", id: value.id, reply }),
              );
          } else if (value.type === "result") {
            const call = calls.get(value.id);
            if (!call || call.run !== run) return;
            calls.delete(value.id);
            clearTimeout(call.timer);
            if (value.error)
              call.reject(
                value.status === 409
                  ? new AdmissionError(value.error)
                  : new Error(value.error),
              );
            else call.resolve(value.result);
          }
        } catch {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                type: "storage-reply",
                id: value?.id,
                reply: { status: "fatal", error: "Storage request rejected." },
              }),
            );
        }
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        sessions.delete(run);
        for (const [id, call] of calls)
          if (call.run === run) {
            calls.delete(id);
            clearTimeout(call.timer);
            call.reject(
              new Error(
                "Worker disconnected; delivery is uncertain. Preserve request identity.",
              ),
            );
          }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.workerPort, config.workerHost ?? "127.0.0.1", resolve);
  });
  const command = (run: string, method: string, args: unknown[]) =>
    new Promise<any>((resolve, reject) => {
      const ws = sessions.get(run);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(
          new AdmissionError(
            "Bound worker is offline. Reconnect its original native owner; do not replace it.",
          ),
        );
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(
          new Error(
            "Worker response timed out; delivery uncertain. Retain request identity.",
          ),
        );
      }, 60000);
      calls.set(id, { resolve, reject, run, timer });
      ws.send(JSON.stringify({ type: "command", id, method, args }));
    });
  const read = <T>(
    run: string,
    agent: string,
    action: (storage: Storage) => Promise<T>,
  ) =>
    PostgresStorage.readSnapshot(
      { ...options, storeId: storeId(run, agent) },
      action,
    );
  const namespace = "dispatch";
  const absentStore = (error: unknown) => error instanceof Error && (
    error.message === "PostgreSQL history store is unavailable." ||
    ["42P01", "3F000"].includes((error as { code?: string }).code ?? "")
  );
  async function list(): Promise<Chat[]> {
    const result: Chat[] = [];
    for (const run of config.runs)
      for (const agent of run.agents) {
        // Missing stores are empty only before first explicit create. All other read errors surface.
        try {
          await read(run.id, agent.id, async (db) => {
            const doc = (await readDocument(db, `${namespace}.chats`)) as
              { byId?: Record<string, NativeChat> } | undefined;
            const indexed = new Map(
              Object.values(doc?.byId ?? {}).map((chat) => [
                chat.conversationId,
                chat,
              ]),
            );
            const conversations = await pages((cursor) =>
              db.scanConversations({}, 250, cursor, context),
            );
            for (const conversation of conversations) {
              const saved = indexed.get(conversation.id);
              // Include native workflow/CLI children without inventing Chats admission.
              // Root is a native control conversation, not a user conversation.
              if (!saved && conversation.id === 1) continue;
              result.push({
                id: chatId(run.id, agent.id, conversation.id),
                agent: agent.id,
                conversationId: conversation.id,
                title: saved?.title ?? `Native conversation ${conversation.id}`,
                source: saved?.source ?? "native",
                ...(saved?.source ? { transport: saved.source } : {}),
                createdAt: saved?.createdAt ?? "",
                sourceLabel: run.id,
                session: run.id,
                // Observed, not probed: an indexed root chat with a connected worker.
                addressable: !!saved && !conversation.owner && sessions.get(run.id)?.readyState === WebSocket.OPEN,
                ...(conversation.owner
                  ? {
                      parentId: chatId(
                        run.id,
                        agent.id,
                        conversation.owner.conversationId,
                      ),
                    }
                  : {}),
              });
            }
          });
        } catch (error) {
          // Only a genuinely absent initial store is empty. Permissions, connection,
          // schema-version and corruption errors stay visible, never silently empty.
          if (!absentStore(error))
            throw error;
        }
      }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  function selection(id: string) {
    const [run, agent, number, ...rest] = id.split("/");
    const conversation = Number(number);
    if (
      rest.length ||
      String(conversation) !== number ||
      !bindings.get(run)?.agents.some((a) => a.id === agent) ||
      !Number.isSafeInteger(conversation) ||
      conversation < 1
    )
      throw new AdmissionError("Unknown bound conversation.");
    return { run, agent, conversation, native: `${agent}:${conversation}` };
  }
  async function snapshot(id: string): Promise<Snapshot> {
    const item = selection(id);
    // Live snapshots are safe only after deliberate worker ownership. The worker
    // returns null rather than lazily opening an owner on observation.
    const ws = sessions.get(item.run);
    if (ws) {
      const live = await command(item.run, "observe", [item.native]);
      if (live)
        return {
          ...live,
          chat: { ...live.chat, id, transport: live.chat.source, sourceLabel: item.run, session: item.run, addressable: true },
        };
    }
    return read(item.run, item.agent, async (db) => {
      const conversation = await db.conversation(item.conversation as ConversationId, context);
      if (!conversation) throw new AdmissionError("Conversation not found.");
      const index = await readDocument(db, `${namespace}.chats`) as {byId?: Record<string, NativeChat>} | undefined;
      const saved = index?.byId?.[item.native];
      // Same access reasons as local stores; mutation admission is unchanged.
      const access: Pick<Snapshot, "readOnly" | "readOnlyReason"> = conversation.owner ? { readOnly: "worker", readOnlyReason: "Worker conversation run by a task. Steer its parent." }
        : !saved ? { readOnly: "internal", readOnlyReason: "Internal service conversation." }
        : sessions.get(item.run)?.readyState !== WebSocket.OPEN ? { readOnly: "unavailable", readOnlyReason: "Bound worker is offline. Reconnect its original native owner; saved history remains available." }
        : {};
      const chat: Chat = {id, agent:item.agent, conversationId:item.conversation, title:saved?.title ?? `Native conversation ${item.conversation}`, addressable: !access.readOnly,
        source:saved?.source ?? "native", ...(saved?.source ? {transport:saved.source} : {}), createdAt:saved?.createdAt ?? "", sourceLabel:item.run, session:item.run,
        ...(conversation.owner ? {parentId:chatId(item.run,item.agent,conversation.owner.conversationId)} : {})};
      const entries = await pages((cursor) =>
        db.scanEntries(
          { conversationId: item.conversation as any, order: "ascending" },
          250,
          cursor,
          context,
        ),
      );
      const messages = projectChatMessages(namespace, entries);
      return {
        chat,
        messages,
        turns: projectChatTurns(await pages(cursor => db.scanSubmissions({conversationId:item.conversation as ConversationId},250,cursor,context))),
        toolCalls: projectChatTools(entries, undefined, await pages(cursor => db.scanTasks({conversationId:item.conversation as ConversationId, kind:"pi.tool"},250,cursor,context))),
        running: false,
        queued: 0,
        partial: "",
        tools: [],
        error: null,
        demo: false,
        background: false,
        observation: "Saved native history",
        ...access,
      } as Snapshot;
    });
  }
  const service = {
    agents: [
      ...new Map(
        config.runs
          .flatMap((run) => run.agents)
          .map((agent) => [agent.id, agent]),
      ).values(),
    ],
    sources: async () =>
      config.runs.map((run) => ({
        id: run.id,
        label: run.id,
        issues: sessions.has(run.id)
          ? []
          : ["Worker offline; saved history remains available."],
      })),
    list,
    async has(id: string) {
      let item;
      try { item = selection(id); } catch (error) { if (error instanceof AdmissionError) return false; throw error; }
      try { return await read(item.run, item.agent, async db => !!await db.conversation(item.conversation as ConversationId, context)); }
      catch (error) { if (absentStore(error)) return false; throw error; }
    },
    async create(
      agent: string,
      source: NativeChat["source"],
      key: string,
      sourceId?: string,
    ) {
      const run = sourceId
        ? bindings.get(sourceId)
        : config.runs.find((run) => run.agents.some((a) => a.id === agent));
      if (!run?.agents.some((a) => a.id === agent))
        throw new AdmissionError("Agent not bound to run.");
      const chat = await command(run.id, "create", [agent, source, key]);
      return {
        ...chat,
        id: chatId(run.id, agent, chat.conversationId),
        sourceLabel: run.id,
        session: run.id,
      };
    },
    async submit(
      id: string,
      text: string,
      requestId: string,
      _mode: "steer",
      source: NativeChat["source"],
      files: AttachmentFile[] = [],
    ) {
      prepareContent(text, files);
      const item = selection(id);
      return command(item.run, "submit", [
        item.native,
        text,
        requestId,
        "steer",
        source,
        files,
      ]);
    },
    async stop(id: string) {
      const item = selection(id);
      await command(item.run, "stop", [item.native]);
    },
    async artifact(id: string, artifactId: string) {
      const item = selection(id);
      const result = await command(item.run, "artifact", [
        item.native,
        artifactId,
      ]);
      return { ...result, bytes: Buffer.from(result.bytes, "base64") };
    },
  };
  return {
    summary: async () => {
      const chats = await list();
      const observed: Chat[] = [];
      for (const run of config.runs) for (const agent of run.agents) {
        const selected = chats.filter(chat => chat.session === run.id && chat.agent === agent.id);
        if (!selected.length) continue;
        try {
          await read(run.id, agent.id, async db => {
            const tasks = await pages(cursor => db.scanTasks({}, 250, cursor, context));
            const submissions = await pages(cursor => db.scanSubmissions({}, 250, cursor, context));
            for (const chat of selected) {
              const active = tasks.filter(task => task.conversationId === chat.conversationId && task.state.status !== "terminal");
              const last = submissions.filter(item => item.conversationId === chat.conversationId).at(-1);
              const activity = active.length && !sessions.has(run.id) ? "unavailable" : active.some(task => ["running", "runnable"].includes(task.state.status)) ? "working" : active.length ? "waiting" : last?.status === "unanswered" ? "unanswered" : "idle";
              observed.push({ ...chat, activity });
            }
          });
        } catch { observed.push(...selected.map(chat => ({ ...chat, activity: "unavailable" as const }))); }
      }
      return { agents: service.agents, chats: observed, sources: await service.sources() };
    },
    service,
    presentation: {
      snapshot,
      async watch(id: string, listener: (value: Snapshot) => Promise<void>) {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        let finish!: () => void;
        const closed = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const tick = async () => {
          try {
            if (!stopped) await listener(await snapshot(id));
          } catch {
            stopped = true;
            finish();
          }
          if (!stopped) timer = setTimeout(() => void tick(), 500);
        };
        await listener(await snapshot(id));
        timer = setTimeout(() => void tick(), 500);
        return {
          closed,
          stop: async () => {
            stopped = true;
            clearTimeout(timer);
            finish();
          },
        };
      },
    },
    stateRoot: "central PostgreSQL",
    close: async () => {
      for (const ws of sessions.values()) ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await storage.close();
    },
  };
}
