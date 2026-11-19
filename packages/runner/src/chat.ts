import type { Users, UserIdentity } from "./users.js";
import { prepareContent, ContentError, type AttachmentFile } from "./chat-content.js";
import { projectChatTurns, type ChatTurn } from "./chat-turns.js";
import { projectChatTools, type ChatToolCall } from "./chat-tools.js";
export type ChatMessage = { provenance?: "user" | "agent" | "runtime"; id: string; role: string; text: string; at?: number; commentary?: string; thinking?: string; author?: string; userId?: string; background?: boolean;
  /** A background reply's supporting material (publishReply details), shown collapsed. */
  details?: { label: string; text: string }; error?: string; attachments?: AttachmentFile[]; artifacts?: Artifact[] };
export type ChatSnapshot = {
  chat: Chat; messages: ChatMessage[]; turns?: ChatTurn[]; toolCalls?: ChatToolCall[]; running: boolean; queued: number;
  partial: string; partialThinking?: string; tools: string[]; error: string | null; demo: boolean;
  background: boolean;
  /** Native pending retry; at is an epoch-millisecond deadline. */
  retry?: { attempt: number; at: number; error: string };
  compactions?: LiveState["compactions"];
  compactionFailure?: LiveState["compactionFailure"];
};

export type ChatInitializer = (tx: Tx, chat: Chat, host: Pick<AgentHost, "configuration">) => Promise<void>;
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  defineDoc, LiveDoc, ROOT_CONVERSATION_ID, type ConversationId, type ConversationView, type Cursor, type TaskInspection,
  type SubmissionDraft, type EntryRecord, type TaskRecord, type Extension, type LiveState, type SubmissionId, type Tx, type JsonObject,
} from "@earendil-works/pi-durable";
import { catalog, enabledAgents, loadAgent, type LoadedAgent } from "./definition.js";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRuntime, type AgentHost, type StorageFactory, type OpenOptions } from "./runtime.js";
import type { ReplySink } from "./replies.js";
import { createHandoffs } from "./handoff.js";
import { privateStateDirectory } from "./private-state.js";
import { reportError } from "./terminal-output.js";
import { publicCommentary } from "./commentary.js";
import { recordRequestCancellation } from "./request-completion.js";
import { createInstanceMessaging, instanceMessagingExtension, selectMessageTools, type InstanceMessage } from "./messages.js";
import { sleepingReminder } from "./reminders.js";
import { createSchedules, scheduleTaskKind } from "./schedules.js";
import type { Artifact, ArtifactRecord, ArtifactOptions, createArtifacts } from "./artifacts.js";
import { chatIdentity } from "./chat-identity.js";

export const context = BACKGROUND_CONTEXT;
export type Chat = {
  id: string; agent: string; conversationId: number; title: string;
  source: string; createdAt: string; origin?: JsonObject;
};
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

/** Provider-visible thinking text only; opaque replay signatures and redacted blocks stay native. */
function messageThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => part.type === "thinking" && !part.redacted && part.thinking.trim() ? [part.thinking] : []).join("\n\n");
}

export function projectChatMessages(namespace: string, entries: readonly EntryRecord[]): ChatMessage[] {
  return entries.flatMap<ChatMessage>(entry => {
    if (entry.kind === `${namespace}.artifact`) {
      const { deliveries: _initialDeliveryTasks, ...artifact } = entry.data as ArtifactRecord;
      return [{ provenance: "agent", id: `${entry.id}:artifact`, role: "assistant", text: "", artifacts: [artifact] }];
    }
    if (entry.kind === `${namespace}.background-reply`) {
      const data = entry.data as { author?: string; text: string; at?: number; details?: { label: string; text: string } };
      const at = data.at ?? entry.model?.[0]?.timestamp;
      return [{ provenance: "agent", id: `${entry.id}:background`, role: "assistant", text: data.text, ...(data.author ? { author: data.author } : {}), background: true,
        ...(typeof at === "number" ? { at } : {}), ...(data.details ? { details: data.details } : {}) }];
    }
    return (entry.model ?? []).flatMap((message, index) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const text = messageText(message.content);
      const thinking = message.role === "assistant" ? messageThinking(message.content) : "";
      const error = message.role === "assistant" ? message.errorMessage : undefined;
      const at = message.timestamp + (message.role === "assistant" ? message.durationMs ?? 0 : 0);
      const data = entry.data as { source?: string; author?: string; userId?: string; actor?: "user" | "agent" | "runtime"; text?: string; attachments?: AttachmentFile[] } | undefined;
      const attached = message.role === "user" && entry.kind === `${namespace}.message` && data?.attachments?.length ? data.attachments : undefined;
      const hasTools = message.role === "assistant" && Array.isArray(message.content) && message.content.some(part => part.type === "toolCall");
      const provenance = message.role !== "user" ? "agent" as const
        : entry.kind === `${namespace}.message` && data?.actor ? data.actor
        : entry.kind === `${namespace}.message` && data?.source && !["agent", "schedule"].includes(data.source) ? "user" as const
          : entry.kind === `${namespace}.instance-message` ? "agent" as const : "runtime" as const;
      return text || thinking || error || attached || hasTools ? [{ provenance, ...(entry.kind === `${namespace}.instance-message` ? {author: (entry.data as {from?: string})?.from} : {}), id: `${entry.id}:${index}`, role: message.role, text: attached || (message.role === "user" && data?.userId) ? data?.text ?? "" : text, at,
        ...(message.role === "user" && data?.userId ? { author: data.author, userId: data.userId } : {}),
        ...(attached ? { attachments: attached } : {}),
        ...(thinking ? { thinking } : {}),
        ...(message.role === "assistant" ? { commentary: publicCommentary(message) } : {}), ...(error ? { error } : {}) }] : [];
    });
  });
}

export function createChats(namespace: string, openAgent: ReturnType<typeof createRuntime>["openAgent"], Handoffs: ReturnType<typeof createHandoffs>["Handoffs"], Artifacts: ReturnType<typeof createArtifacts>["Artifacts"]) {
  // An agent's own store lists its chats. Each chat's conversation and work live in that chat's store.
  // `open` names the chats whose stores may hold unsettled work, so a restarted host reopens exactly those.
  const Chats = defineDoc<{
    byId: Record<string, Chat>; keys: Record<string, string>; next?: number; open?: Record<string, true>; layout?: 2;
  }>({
    kind: `${namespace}.chats`, version: 1, scope: "session",
    checkpointWhen: () => false,
    initial: () => ({ byId: {}, keys: {} }),
  });
  const Identity = chatIdentity(namespace);
  const chatNumber = (id: string) => id.slice(id.lastIndexOf(":") + 1);
  // A chat store with nothing runnable and no sleeping task closes after this long without use.
  const idleCloseMs = 60_000;

  function messaging(service: ChatService, from: string) {
    const agent = service.agents.find(candidate => candidate.id === from.split(":")[0]);
    if (!agent?.messages?.length) throw new Error("The sender has no instance messaging capability.");
    return createInstanceMessaging(namespace, agent, service);
  }

  const admissions = new WeakMap<object, Map<string, Promise<unknown>>>();
  const modelCatalogs = new WeakMap<object, Models>();
  async function admit<T>(service: object, id: string, operation: () => Promise<T>): Promise<T> {
    const pending = admissions.get(service) ?? new Map<string, Promise<unknown>>();
    admissions.set(service, pending);
    const next = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    pending.set(id, next);
    try { return await next; }
    finally { if (pending.get(id) === next) pending.delete(id); }
  }

  // Open chat stores, kept beside the service because its exported class type cannot carry private members.
  type Owner = { agents: LoadedAgent[]; initialize?: ChatInitializer; host(agent: string): AgentHost };
  type OpenStores = {
    chats: Map<string, Promise<AgentHost>>; closing: Map<string, Promise<void>>;
    used: Map<string, number>; watched: Map<string, number>;
    open?: (agent: LoadedAgent, chat: Chat) => Promise<AgentHost>; started: boolean; sweep?: ReturnType<typeof setInterval>;
    refusal?: string;
    opened: Set<(chat: Chat, host: AgentHost) => void | Promise<void>>;
  };
  const openStores = new WeakMap<object, OpenStores>();
  const storesOf = (service: object) => {
    let stores = openStores.get(service);
    if (!stores) openStores.set(service, stores = { chats: new Map(), closing: new Map(), used: new Map(), watched: new Map(), started: false, opened: new Set() });
    return stores;
  };

  /** Open a chat's store, or share the one already open. */
  function chatStore(service: Owner, chat: Chat): Promise<AgentHost> {
    const stores = storesOf(service);
    stores.used.set(chat.id, Date.now());
    const opened = stores.chats.get(chat.id);
    if (opened) return opened;
    const open = stores.open;
    if (!open) throw new Error("This service was attached to stores it did not open and cannot open a chat's store.");
    const agent = service.agents.find(agent => agent.id === chat.agent)!;
    const pending: Promise<AgentHost> = (async () => {
      await stores.closing.get(chat.id);
      // Mark first: a host that dies while this store holds work finds the mark and reopens the store.
      await service.host(chat.agent).harness.commit(async tx => {
        const index = await tx.doc(Chats);
        if (!index.open?.[chat.id]) index.open = { ...index.open, [chat.id]: true };
      }, context);
      const host = await open(agent, chat);
      try {
        await host.harness.commit(async tx => {
          const identity = await tx.doc(Identity);
          if (identity.id) return;
          identity.id = chat.id;
          identity.source = chat.source;
          if (chat.origin) identity.origin = chat.origin;
          if (agent.handoff) await tx.doc(Handoffs, ROOT_CONVERSATION_ID);
          await service.initialize?.(tx, chat, host);
        }, context);
        if (stores.started) host.harness.resume();
        // An adapter's per-chat work must not decide whether the chat can be used.
        for (const listener of stores.opened) {
          await Promise.resolve(listener(chat, host)).catch(error => reportError(`[${chat.id}] A chat-open listener failed:`, error));
        }
        return host;
      } catch (error) { await host.close(); throw error; }
    })();
    stores.chats.set(chat.id, pending);
    pending.catch(() => { if (stores.chats.get(chat.id) === pending) stores.chats.delete(chat.id); });
    return pending;
  }

  /** Close chat stores with nothing runnable and nothing sleeping, so an idle chat holds no open store. */
  async function closeIdle(service: Owner) {
    const stores = storesOf(service);
    const quiet = (id: string) => !stores.watched.get(id) && Date.now() - (stores.used.get(id) ?? 0) >= idleCloseMs;
    for (const [id, opened] of stores.chats) {
      if (!quiet(id)) continue;
      const host = await opened.catch(() => undefined);
      // The chat may have been used, watched or replaced while its store finished opening.
      if (!host || stores.chats.get(id) !== opened || !quiet(id)) continue;
      const wake = host.harness.wake();
      if (wake.active || wake.at !== undefined) continue;
      stores.chats.delete(id);
      stores.used.delete(id);
      const closed: Promise<void> = (async () => {
        await host.close();
        await service.host(id.split(":")[0]).harness.commit(async tx => {
          const index = await tx.doc(Chats);
          if (index.open?.[id]) { const { [id]: _settled, ...open } = index.open; index.open = open; }
        }, context);
      })().catch(error => reportError(`[${id}] Could not close an idle chat store:`, error))
        .finally(() => { if (stores.closing.get(id) === closed) stores.closing.delete(id); });
      stores.closing.set(id, closed);
      await closed;
    }
  }

  const foregroundWork = (task: TaskInspection) =>
    !sleepingReminder(namespace, task) && (task.record.kind !== scheduleTaskKind(namespace) || task.state.kind !== "sleeping");
  class ChatService {
    users?: Users;
    readonly hosts = new Map<string, AgentHost>();
    readonly agents: LoadedAgent[];
    readonly demo: boolean;
    readonly calendars = new Map<string, ReturnType<typeof createSchedules>>();
    readonly enabled = new Set<string>();
    private constructor(agents: LoadedAgent[], demo: boolean, readonly initialize?: ChatInitializer) { this.agents = agents; this.demo = demo; }

    static attach(options: { agents: LoadedAgent[]; hosts: Map<string, AgentHost>; demo?: boolean; initialize?: ChatInitializer; models?: Models }) {
      const service = new ChatService(options.agents, options.demo ?? false, options.initialize);
      if (options.models) modelCatalogs.set(service, options.models);
      for (const [id, host] of options.hosts) service.hosts.set(id, host);
      return service;
    }

    static async open(options: {
      root: string; stateRoot: string; demo: boolean; names?: string[]; extensions?: Extension[];
      /** Definitions already loaded by this host, including explicit preview tool bindings. */
      agents?: LoadedAgent[];
      replySink?: ReplySink; updateDefinitions?: boolean | "when-idle"; models: Models; initialize?: ChatInitializer;
      resume?: boolean;
      /** The host starts recovery after its adapters and bindings are ready. */
      deferResume?: boolean;
      /** Calendar policy only; native admitted tasks still recover. */
      schedules?: boolean;
      cwd?: string;
      env?: OpenOptions["env"];
      workspace?: OpenOptions["workspace"];
      definitionResources?: OpenOptions["definitionResources"];
      reviewActions?: OpenOptions["reviewActions"];
      storage?: StorageFactory;
      settings?: OpenOptions["settings"];
      /** Trusted host binding, applied recursively to primaries and their private children before opening stores. */
      prepareAgent?: (agent: LoadedAgent) => LoadedAgent | Promise<LoadedAgent>;
      artifacts?: ArtifactOptions;
    }) {
      const stateRoot = resolve(options.stateRoot);
      const prepare = async (definition: LoadedAgent): Promise<LoadedAgent> => {
        const agent = options.prepareAgent ? await options.prepareAgent(definition) : definition;
        return { ...agent,
          ...(agent.delegateAgents ? { delegateAgents: await Promise.all(agent.delegateAgents.map(prepare)) } : {}),
          ...(agent.handoffAgent ? { handoffAgent: await prepare(agent.handoffAgent) } : {}),
        };
      };
      const definitions = options.agents ?? await Promise.all((options.names?.length ? options.names :
        (await catalog(options.root)).filter(entry => entry.runnable).map(entry => entry.id)).map(name => loadAgent(options.root, name)));
      const agents = await Promise.all(definitions.map(prepare));
      const service = new ChatService(agents, options.demo, options.initialize);
      const enabled = options.schedules === false ? [] : await enabledAgents(options.root);
      for (const id of enabled) service.enabled.add(id);
      for (const agent of agents) for (const recipient of agent.messages ?? []) {
        if (!agents.some(candidate => candidate.id === recipient)) {
          throw new Error(`${agent.id} messages ${recipient}; include both agents in this service's names.`);
        }
      }
      const models = options.models;
      modelCatalogs.set(service, models);
      if (!options.demo && agents.some(agent => !models.getProvider(agent.model.provider))) throw new Error("Register every agent's provider in the supplied Models catalog.");
      try {
        await privateStateDirectory(stateRoot);
        // An agent's own store and each of its chats' stores open the same way, with the same capabilities.
        const openStore = (agent: LoadedAgent, directory: string, chat?: string) => openAgent({
          agent, directory, chat, models,
          execution: options.demo ? "demo" : "live",
          extensions: [...(options.extensions ?? []),
            ...(agent.messages?.length ? [instanceMessagingExtension(namespace, agent, service)] : [])],
          replySink: options.replySink, updateDefinitions: options.updateDefinitions,
          registryExtensions: [service.calendars.get(agent.id)!.extension],
          cwd: options.cwd, env: options.env, storage: options.storage, settings: options.settings,
          // The host's record of running workspaces sits beside its stores.
          workspace: options.workspace && { ...options.workspace, ledger: join(stateRoot, "workspaces.json") },
          definitionResources: options.definitionResources, reviewActions: options.reviewActions,
          artifacts: options.artifacts,
        });
        storesOf(service).open = (agent, chat) => openStore(agent, join(stateRoot, agent.id, "chats", chatNumber(chat.id)), chat.id);
        storesOf(service).refusal = options.storage?.refusesChats;
        const results = await Promise.allSettled(agents.map(async agent => {
          service.calendars.set(agent.id, createSchedules(namespace, agent, service, options.resume !== false));
          service.hosts.set(agent.id, await openStore(agent, join(stateRoot, agent.id)));
        }));
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        for (const [agent, host] of service.hosts) {
          const index = await host.harness.snapshot(Chats, context);
          if (index && index.layout !== 2 && Object.keys(index.byId).length) {
            throw new Error(`${join(stateRoot, agent)} holds chats saved by an earlier Dispatch. Each chat now has its own store, and earlier chats are not converted. Move ${stateRoot} aside or choose a new stateRoot to start fresh.`);
          }
        }
        const sweep = storesOf(service).sweep = setInterval(() => { void closeIdle(service); }, idleCloseMs / 2);
        sweep.unref();
        if (options.resume !== false) {
          for (const agent of agents) await service.calendars.get(agent.id)!.reconcile(service.host(agent.id), enabled.includes(agent.id));
        }
        if (options.resume !== false && !options.deferResume) await service.start();
        return service;
      } catch (error) { await service.close(); throw error; }
    }

    host(agent: string) {
      const host = this.hosts.get(agent);
      if (!host) throw new Error(`Agent not served: ${agent}`);
      return host;
    }

    async start() {
      await this.resume();
      for (const agent of this.agents) {
        if (this.enabled.has(agent.id) && agent.trigger.mode !== "manual") await this.host(agent.id).start();
      }
    }

    /** Enable scheduling in every agent's own store, in the chats left with unsettled work, and in chat stores opened later. */
    async resume() {
      storesOf(this).started = true;
      for (const host of this.hosts.values()) host.harness.resume();
      for (const host of this.hosts.values()) {
        const index = await host.harness.snapshot(Chats, context);
        for (const id of Object.keys(index?.open ?? {})) if (index!.byId[id]) await chatStore(this, index!.byId[id]);
      }
      for (const { host } of await this.stores()) host.harness.resume();
    }

    /** Call `listener` whenever a chat's store opens. A channel adapter attaches its per-chat work there. Returns a function that stops the calls. */
    onChatOpen(listener: (chat: Chat, host: AgentHost) => void | Promise<void>) {
      const { opened } = storesOf(this);
      opened.add(listener);
      return () => { opened.delete(listener); };
    }

    /** Every open store: each agent's own, then each open chat's. A closed chat store holds no runnable work. */
    async stores() {
      const chats = await Promise.all([...storesOf(this).chats].map(async ([id, opened]) => {
        const host = await opened.catch(() => undefined);
        return host ? [{ agent: id.split(":")[0], chat: id, host }] : [];
      }));
      return [...[...this.hosts].map(([agent, host]) => ({ agent, chat: undefined as string | undefined, host })), ...chats.flat()];
    }

    async schedules() {
      return (await Promise.all([...this.calendars].map(([id, calendar]) => calendar.inspect(this.host(id))))).flat();
    }

    async busy() {
      return (await Promise.all((await this.stores()).map(async ({ host }) => {
        const state = await host.harness.inspect(context);
        return state.submissions.length > 0 || state.tasks.some(foregroundWork);
      }))).some(Boolean);
    }

    /** Drain already-admitted native work, including peer replies, before an on-demand host exits. */
    async waitForIdle(signal?: AbortSignal) {
      let revision = 0;
      let wake: (() => void) | undefined;
      const observed = new Map<AgentHost, { detach(): void }>();
      const unsubscribe = { [Symbol.iterator]: () => observed.values() };
      try {
        while (true) {
          signal?.throwIfAborted();
          // A delivery can open another chat's store while this waits; its opening commit advances a watched store.
          const hosts = (await this.stores()).map(store => store.host);
          for (const host of hosts) if (!observed.has(host)) observed.set(host, host.harness.observeCommits({ advance: () => {
            revision++; wake?.();
          }, end: () => { revision++; wake?.(); } }));
          const seen = revision;
          const states = await Promise.all(hosts.map(host => host.harness.inspect(context)));
          if (revision !== seen) continue;
          const tasks = states.flatMap(state => state.tasks).filter(foregroundWork);
          const submissions = states.flatMap(state => state.submissions);
          if (!tasks.length && !submissions.length) return;
          const blocked = tasks.find(task => task.state.kind === "blocked");
          if (blocked) throw new Error(`Native task ${blocked.record.id} is blocked; inspect saved session activity before resuming.`);
          if (!tasks.length) throw new Error("Saved input is held without an active task; inspect session history before resuming.");
          await new Promise<void>((resolve, reject) => {
            const finish = () => { signal?.removeEventListener("abort", abort); wake = undefined; resolve(); };
            const abort = () => { wake = undefined; reject(signal?.reason); };
            wake = finish;
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            else if (revision !== seen) finish();
          });
        }
      } finally { for (const observation of unsubscribe) observation.detach(); }
    }

    /** Unfinished is not necessarily executing: failed runs may retain queued input. */
    async activity() {
      const hosts = await Promise.all((await this.stores()).map(async ({ agent, chat, host }) => {
        const state = await host.harness.inspect(context);
        const tasks = state.tasks.filter(foregroundWork);
        const ids = new Set([...tasks.map(task => task.record.conversationId), ...state.submissions.map(item => item.conversationId)]);
        const conversations = await Promise.all([...ids].map(async id => {
          const live = await host.harness.snapshot(LiveDoc, id, context);
          const pending = state.submissions.filter(item => item.conversationId === id);
          const work = tasks.filter(task => task.record.conversationId === id);
          // Other conversations are private children of a chat, or an agent's own scheduled work.
          return { id: chat && id === ROOT_CONVERSATION_ID ? chat : `${chat ?? agent}/${id}`,
            queued: pending.filter(item => item.status === "queued").length,
            held: pending.length > 0 && work.length === 0,
            tasks: work.map(task => ({ id: task.record.id, kind: task.record.kind, state: task.state.kind })),
            ...(live?.compactions?.length ? { compactions: live.compactions } : {}),
            ...(live?.compactionFailure ? { compactionFailure: live.compactionFailure } : {}) };
        }));
        return { agent, ...(chat ? { chat } : {}), scheduling: state.scheduling, conversations, busy: tasks.length > 0 || state.submissions.length > 0 };
      }));
      return { busy: hosts.some(host => host.busy), hosts };
    }

    async list(): Promise<Chat[]> {
      const lists = await Promise.all([...this.hosts.values()].map(async host =>
        Object.values((await host.harness.snapshot(Chats, context))?.byId ?? {})));
      return lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    async watchList(listener: (chats: Chat[]) => Promise<void>) {
      const watches = await Promise.all([...this.hosts.values()].map(async host => {
        await host.harness.commit(async tx => { await tx.doc(Chats); }, context);
        return host.harness.watchDoc(Chats, context);
      }));
      let pending = Promise.resolve();
      const changed = () => pending = pending.then(async () => listener(await this.list()));
      for (const watch of watches) watch?.start(changed);
      await changed();
      return { stop: async () => { await Promise.all(watches.map(watch => watch?.stop())); await pending; } };
    }

    async create(agent: string, source: Chat["source"], key: string, title = "New chat", origin?: JsonObject): Promise<Chat> {
      // A host that could never open the chat's store saves nothing for it: no list entry and no reopen mark.
      const { open, refusal } = storesOf(this);
      if (refusal || !open) throw new Error(refusal ?? "This service was attached to stores it did not open and cannot create a chat.");
      const created = await this.host(agent).harness.commit(async tx => {
        const index = await tx.doc(Chats);
        const existing = index.keys[key];
        if (existing) {
          const chat = index.byId[existing];
          if (origin && chat.origin && !isDeepStrictEqual(origin, chat.origin)) throw new Error("Conversation already has a different origin.");
          const adopted = !!origin && !chat.origin;
          if (adopted) chat.origin = origin;
          return { chat: JSON.parse(JSON.stringify(chat)) as Chat, adopted };
        }
        const number = (index.next ?? 0) + 1;
        const chat: Chat = {
          id: `${agent}:${number}`, agent, conversationId: ROOT_CONVERSATION_ID,
          source, ...(origin ? { origin } : {}), title: title.trim().slice(0, 120) || "New chat", createdAt: new Date().toISOString(),
        };
        index.next = number;
        index.layout = 2;
        index.byId[chat.id] = chat;
        index.keys[key] = chat.id;
        return { chat, adopted: false };
      }, context);
      // Opening the store configures the chat's conversation. A crash before this leaves an entry that the next use opens.
      const host = await chatStore(this, created.chat);
      if (created.adopted) await host.harness.commit(async tx => {
        (await tx.doc(Identity)).origin = created.chat.origin;
        await this.initialize?.(tx, created.chat, host);
      }, context);
      return created.chat;
    }

    async find(agent: string, key: string) {
      const index = await this.host(agent).harness.snapshot(Chats, context);
      const id = index?.keys[key];
      return id ? index!.byId[id] : undefined;
    }

    /** The chat's entry, its open store and its conversation. Use the store for this operation; an idle one closes later. */
    async resolve(id: string) {
      const chat = (await this.host(id.split(":")[0]).harness.snapshot(Chats, context))?.byId[id];
      if (!chat) throw new Error("Unknown conversation.");
      const host = await chatStore(this, chat);
      return { host, chat, conversation: host.conversation };
    }

    /** Commit in the chat's own store. `conversationId` is the chat's conversation there. */
    async inChat<T>(id: string, change: (tx: Tx, conversationId: ConversationId) => T | Promise<T>): Promise<T> {
      const { conversation } = await this.resolve(id);
      return conversation.commit(tx => change(tx, conversation.id), context);
    }

    async rename(id: string, title: string) {
      await this.host(id.split(":")[0]).harness.commit(async tx => {
        const chat = (await tx.doc(Chats)).byId[id];
        if (!chat) throw new Error("Unknown conversation.");
        chat.title = title.trim().slice(0, 120) || "New chat";
      }, context);
    }

    /** Shared validation for client commands and host-side durable channel tasks.
     * Tasks can commit the resulting draft with their delivery receipt in one native transaction. */
    async prepareInput(id: string, text: string, requestId: string, options: {
      source?: string; mode?: "followUp" | "steer"; files?: AttachmentFile[];
      metadata?: JsonObject; continuation?: boolean; identity?: UserIdentity; audience?: UserIdentity[];
    } = {}): Promise<SubmissionDraft> {
      const { source = "web", mode = "followUp", files = [], metadata = {}, continuation = false } = options;
      const original = prepareContent(text, files);
      if (typeof requestId !== "string" || !requestId.trim()) throw new Error("A request ID is required.");
      if (typeof source !== "string" || !source.trim()) throw new Error("A source is required.");
      const { chat } = await this.resolve(id);
      if (files.some(file => file.mimeType.startsWith("image/"))) {
        const agent = this.agents.find(agent => agent.id === chat.agent)!;
        if (!modelCatalogs.get(this)?.getModel(agent.model.provider, agent.model.id)?.input.includes("image"))
          throw new ContentError("This authored model does not accept images. Remove the image or choose an image-capable agent.");
      }
      const sender = !continuation && this.users?.attribution(chat.agent, source, options.identity, options.audience);
      const content = !sender ? original : typeof original === "string" ? `${sender.label}:\n${original}`
        : [{ type: "text" as const, text: sender.label + ":" }, ...original];
      const internal = source === "agent" || source === "schedule";
      return {
        type: "input", content, requestId, whenBusy: continuation ? "reject" : internal ? mode : "steer",
        entry: { kind: `${namespace}.message`, data: { ...metadata, ...(sender ? { ...sender.data, text: metadata.text ?? text } : {}), source,
          actor: continuation || source === "schedule" ? "runtime" : source === "agent" ? "agent" : "user",
          ...(files.length ? { text: metadata.text ?? text, attachments: files } : {}) } },
      };
    }

    async submit(id: string, text: string, requestId: string, mode: "followUp" | "steer" = "followUp", source: Chat["source"] = "web", files: AttachmentFile[] = [], identity?: UserIdentity) {
      return admit(this, id, async () => {
        const draft = await this.prepareInput(id, text, requestId, { mode, source, files, identity });
        const { chat, conversation } = await this.resolve(id);
        const submission = await conversation.submit(draft, context);
        if (chat.title === "New chat") await this.rename(id, text || files[0]?.name || "Attachment");
        return { submissionId: submission.id };
      });
    }

    async receipt(id: string, submissionId: number) {
      const { host, conversation } = await this.resolve(id);
      const submission = await host.harness.submission(submissionId as SubmissionId, context);
      const record = await submission?.status(context);
      if (!record || record.conversationId !== conversation.id) throw new Error("Unknown submission.");
      return record;
    }

    async wait(id: string, submissionId: number, signal?: AbortSignal) {
      const { host, conversation } = await this.resolve(id);
      const ctx = signal ? withAbortSignal(signal, context) : context;
      const submission = await host.harness.submission(submissionId as SubmissionId, ctx);
      const record = await submission?.status(ctx);
      if (!record || record.conversationId !== conversation.id) throw new Error("Unknown submission.");
      return submission!.wait(ctx);
    }

    async message(from: string, message: InstanceMessage, requestId: string) {
      return messaging(this, from).send(from, message, requestId, context);
    }

    async messageStatus(from: string, taskId: number) {
      return messaging(this, from).status(from, taskId, context);
    }

    async agentInstances(from: string) {
      return messaging(this, from).instances(from);
    }

    async waitForAgent(from: string, taskId: number, signal?: AbortSignal) {
      return messaging(this, from).wait(from, taskId, signal ? withAbortSignal(signal, context) : context);
    }

    async stop(id: string) {
      await admit(this, id, async () => {
        const { host, conversation } = await this.resolve(id);
        await recordRequestCancellation(host.harness, conversation.id, context);
        await conversation.abort(context, { background: true });
        // Include a child or first request record created while native abort was taking effect.
        await recordRequestCancellation(host.harness, conversation.id, context);
      });
    }

    async compact(id: string, instructions?: string) {
      if (instructions !== undefined && typeof instructions !== "string") throw new Error("Compaction instructions must be text.");
      const { conversation } = await this.resolve(id);
      return { taskId: await conversation.compact(instructions, context) };
    }

    async watch(id: string, listener: (snapshot: ChatSnapshot) => Promise<void>) {
      const { host, conversation } = await this.resolve(id);
      const { watched, used } = storesOf(this);
      watched.set(id, (watched.get(id) ?? 0) + 1);
      let watching = true;
      const unwatch = () => {
        if (!watching) return;
        watching = false;
        const others = watched.get(id)! - 1;
        if (others) watched.set(id, others); else watched.delete(id);
        used.set(id, Date.now());
      };
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
        // Coalesced watch calls can skip past the transcript window. Fill that
        // gap from native history before combining it with the newest frame.
        if (view.before !== undefined && !saved.has(view.before)) {
          let cursor: Cursor | undefined;
          do {
            const page = await conversation.entries({ maxEntryId: view.before }, 250, cursor, context);
            for (const entry of page.items) saved.set(entry.id, entry);
            cursor = page.next;
          } while (cursor);
        }
        for (const entry of view.entries) saved.set(entry.id, entry);
        const { chat } = await this.resolve(id);
        const live = view.docs["pi.live"] as unknown as LiveState | undefined;
        const inbox = view.docs["pi.inbox"] as { items?: unknown[] } | undefined;
        // Pi's structural view mounts only its built-in documents.
        const handoffs = handoffWatch?.value;
        const inspection = await host.harness.inspect(context);
        const toolTasks: TaskRecord<unknown, unknown, unknown>[] = [];
        let toolCursor: Cursor | undefined;
        do {
          const page = await host.storage.scanTasks({conversationId: conversation.id, kind:"pi.tool"}, 250, toolCursor, context);
          toolTasks.push(...page.items); toolCursor = page.next;
        } while (toolCursor);
        const submissions = [];
        let submissionCursor: Cursor | undefined;
        do {
          const page = await host.storage.scanSubmissions({ conversationId: conversation.id }, 250, submissionCursor, context);
          submissions.push(...page.items); submissionCursor = page.next;
        } while (submissionCursor);
        const deliveries = inspection.tasks.some(({ record }) =>
          record.conversationId === conversation.id && record.kind === `${namespace}.instance-message`);
        return {
          chat, messages: projectChatMessages(namespace, [...saved.values()].sort((a, b) => a.id - b.id)),
          toolCalls: projectChatTools([...saved.values()], live, toolTasks),
          turns: projectChatTurns(submissions),
          running: !!live?.run, queued: inbox?.items?.length ?? 0,
          partial: messageText(live?.generation?.message?.content),
          partialThinking: messageThinking(live?.generation?.message?.content),
          tools: live?.tools?.filter(tool => tool.status !== "done").map(tool => tool.name) ?? [],
          error: live?.generation?.retry?.error ?? live?.compactionFailure?.error ?? null, demo: this.demo,
          ...(live?.compactions?.length ? { compactions: live.compactions } : {}),
          ...(live?.compactionFailure ? { compactionFailure: live.compactionFailure } : {}),
          ...(live?.generation?.retry ? { retry: { attempt: live.generation.attempt, ...live.generation.retry } } : {}),
          background: deliveries || Object.values(handoffs?.jobs ?? {}).some(job => job.status === "working"),
        } satisfies ChatSnapshot;
      };
      let pending = Promise.resolve();
      const notify = (view: ConversationView) => {
        pending = pending.then(async () => { await listener(await project(view)); });
        return pending;
      };
      const stop = async () => {
        try {
          await Promise.all([watch.stop(), handoffWatch?.stop()]);
          await pending;
        } finally { unwatch(); }
      };
      try {
        await notify(watch.value);
        watch.start(async call => { if (call.kind === "value") await notify(call.value); });
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

    async artifact(id: string, artifactId: string) {
      const { host, conversation } = await this.resolve(id);
      const record = (await host.harness.snapshot(Artifacts, conversation.id, context))?.records[artifactId];
      if (!record) throw new Error("Unknown artifact in this conversation.");
      return { artifact: record, bytes: await host.artifacts.read(conversation.id, record) };
    }

    async close() {
      const open = storesOf(this);
      clearInterval(open.sweep);
      await Promise.allSettled(open.closing.values());
      const chats = (await this.stores()).filter(store => store.chat);
      const settled = chats.filter(({ host }) => { const wake = host.harness.wake(); return !wake.active && wake.at === undefined; });
      const results = await Promise.allSettled(chats.map(({ host }) => host.close()));
      open.chats.clear();
      // A chat with nothing left to do needs no reopening; any other keeps its mark for the next start.
      for (const [agent, host] of this.hosts) {
        const ids = settled.filter(store => store.agent === agent).map(store => store.chat!);
        if (ids.length) await host.harness.commit(async tx => {
          const index = await tx.doc(Chats);
          index.open = Object.fromEntries(Object.entries(index.open ?? {}).filter(([id]) => !ids.includes(id)));
        }, context).catch(error => reportError(`[${agent}] Could not record settled chats:`, error));
      }
      results.push(...await Promise.allSettled([...this.hosts.values()].map(host => host.close())));
      this.hosts.clear();
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  }

  return { Chats, ChatIdentity: Identity, ChatService };
}

export type ChatService = ReturnType<ReturnType<typeof createChats>["ChatService"]["attach"]>;
