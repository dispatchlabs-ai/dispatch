import { watch, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { createHash } from "node:crypto";
import type { Chat, Snapshot, SourceStatus } from "./contracts.js";
import type { Source } from "./config.js";

export interface Store {
  agent: string;
  path: string;
  namespace: string;
  pids: number[];
}
export interface Run {
  key: string;
  path: string;
  session: string;
  stores: Store[];
  issues: string[];
}
export interface CatalogConversation {
  key: string;
  agent: string;
  conversationId: number;
  title: string;
  parentKey?: string;
  startedAt?: number;
  registered?: boolean;
  transport?: string;
}
export interface Conversation extends CatalogConversation {
  active: number;
  status: string;
  activity: string;
  currentTools?: { title: string }[];
}
export interface Selection {
  chat: Chat;
  run: Run;
  store: Store;
  conversation: CatalogConversation;
  source: Source;
}
export interface Reader {
  discoverWatchRuns(options: {
    stateRoot: string;
    session?: string;
    saved?: boolean;
  }): Promise<{ runs: Run[]; issues: string[] }>;
  readWatchChatProjection(run: Run, key: string): Promise<Pick<Snapshot, "messages" | "toolCalls" | "turns">>;
  readWatchStates(run: Run): Promise<{ key: string; status: Chat["activity"] }[]>;
  readWatchCatalog(run: Run): Promise<{ conversations: CatalogConversation[]; issues: string[] }>;
  readWatchRun(
    run: Run,
    key?: string,
  ): Promise<{ conversations: Conversation[]; issues: string[] }>;
  readWatchConversation(
    run: Run,
    key: string,
    before?: unknown,
  ): Promise<{
    entries: {
      id: string;
      entryId: number;
      kind: string;
      role?: string;
      text: string;
      at?: number;
    }[];
    hasEarlier: boolean;
    before?: unknown;
  }>;
}
export const identity = (path: string, id: number) =>
  createHash("sha256").update(`${path}\0${id}`).digest("base64url");
function catalogChat(conversation: CatalogConversation, store: Store, run: Run, source: Source): Chat {
  const id = identity(store.path, conversation.conversationId);
  return {
    id,
    agent: conversation.agent,
    conversationId: conversation.conversationId,
    title: conversation.title,
    source: source.id,
    sourceLabel: source.label,
    session: run.session,
    createdAt: new Date(conversation.startedAt ?? 0).toISOString(),
    addressable: conversation.registered === true,
    ...(conversation.transport
      ? { transport: conversation.transport as Chat["transport"] } : {}),
    ...(conversation.parentKey
      ? { parentId: identity(store.path, Number(conversation.parentKey.split(":").at(-1))) }
      : {}),
  };
}
export function createStores(config: { sources: Source[] }, reader: Reader) {
  let selections = new Map<string, Selection>();
  let statuses: SourceStatus[] = [];
  let inventory = new Map<Run, Source>();
  let pending: Promise<void> | undefined;
  let observedAt = 0;
  let invalidated = true;
  let catalogChanged = false;
  let catalogObservedAt = 0;
  const watchers = new Map<string, FSWatcher>();
  let watchUnavailable = false;
  async function discover() {
    invalidated = false;
    const next = new Map<string, Selection>();
    const discovered = new Map<Run, Source>();
    const seen = new Set<string>();
    statuses = [];
    for (const source of config.sources) {
      const status: SourceStatus = {
        id: source.id,
        label: source.label,
        issues: [],
      };
      statuses.push(status);
      try {
        const root = await realpath(source.path);
        status.path = root;
        if (!watchers.has(root)) {
          try {
            const observer = watch(root, { recursive: true }, (event, path) => {
              if (event === "rename" || String(path).endsWith("status.json")) invalidated = true;
              else if (/session\.sqlite(?:-wal)?$/.test(String(path))) catalogChanged = true;
            });
            observer.on("error", () => { invalidated = true; watchUnavailable = true; });
            watchers.set(root, observer);
          } catch { watchUnavailable = true; }
        }
        const excluded = await Promise.all((source.exclude ?? []).map(path => realpath(path)));
        const discovery = await reader.discoverWatchRuns({ stateRoot: root, saved: true });
        status.issues.push(...discovery.issues);
        for (const run of discovery.runs) {
          if (excluded.some(path => {
            const child = relative(path, run.path);
            return !child || child !== ".." && !child.startsWith("../") && !isAbsolute(child);
          })) continue;
          status.issues.push(...run.issues);
          // Canonical file identity also deduplicates overlapping configured roots.
          run.stores = run.stores.filter((store) => !seen.has(store.path));
          for (const store of run.stores) seen.add(store.path);
          if (!run.stores.length) continue;
          discovered.set(run, source);
          const snapshot = await reader.readWatchCatalog({ ...run, issues: [] });
          status.issues.push(...snapshot.issues);
          for (const conversation of snapshot.conversations) {
            const store = run.stores.find(
              (item) => item.agent === conversation.agent,
            )!;
            const chat = catalogChat(conversation, store, run, source);
            next.set(chat.id, { chat, store, run, conversation, source });
          }
        }
        if (!discovery.runs.length && !discovery.issues.length)
          status.issues.push(
            "No native session.sqlite stores found. Choose an existing instances directory; new sessions are created only by New conversation.",
          );
      } catch (error) {
        watchUnavailable = true;
        status.issues.push(
          `Cannot read configured source: ${(error as Error).message} Check the path/permissions in DISPATCH_CONFIG and restart.`,
        );
      }
    }
    selections = next;
    inventory = discovered;
    observedAt = Date.now();
  }
  const refresh = async (fresh = false) => {
    if (pending) return pending;
    if (!fresh && !invalidated && (!watchUnavailable || Date.now() - observedAt < 5000)) {
      // Some native filesystems coalesce WAL notifications. Refresh known
      // catalogs on the shared observation cadence even without a file event.
      if (!catalogChanged && Date.now() - catalogObservedAt < 2000) return;
      catalogChanged = false;
      catalogObservedAt = Date.now();
      pending = (async () => {
        // A valid empty store must remain discoverable when its first chat is
        // committed to an already-existing WAL, without a rename/status event.
        for (const [run, source] of inventory) {
          const catalog = await reader.readWatchCatalog(run);
          if (catalog.issues.length) { invalidated = true; continue; }
          for (const conversation of catalog.conversations) {
            const store = run.stores.find(store => store.agent === conversation.agent)!;
            const fresh = catalogChat(conversation, store, run, source);
            const previous = selections.get(fresh.id);
            // Keep the first observed creation time; index metadata may arrive later.
            const chat: Chat = previous ? { ...fresh, createdAt: previous.chat.createdAt } : fresh;
            selections.set(chat.id, { chat, store, run, conversation, source });
          }
        }
      })().finally(() => { pending = undefined; });
      return pending;
    }
    pending = discover().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  /** Complete a discovery that starts after this call. An in-flight pass may predate
   * a just-created store, so wait it out rather than reusing its result. */
  const sync = async () => {
    // Loop: another caller may start a catalog-only pass between the await and here.
    while (pending) await pending.catch(() => {});
    pending = discover().finally(() => { pending = undefined; });
    await pending;
  };
  return {
    refresh,
    sync,
    close: () => { for (const observer of watchers.values()) observer.close(); watchers.clear(); },
    summary: async (): Promise<Chat[]> => {
      await refresh();
      const runs = new Map<Run, Selection[]>();
      for (const item of selections.values()) { const group = runs.get(item.run) ?? []; group.push(item); runs.set(item.run, group); }
      const result: Chat[] = [];
      for (const [run, items] of runs) {
        try {
          const observed = await reader.readWatchStates(run);
          for (const item of items) {
            const current = observed.find(value => value.key === item.conversation.key);
            result.push({ ...item.chat, activity: current?.status ?? "unavailable" });
          }
        } catch { result.push(...items.map(item => ({ ...item.chat, activity: "unavailable" as const }))); }
      }
      return result;
    },
    invalidate: () => {
      invalidated = true;
    },
    statuses: async () => {
      await refresh();
      return statuses;
    },
    list: async () => {
      await refresh();
      return [...selections.values()]
        .map((item) => item.chat)
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
        );
    },
    has: async (id: string) => {
      if (!selections.has(id)) await refresh();
      return selections.has(id);
    },
    get: async (id: string) => {
      if (!selections.has(id)) await refresh();
      const item = selections.get(id);
      if (!item)
        throw new Error(
          "Conversation unavailable. Refresh sources and check their reported errors.",
        );
      return item;
    },
    snapshot: async (id: string): Promise<Snapshot> => {
      if (!selections.has(id)) await refresh();
      const item = selections.get(id);
      if (!item)
        throw new Error(
          "Conversation unavailable. Refresh sources and check their reported errors.",
        );
      const current = await reader.readWatchRun({ ...item.run, stores: [item.store] }, item.conversation.key);
      const conversation = current.conversations.find(
        (value) => value.key === item.conversation.key,
      );
      if (!conversation)
        throw new Error(
          current.issues.join("\n") || "Conversation no longer readable.",
        );
      const projected = await reader.readWatchChatProjection(item.run, conversation.key);
      return {
        chat: item.chat,
        ...projected,
        activity: conversation.status as Chat["activity"],
        running: conversation.status === "working",
        queued: 0,
        partial: "",
        tools: conversation.currentTools?.map((tool) => tool.title) ?? [],
        error: current.issues.join("\n") || null,
        demo: false,
        background: false,
        observation: conversation.activity,
        ...(item.conversation.parentKey ? { readOnly: "worker" as const, readOnlyReason: "Worker conversation run by a task. Steer its parent." }
          : !item.conversation.registered ? { readOnly: "internal" as const, readOnlyReason: "Internal service conversation." }
          : item.store.pids.length ? { readOnly: "owner" as const, readOnlyReason: `Owned by native process ${item.store.pids.join(", ")}. Send from that process's CLI.` }
          : {}),
      };
    },
  };
}
