export type ChatMessage = { id: string; role: string; text: string; author?: string; background?: boolean; error?: string };
export type ChatSnapshot = {
  chat: Chat; messages: ChatMessage[]; running: boolean; queued: number;
  partial: string; tools: string[]; error: string | null; demo: boolean;
  background: boolean;
};

export type ChatInitializer = (tx: Tx, chat: Chat, host: Pick<AgentHost, "configuration">) => Promise<void>;
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure, defineDoc, type ConversationId, type ConversationView, type Cursor,
  type EntryRecord, type Extension, type LiveState, type SubmissionId, type Tx, type JsonObject,
} from "@earendil-works/pi-durable";
import { catalog, enabledAgents, loadAgent, type LoadedAgent } from "./definition.js";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRuntime, type AgentHost } from "./runtime.js";
import type { ReplySink } from "./replies.js";
import { createHandoffs } from "./handoff.js";
import { privateStateDirectory } from "./private-state.js";

export const context = BACKGROUND_CONTEXT;
export type Chat = {
  id: string; agent: string; conversationId: number; title: string;
  source: "cli" | "web" | "slack"; createdAt: string; origin?: JsonObject;
};
export function createChats(namespace: string, openAgent: ReturnType<typeof createRuntime>["openAgent"], Handoffs: ReturnType<typeof createHandoffs>["Handoffs"]) {
  const Chats = defineDoc<{
    byId: Record<string, Chat>; keys: Record<string, string>;
  }>({
    kind: `${namespace}.chats`, version: 1, scope: "session",
    initial: () => ({ byId: {}, keys: {} }),
  });

  function messageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  }

  function messages(entries: readonly EntryRecord[]): ChatMessage[] {
    return entries.flatMap<ChatMessage>(entry => {
      if (entry.kind === `${namespace}.background-reply`) {
        const data = entry.data as { author: string; text: string };
        return [{ id: `${entry.id}:background`, role: "assistant", text: data.text, author: data.author, background: true }];
      }
      return (entry.model ?? []).flatMap((message, index) => {
        if (message.role !== "user" && message.role !== "assistant") return [];
        const text = messageText(message.content);
        const error = message.role === "assistant" ? message.errorMessage : undefined;
        return text || error ? [{ id: `${entry.id}:${index}`, role: message.role, text, ...(error ? { error } : {}) }] : [];
      });
    });
  }

  class ChatService {
    readonly hosts = new Map<string, AgentHost>();
    readonly agents: LoadedAgent[];
    readonly demo: boolean;
    private constructor(agents: LoadedAgent[], demo: boolean, readonly initialize?: ChatInitializer) { this.agents = agents; this.demo = demo; }

    static attach(options: { agents: LoadedAgent[]; hosts: Map<string, AgentHost>; demo?: boolean; initialize?: ChatInitializer }) {
      const service = new ChatService(options.agents, options.demo ?? false, options.initialize);
      for (const [id, host] of options.hosts) service.hosts.set(id, host);
      return service;
    }

    static async open(options: {
      root: string; stateRoot: string; demo: boolean; names?: string[]; extensions?: Extension[];
      replySink?: ReplySink; updateDefinitions?: boolean; models: Models; initialize?: ChatInitializer;
      resume?: boolean;
      cwd?: string;
    }) {
      const stateRoot = resolve(options.stateRoot);
      const names = options.names?.length ? options.names :
        (await catalog(options.root)).filter(entry => entry.runnable).map(entry => entry.id);
      const agents = await Promise.all(names.map(name => loadAgent(options.root, name)));
      const service = new ChatService(agents, options.demo, options.initialize);
      const models = options.models;
      if (!options.demo && agents.some(agent => !models.getProvider(agent.model.provider))) throw new Error("Register every agent's provider in the supplied Models catalog.");
      try {
        await privateStateDirectory(stateRoot);
        const results = await Promise.allSettled(agents.map(async agent => {
          const host = await openAgent({
            agent, directory: join(stateRoot, agent.id), models,
            execution: options.demo ? "demo" : "live", extensions: options.extensions,
            replySink: options.replySink, updateDefinitions: options.updateDefinitions,
            cwd: options.cwd,
          });
          service.hosts.set(agent.id, host);
        }));
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const enabled = await enabledAgents(options.root);
        for (const agent of agents) {
          if (options.resume === false) continue;
          const host = service.host(agent.id);
          // This also recovers admitted chat/Slack work, even without a new input.
          host.harness.resume();
          if (enabled.includes(agent.id) && agent.trigger.mode !== "manual") await host.start();
        }
        return service;
      } catch (error) { await service.close(); throw error; }
    }

    host(agent: string) {
      const host = this.hosts.get(agent);
      if (!host) throw new Error(`Agent not served: ${agent}`);
      return host;
    }

    async list(): Promise<Chat[]> {
      const lists = await Promise.all([...this.hosts.values()].map(async host =>
        Object.values((await host.harness.snapshot(Chats, context))?.byId ?? {})));
      return lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    async create(agent: string, source: Chat["source"], key: string, title = "New chat", origin?: JsonObject): Promise<Chat> {
      const host = this.host(agent);
      return host.harness.commit(async tx => {
        const index = await tx.doc(Chats);
        const existing = index.keys[key];
        if (existing) {
          const chat = index.byId[existing];
          if (origin && chat.origin && !isDeepStrictEqual(origin, chat.origin)) throw new Error("Conversation already has a different origin.");
          if (origin && !chat.origin) {
            chat.origin = origin;
            await this.initialize?.(tx, chat, host);
          }
          return JSON.parse(JSON.stringify(chat)) as Chat;
        }
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, conversation.id, host.configuration);
        if (this.agents.find(definition => definition.id === agent)?.handoff) await tx.doc(Handoffs, conversation.id);
        const chat: Chat = {
          id: `${agent}:${conversation.id}`, agent, conversationId: conversation.id,
          source, ...(origin ? { origin } : {}), title: title.trim().slice(0, 120) || "New chat", createdAt: new Date().toISOString(),
        };
        await this.initialize?.(tx, chat, host);
        index.byId[chat.id] = chat;
        index.keys[key] = chat.id;
        return chat;
      }, context);
    }

    async find(agent: string, key: string) {
      const index = await this.host(agent).harness.snapshot(Chats, context);
      const id = index?.keys[key];
      return id ? index!.byId[id] : undefined;
    }

    async resolve(id: string) {
      const agent = id.split(":")[0];
      const host = this.host(agent);
      const chat = (await host.harness.snapshot(Chats, context))?.byId[id];
      if (!chat) throw new Error("Unknown conversation.");
      const conversation = await host.harness.conversation(chat.conversationId as ConversationId, context);
      if (!conversation) throw new Error("Conversation storage is missing.");
      return { host, chat, conversation };
    }

    async rename(id: string, title: string) {
      const { host } = await this.resolve(id);
      await host.harness.commit(async tx => {
        (await tx.doc(Chats)).byId[id].title = title.trim().slice(0, 120) || "New chat";
      }, context);
    }

    async submit(id: string, text: string, requestId: string, mode: "followUp" | "steer" = "followUp", source: Chat["source"] = "web") {
      if (!text.trim() || !requestId.trim()) throw new Error("A message and request ID are required.");
      const { chat, conversation } = await this.resolve(id);
      const submission = await conversation.submit({
        type: "input", content: text, requestId, whenBusy: mode,
        entry: { kind: `${namespace}.message`, data: { source } },
      }, context);
      if (chat.title === "New chat") await this.rename(id, text);
      return { submissionId: submission.id };
    }

    async receipt(id: string, submissionId: number) {
      const { host, conversation } = await this.resolve(id);
      const submission = await host.harness.submission(submissionId as SubmissionId, context);
      const record = await submission?.status(context);
      if (!record || record.conversationId !== conversation.id) throw new Error("Unknown submission.");
      return record;
    }

    async stop(id: string) {
      const { conversation } = await this.resolve(id);
      await conversation.abort(context, { background: true });
    }

    async watch(id: string, listener: (snapshot: ChatSnapshot) => Promise<void>) {
      const { host, chat: selectedChat, conversation } = await this.resolve(id);
      // Older chats predate delegation. Mount its document once before observing.
      if (this.agents.find(agent => agent.id === selectedChat.agent)?.handoff) {
        await conversation.commit(async tx => { await tx.doc(Handoffs, conversation.id); }, context);
      }
      // Attach before loading history so commits during history reads are not lost.
      const watch = await conversation.watch(context);
      const handoffWatch = await host.harness.watchDoc(Handoffs, conversation.id, context);
      const saved = new Map<number, EntryRecord>();
      let cursor: Cursor | undefined;
      do {
        const page = await conversation.entries({}, 250, cursor, context);
        for (const entry of page.items) saved.set(entry.id, entry);
        cursor = page.next;
      } while (cursor);
      const project = async (view: ConversationView) => {
        for (const entry of view.entries) saved.set(entry.id, entry);
        const { chat } = await this.resolve(id);
        const live = view.docs["pi.live"] as unknown as LiveState | undefined;
        const inbox = view.docs["pi.inbox"] as { items?: unknown[] } | undefined;
        // Pi's structural view mounts only its built-in documents.
        const handoffs = handoffWatch?.value;
        return {
          chat, messages: messages([...saved.values()].sort((a, b) => a.id - b.id)),
          running: !!live?.run, queued: inbox?.items?.length ?? 0,
          partial: messageText(live?.generation?.message?.content),
          tools: live?.tools?.filter(tool => tool.status !== "done").map(tool => tool.name) ?? [],
          error: live?.generation?.retry?.error ?? null, demo: this.demo,
          background: Object.values(handoffs?.jobs ?? {}).some(job => job.status === "working"),
        } satisfies ChatSnapshot;
      };
      let pending = Promise.resolve();
      const notify = (view: ConversationView) => {
        pending = pending.then(async () => { await listener(await project(view)); });
        return pending;
      };
      const stop = async () => {
        await Promise.all([watch.stop(), handoffWatch?.stop()]);
        await pending;
      };
      try {
        await notify(watch.value);
        watch.start(notify);
        handoffWatch?.start(() => notify(watch.value));
        return { stop, closed: watch.closed };
      } catch (error) { await stop(); throw error; }
    }

    async snapshot(id: string) {
      let value!: ChatSnapshot;
      const watch = await this.watch(id, async snapshot => { value = snapshot; });
      await watch.stop();
      return value;
    }

    async close() {
      const results = await Promise.allSettled([...this.hosts.values()].map(host => host.close()));
      this.hosts.clear();
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  }

  return { Chats, ChatService };
}

export type ChatService = ReturnType<ReturnType<typeof createChats>["ChatService"]["attach"]>;
