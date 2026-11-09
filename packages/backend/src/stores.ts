import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import type { Chat, ChatMessage, Snapshot, SourceStatus } from "./contracts.js";
import type { Config, Source } from "./config.js";

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
export interface Conversation {
  key: string;
  agent: string;
  conversationId: number;
  title: string;
  parentKey?: string;
  active: number;
  status: string;
  activity: string;
  startedAt?: number;
  currentTools?: { title: string }[];
}
export interface Selection {
  chat: Chat;
  run: Run;
  store: Store;
  conversation: Conversation;
  source: Source;
}
export interface Reader {
  discoverWatchRuns(options: {
    stateRoot: string;
    session?: string;
  }): Promise<{ runs: Run[]; issues: string[] }>;
  readWatchRun(
    run: Run,
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
export function readStore<T>(path: string, read: (db: DatabaseSync) => T): T {
  // No immutable=1: a live owner's committed WAL is part of the history.
  if (realpathSync(path) !== path)
    throw new Error(
      "Native store path was redirected; refresh configured sources.",
    );
  for (const [target, directory] of [
    [dirname(dirname(path)), true],
    [dirname(path), true],
    [path, false],
  ] as const) {
    const info = lstatSync(target);
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Read only owned regular native store paths, without symlinks.",
      );
  }
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    return read(db);
  } finally {
    db.close();
  }
}
export function provenance(
  kind: string | undefined,
  data: any,
  namespace: string,
): Pick<ChatMessage, "provenance" | "author"> {
  if (
    kind === `${namespace}.message` &&
    ["web", "cli", "slack", "google-chat", "phone", "email"].includes(
      data?.source,
    )
  )
    return { provenance: "user" };
  if (kind === `${namespace}.instance-message`)
    return { provenance: "agent", author: data?.from ?? "Agent message" };
  return { provenance: "runtime" };
}
export function createStores(config: Config, reader: Reader) {
  let selections = new Map<string, Selection>();
  let statuses: SourceStatus[] = [];
  let pending: Promise<void> | undefined;
  let observedAt = 0;
  async function discover() {
    const next = new Map<string, Selection>();
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
        if (!(await stat(root)).isDirectory())
          throw new Error("Not a directory.");
        status.path = root;
        const sessions = new Set<string>();
        // Walk configured roots only. Native discovery requires an explicit session
        // for retained (non-running) stores; enumerate those keys without a cap.
        async function walk(path: string) {
          let entries;
          try {
            entries = await readdir(path, { withFileTypes: true });
          } catch {
            status.issues.push(
              `Cannot read ${relative(root, path) || "."}. Check directory permissions, then refresh.`,
            );
            return;
          }
          if (entries.some((item) => item.name === "session.sqlite")) {
            sessions.add(
              relative(root, dirname(path)).split("\\").join("/") || ".",
            );
            return;
          }
          for (const entry of entries)
            if (
              entry.isDirectory() &&
              !entry.isSymbolicLink() &&
              /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry.name)
            )
              await walk(join(path, entry.name));
        }
        await walk(root);
        for (const session of sessions) {
          const discovery = await reader.discoverWatchRuns({
            stateRoot: root,
            session,
          });
          status.issues.push(...discovery.issues);
          for (const run of discovery.runs) {
            // Canonical file identity also deduplicates overlapping configured roots.
            run.stores = run.stores.filter((store) => !seen.has(store.path));
            for (const store of run.stores) seen.add(store.path);
            if (!run.stores.length) continue;
            const snapshot = await reader.readWatchRun(run);
            status.issues.push(...snapshot.issues);
            for (const conversation of snapshot.conversations) {
              const store = run.stores.find(
                (item) => item.agent === conversation.agent,
              )!;
              const id = identity(store.path, conversation.conversationId);
              const chat: Chat = {
                id,
                agent: conversation.agent,
                conversationId: conversation.conversationId,
                title: conversation.title,
                source: source.id,
                sourceLabel: source.label,
                session: run.session,
                createdAt: new Date(conversation.startedAt ?? 0).toISOString(),
                ...(conversation.parentKey
                  ? {
                      parentId: identity(
                        store.path,
                        Number(conversation.parentKey.split(":").at(-1)),
                      ),
                    }
                  : {}),
              };
              next.set(id, { chat, store, run, conversation, source });
            }
          }
        }
        if (!sessions.size)
          status.issues.push(
            "No native session.sqlite stores found. Choose an existing instances directory; new sessions are created only by New conversation.",
          );
      } catch (error) {
        status.issues.push(
          `Cannot read configured source: ${(error as Error).message} Check the path/permissions in DISPATCH_CONFIG and restart.`,
        );
      }
    }
    selections = next;
    observedAt = Date.now();
  }
  const refresh = async (fresh = false) => {
    if (pending) return pending;
    if (!fresh && Date.now() - observedAt < 60000) return;
    pending = discover().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    refresh,
    invalidate: () => {
      observedAt = 0;
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
      const current = await reader.readWatchRun(item.run);
      const conversation = current.conversations.find(
        (value) => value.key === item.conversation.key,
      );
      if (!conversation)
        throw new Error(
          current.issues.join("\n") || "Conversation no longer readable.",
        );
      const pages = [];
      let before: unknown;
      do {
        const page = await reader.readWatchConversation(
          item.run,
          conversation.key,
          before,
        );
        pages.unshift(page.entries);
        before = page.hasEarlier ? page.before : undefined;
      } while (before);
      // Watch deliberately strips entry metadata. Read only kind/source and artifact
      // records from the validated same store, never provider state or reasoning.
      const records = readStore(
        item.store.path,
        (db) =>
          new Map(
            db
              .prepare(
                "SELECT id,json_extract(record,'$.kind') AS kind,json_extract(record,'$.data') AS data FROM entries WHERE conversation_id=?",
              )
              .all(conversation.conversationId)
              .map((row) => [
                Number(row.id),
                {
                  kind: String(row.kind),
                  data: row.data ? JSON.parse(String(row.data)) : {},
                },
              ]),
          ),
      );
      const messages: ChatMessage[] = pages
        .flat()
        .filter((entry) => entry.kind === "message")
        .map((entry) => {
          const record = records.get(entry.entryId);
          return {
            id: entry.id,
            role: entry.role!,
            text: entry.text,
            at: entry.at,
            ...(entry.role === "assistant"
              ? { provenance: "agent" as const }
              : provenance(record?.kind, record?.data, item.store.namespace)),
          };
        });
      for (const [entryId, record] of records) {
        if (record.kind === `${item.store.namespace}.background-reply`)
          messages.push({
            id: `${item.store.agent}:${entryId}:background`,
            role: "assistant",
            provenance: "agent",
            text: record.data.text,
            author: record.data.author,
            background: true,
          });
        if (record.kind === `${item.store.namespace}.artifact`) {
          const { deliveries: _, ...artifact } = record.data;
          messages.push({
            id: `${item.store.agent}:${entryId}:artifact`,
            role: "assistant",
            provenance: "agent",
            text: "",
            artifacts: [artifact],
          });
        }
      }
      messages.sort(
        (a, b) => Number(a.id.split(":")[1]) - Number(b.id.split(":")[1]),
      );
      return {
        chat: item.chat,
        messages,
        running: conversation.active > 0,
        queued: 0,
        partial: "",
        tools: conversation.currentTools?.map((tool) => tool.title) ?? [],
        error: current.issues.join("\n") || null,
        demo: false,
        background: false,
        observation: conversation.activity,
        readOnlyReason: item.store.pids.length
          ? `Owned by native process ${item.store.pids.join(", ")}. Finish/suspend it in its original CLI or service before sending here. History remains available.`
          : undefined,
      };
    },
  };
}
