import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import type { Chat, ChatMessage, Snapshot, SourceStatus } from "./contracts.js";
import { AdmissionError } from "./config.js";
import type { LocalConfig, Source } from "./config.js";

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
  readWatchChatProjection(run: Run, key: string): Promise<Pick<Snapshot, "messages" | "toolCalls">>;
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
// Read the native session document format for admission only. No writes, invented
// chat-index admission, migrations or copied history. Unknown formats fail closed.
export function sessionDocument(path: string, kind: string): any {
  return readStore(path, (db) => {
    const doc = db
      .prepare("SELECT id FROM documents WHERE kind=? AND scope_kind='session'")
      .get(JSON.stringify(kind));
    if (!doc)
      throw new AdmissionError(
        `Missing ${kind} metadata. Recover with the original native runtime.`,
      );
    const rows = db
      .prepare(
        "SELECT kind,version,content FROM document_revisions WHERE document_id=? AND seq>=COALESCE((SELECT MAX(seq) FROM document_revisions WHERE document_id=? AND kind='base'),0) ORDER BY seq",
      )
      .all(doc.id!, doc.id!);
    let value: any = {};
    for (const row of rows) {
      if (row.version !== 1)
        throw new AdmissionError(
          "Unsupported native metadata version. Use the original runtime.",
        );
      const content = JSON.parse(String(row.content));
      if (row.kind === "base") {
        value = content;
        continue;
      }
      if (row.kind !== "delta" || !Array.isArray(content))
        throw new AdmissionError("Unsupported native metadata delta.");
      for (const op of content) {
        if (!Array.isArray(op)) throw new AdmissionError("Unsupported native metadata operation.");
        if (op[0] === "r") {
          value = op[1];
          continue;
        }
        const path = op[1];
        if (
          !Array.isArray(path) ||
          !path.length ||
          path.some((key) =>
            ["__proto__", "constructor", "prototype"].includes(String(key)),
          )
        )
          throw new AdmissionError("Unsupported native metadata path.");
        let target = value;
        for (const key of path.slice(0, -1)) {
          if (!target || !Object.hasOwn(target, key)) throw new AdmissionError("Unsupported native metadata parent.");
          target = target[key];
        }
        if (!target || typeof target !== "object") throw new AdmissionError("Unsupported native metadata target.");
        const key = path.at(-1);
        if (op[0] === "s") target[key] = op[2];
        else if (op[0] === "d") delete target[key];
        else if (op[0] === "a" && typeof target[key] === "string" && typeof op[2] === "string") target[key] += op[2];
        else if (op[0] === "t" && typeof target[key] === "string" && Number.isSafeInteger(op[2]) && op[2] >= 0) target[key] = target[key].slice(0, op[2]);
        else throw new AdmissionError("Unsupported native metadata operation.");
      }
    }
    return value;
  });
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
export function createStores(config: Pick<LocalConfig, "sources">, reader: Reader) {
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
        status.path = root;
        const discovery = await reader.discoverWatchRuns({ stateRoot: root, saved: true });
        status.issues.push(...discovery.issues);
        for (const run of discovery.runs) {
          status.issues.push(...run.issues);
          // Canonical file identity also deduplicates overlapping configured roots.
          run.stores = run.stores.filter((store) => !seen.has(store.path));
          for (const store of run.stores) seen.add(store.path);
          if (!run.stores.length) continue;
          const snapshot = await reader.readWatchCatalog({ ...run, issues: [] });
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
        if (!discovery.runs.length && !discovery.issues.length)
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
