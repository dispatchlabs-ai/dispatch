import type { EntryRecord, TaskRecord } from "@earendil-works/pi-durable";
import { projectChatMessages } from "./chat.js";
import { projectChatTools } from "./chat-tools.js";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type {
  WatchActivity, WatchCatalog, WatchCatalogConversation, WatchConversation, WatchCursor, WatchOptions, WatchPage,
  WatchRun, WatchSnapshot, WatchStore,
} from "./watch-types.js";

export type * from "./watch-types.js";
type Data = Record<string, any>;
type Row = Record<string, unknown>;
const exec = promisify(execFile);
const pageSize = 100;
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const isWatchSessionKey = (value: string): boolean =>
  value === "." || value.split("/").every(part => keyPattern.test(part));
const secretKey = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|authorization|cookie|private[-_]?key|connectionString|thoughtSignature|thinkingSignature|encryptedContent)$/i;

/** Redact known credential fields without exposing provider state or reasoning. */
function redact(value: unknown): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      secretKey.test(key) ? "[redacted]" : key === "data" && (value as Data).type === "image"
        ? "[image omitted]" : redact(item)]));
  if (typeof value !== "string") return value;
  return value
    .replace(/\b(?:sk-(?:proj-)?[\w-]{16,}|AKIA[A-Z0-9]{16})\b/g, "[redacted]")
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "[private key redacted]")
    .replace(/(Bearer\s+)[\w.+/=-]+/gi, "$1[redacted]")
    .replace(/((?:postgres(?:ql)?|https?):\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/((?:[?&]|\b)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|authorization|private[-_]?key)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&;,]+)/gi, "$1[redacted]");
}
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error)) as string;
const parse = (value: unknown): Data => JSON.parse(String(value));
const timestamp = (value: unknown): number | undefined => {
  const result = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : undefined;
};
function text(content: unknown): string {
  if (typeof content === "string") return redact(content);
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => typeof part === "string" ? [redact(part)]
    : part?.type === "text" && typeof part.text === "string" ? [redact(part.text)]
      : part?.type === "image" ? ["[retained image]"] : []).join("\n");
}
function messages(record: Data): Data[] {
  return Array.isArray(record.model) ? record.model.filter((item: unknown) => item && typeof item === "object") : [];
}
function number(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Stored identifier is outside the supported range.");
  return result;
}
async function ownedPath(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    || (process.getuid && info.uid !== process.getuid()))
    throw new Error("Watch reads only user-owned regular session files and directories, without symlinks.");
}
async function withStore<T>(path: string, read: (db: DatabaseSync) => T): Promise<T> {
  await ownedPath(dirname(dirname(path)), true);
  await ownedPath(dirname(path), true);
  await ownedPath(path, false);
  // Retained selections must not follow an ancestor redirected after discovery.
  if (await realpath(path) !== path) throw new Error("Session path was redirected; rediscover the configured installation.");
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    const schema = db.prepare("SELECT version FROM durable_schema WHERE singleton=1").get();
    if (schema?.version !== 1 && schema?.version !== 2)
      throw new Error("Unsupported native SQLite schema; watch never migrates a store.");
    return read(db);
  } finally { db.close(); }
}

/** Narrow reconstruction for the Runner chat index, never provider/live documents. */
function chats(db: DatabaseSync, namespace: string): Map<number, Data> {
  const doc = db.prepare("SELECT id FROM documents WHERE kind=? AND scope_kind='session'")
    .get(JSON.stringify(`${namespace}.chats`));
  if (!doc) return new Map();
  const revisions = db.prepare(`SELECT kind,version,content FROM document_revisions WHERE document_id=?
    AND seq>=COALESCE((SELECT MAX(seq) FROM document_revisions WHERE document_id=? AND kind='base'),0) ORDER BY seq`)
    .all(number(doc.id), number(doc.id));
  let value: Data = {};
  for (const revision of revisions) {
    if (revision.version !== 1) return new Map();
    const content = JSON.parse(String(revision.content));
    if (revision.kind === "base") { value = content; continue; }
    if (revision.kind !== "delta" || !Array.isArray(content)) return new Map();
    for (const op of content) {
      if (!Array.isArray(op)) return new Map();
      if (op[0] === "r") { value = op[1]; continue; }
      const path = op[1];
      if (!Array.isArray(path) || !path.length || path.some(key => ["__proto__", "prototype", "constructor"].includes(String(key))))
        return new Map();
      let target = value;
      for (const key of path.slice(0, -1)) {
        if (!target || !Object.hasOwn(target, key)) return new Map();
        target = target[key];
      }
      if (!target || typeof target !== "object") return new Map();
      const key = path.at(-1);
      if (op[0] === "s") target[key] = op[2];
      else if (op[0] === "d") delete target[key];
      else if (op[0] === "a" && typeof target[key] === "string" && typeof op[2] === "string") target[key] += op[2];
      else if (op[0] === "t" && typeof target[key] === "string" && Number.isSafeInteger(op[2]) && op[2] >= 0) target[key] = target[key].slice(0, op[2]);
      else return new Map();
    }
  }
  return new Map(Object.values(value?.byId ?? {}).filter((chat: any) =>
    chat && Number.isSafeInteger(chat.conversationId) && chat.id === `${chat.agent}:${chat.conversationId}`)
    .map((chat: any) => [chat.conversationId, chat]));
}

async function validateStore(path: string, pids: number[], namespace?: string): Promise<WatchStore> {
  const agent = basename(dirname(path));
  let status: Data | undefined;
  const statusPath = join(dirname(path), "status.json");
  try {
    await ownedPath(statusPath, false);
    status = JSON.parse(await readFile(statusPath, "utf8"));
    if (status?.agent !== agent) throw new Error("Status agent identity does not match its store.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return withStore(path, db => {
    const kinds = db.prepare("SELECT kind FROM documents WHERE scope_kind='session'").all()
      .map(row => JSON.parse(String(row.kind))).filter((kind): kind is string => typeof kind === "string");
    const namespaces = kinds.filter(kind => kind.endsWith(".runner"))
      .map(kind => kind.slice(0, -7)).filter(value => !namespace || namespace === value);
    if (namespaces.length !== 1) throw new Error("Store does not match the configured Runner namespace.");
    // Recipient hosts exist before their first chat. The Runner status supplies
    // agent identity then; only a writable handle establishes process presence.
    if (!kinds.includes(`${namespaces[0]}.chats`) && !status)
      throw new Error("Runner host has no retained agent identity.");
    const registered = [...chats(db, namespaces[0]).values()];
    if (registered.some(chat => chat.agent !== agent)) throw new Error("Stored agent identity does not match its directory.");
    return { agent, path, namespace: namespaces[0], pids };
  });
}

/** Current writable handles establish process presence; unfinished tasks do not. */
export async function discoverWatchRuns(options: WatchOptions): Promise<{ runs: WatchRun[]; issues: string[] }> {
  if (!isAbsolute(options.stateRoot)) throw new Error("stateRoot must be an absolute path.");
  if (options.session !== undefined && !isWatchSessionKey(options.session)) throw new Error("Invalid session key.");
  const issues: string[] = [];
  let root: string;
  try { root = await realpath(options.stateRoot); await ownedPath(root, true); }
  catch (error) { return { runs: [], issues: [`Cannot read session directory: ${errorText(error)}`] }; }
  let output = "";
  if (process.platform === "win32") issues.push("Local process discovery is unavailable on Windows; choose a saved session explicitly.");
  else try {
    ({ stdout: output } = await exec(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
      ["-n", "-P", "-a", "-u", String(process.getuid!()), "-F", "pcfan"],
      { timeout: 15_000, maxBuffer: 32 * 1024 * 1024, signal: options.signal }));
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const failure = error as NodeJS.ErrnoException & { stdout?: string };
    if (Number(failure.code) === 1 && failure.stdout !== undefined) output = failure.stdout;
    else issues.push(`Could not inspect local processes: ${errorText(error)}`);
  }
  const owners = new Map<string, Set<number>>();
  let pid = 0, runtime = false, access = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); runtime = false; access = ""; }
    else if (line.startsWith("c")) runtime = /^(?:node|bun|deno|pi|dispatch|electron)(?:$|[ ._-])/i.test(line.slice(1));
    else if (line.startsWith("f")) access = "";
    else if (line.startsWith("a")) access = line.slice(1);
    else if (runtime && pid !== process.pid && line.startsWith("n/") && (access === "u" || access === "w")) {
      const path = line.slice(1), parts = relative(root, path).split(sep);
      if (parts.length < 2 || parts.at(-1) !== "session.sqlite" || !parts.slice(0, -1).every(part => keyPattern.test(part))) continue;
      const found = owners.get(path) ?? new Set<number>(); found.add(pid); owners.set(path, found);
    }
  }
  const sessions = new Set([...owners.keys()].map(path => relative(root, dirname(dirname(path))).split(sep).join("/") || "."));
  if (options.saved && options.session === undefined) {
    // One process census for the whole configured root, including retained runs.
    // Validate each ancestor; never follow a directory symlink into another store.
    async function walk(path: string) {
      try {
        await ownedPath(path, true);
        const children = await readdir(path, { withFileTypes: true });
        if (children.some(child => child.name === "session.sqlite")) {
          const session = relative(root, dirname(path)).split(sep).join("/") || ".";
          if (isWatchSessionKey(session)) sessions.add(session);
          return;
        }
        for (const child of children)
          if (child.isDirectory() && !child.isSymbolicLink() && keyPattern.test(child.name)) await walk(join(path, child.name));
      } catch (error) { issues.push(`Cannot read retained directory: ${errorText(error)}`); }
    }
    await walk(root);
  }
  if (options.session) { sessions.clear(); sessions.add(options.session); }
  const runs: WatchRun[] = [];
  for (const session of sessions) {
    const path = join(root, ...session.split("/")), runIssues: string[] = [], stores: WatchStore[] = [];
    try {
      let directory = root;
      for (const part of session === "." ? [] : session.split("/")) {
        directory = join(directory, part);
        await ownedPath(directory, true);
      }
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (!child.isDirectory() || child.isSymbolicLink() || !keyPattern.test(child.name)) continue;
        const file = join(path, child.name, "session.sqlite");
        try { stores.push(await validateStore(file, [...owners.get(file) ?? []], options.namespace)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") runIssues.push(`${child.name}: ${errorText(error)}`);
        }
      }
    } catch (error) { issues.push(`${session}: ${errorText(error)}`); continue; }
    if (!stores.length) { issues.push(`${session}: No readable Runner stores.`, ...runIssues); continue; }
    const pids = [...new Set(stores.flatMap(store => store.pids))].sort((a, b) => a - b);
    if (!options.session && !options.saved && !pids.length) continue;
    runs.push({ key: path, path, session, pids, stores, observedAt: Date.now(), issues: runIssues });
  }
  runs.sort((a, b) => a.session.localeCompare(b.session));
  return { runs, issues };
}

function toolSummary(name: string, args: Data | undefined): string {
  const label = args?.title ?? args?.description ?? args?.url ?? args?.path ?? args?.id;
  if (typeof label === "string") return `${name}: ${redact(label).replace(/\s+/g, " ").slice(0, 180)}`;
  const command = args?.cmd ?? args?.command;
  if (typeof command === "string") return `${name}: ${redact(command).replace(/\s+/g, " ").slice(0, 180)}`;
  return name;
}
function projectEntries(store: WatchStore, rows: Row[]): WatchActivity[] {
  const items: WatchActivity[] = [];
  for (const row of rows) {
    const record = parse(row.record), conversationId = number(record.conversationId), entryId = number(record.id);
    let ordinal = 0;
    for (const message of messages(record)) {
      const base = { conversationKey: `${store.agent}:${conversationId}`, entryId, sequence: number(row.commit_seq), at: timestamp(message.timestamp) };
      const id = () => `${store.agent}:${entryId}:${ordinal++}`;
      if (message.role === "toolResult") items.push({ ...base, id: id(), kind: "tool-result",
        title: String(message.toolName ?? "Tool result"), text: text(message.content),
        toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined, error: message.isError === true });
      else if (message.role === "user" || message.role === "assistant") {
        const prose = text(message.content);
        if (prose) items.push({ ...base, id: id(), kind: "message", role: message.role,
          title: message.role === "user" ? "Assignment" : "Assistant", text: prose });
        if (message.role === "assistant" && Array.isArray(message.content))
          for (const call of message.content)
            if (call?.type === "toolCall") items.push({ ...base, id: id(), kind: "tool-call",
              title: String(call.name ?? "Tool"), text: toolSummary(String(call.name ?? "Tool"), call.arguments),
              toolCallId: typeof call.id === "string" ? call.id : undefined, arguments: redact(call.arguments ?? {}) });
      }
    }
  }
  return items;
}
function attachResults(db: DatabaseSync, entries: WatchActivity[]): void {
  const calls = entries.filter(item => item.kind === "tool-call" && item.toolCallId);
  if (!calls.length) return;
  const first = calls[0], conversationId = Number(first.conversationKey.slice(first.conversationKey.lastIndexOf(":") + 1));
  // One scan per page rather than reparsing the entire conversation for every call.
  const rows = db.prepare(`SELECT m.value,e.commit_seq FROM entries e,json_each(e.record,'$.model') m
    WHERE e.conversation_id=? AND e.commit_seq>=? AND json_extract(m.value,'$.role')='toolResult'
    AND json_extract(m.value,'$.toolCallId') IN (SELECT value FROM json_each(?)) ORDER BY e.commit_seq,e.id`)
    .all(conversationId, Math.min(...calls.map(item => item.sequence)), JSON.stringify(calls.map(item => item.toolCallId)));
  const results = new Map(rows.map(row => { const result = parse(row.value); return [String(result.toolCallId), { result, sequence: number(row.commit_seq) }]; }));
  for (const item of calls) {
    const found = results.get(item.toolCallId!);
    if (found && found.sequence >= item.sequence) item.result = {
      text: text(found.result.content), error: found.result.isError === true, at: timestamp(found.result.timestamp),
    };
  }
}
const openingTitle = (entry: Data | undefined): string => {
  const opening = entry && messages(entry).find(message => message.role === "user");
  const prose = text(opening?.content);
  const lines = prose.split("\n");
  const scope = lines.find(line => /^(?:scope|categories|category)\s*:/i.test(line.trim()))
    ?? lines.find(line => /^(?:assignment|worker(?:_id)?)\s*:/i.test(line.trim()));
  const inlineScope = prose.match(/(?:^|[.!?]\s+|\n)\s*(?:scope|categories|category)[ \t]+([^:\n]{1,120}):/i)?.[1];
  return (inlineScope ?? scope ?? prose).replace(/\s+/g, " ").trim().slice(0, 180);
};

/** Lightweight retained navigation without latest activity/tool scans or providers.
 * Optional chat-index metadata may be absent/malformed; native entries remain
 * authoritative. Schema, I/O and stored agent identity validation still fail. */
export async function readWatchCatalog(run: WatchRun): Promise<WatchCatalog> {
  const conversations: WatchCatalogConversation[] = [], issues = [...run.issues];
  for (const store of run.stores) try {
    conversations.push(...await withStore(store.path, db => {
      const registered = chats(db, store.namespace);
      return db.prepare(`SELECT c.id,c.record,
        (SELECT e.record FROM entries e WHERE e.conversation_id=c.id ORDER BY e.commit_seq,e.id LIMIT 1) AS first_entry,
        EXISTS(SELECT 1 FROM tasks t WHERE t.conversation_id=c.id AND t.status<>'terminal') AS active
        FROM conversations c ORDER BY c.id`).all().flatMap(row => {
          const record = parse(row.record), id = number(record.id), chat = registered.get(id);
          if (id < 1 || id !== number(row.id)) throw new Error("Unsupported native conversation identity.");
          if (!row.first_entry && !row.active && !chat && !record.owner) return [];
          const first = row.first_entry ? parse(row.first_entry) : undefined;
          const firstMessage = first && messages(first)[0];
          return [{ key: `${store.agent}:${id}`, agent: store.agent, conversationId: id,
            title: redact(chat?.title) || openingTitle(first) || store.agent,
            parentKey: Number.isSafeInteger(record.owner?.conversationId) ? `${store.agent}:${record.owner.conversationId}` : undefined,
            startedAt: timestamp(chat?.createdAt) ?? timestamp(firstMessage?.timestamp) }];
        });
    }));
  } catch (error) { issues.push(`${store.agent}: ${errorText(error)}`); }
  return { conversations, issues };
}

export async function readWatchRun(run: WatchRun, key?: string): Promise<WatchSnapshot> {
  const split = key?.lastIndexOf(":") ?? -1;
  const agent = key?.slice(0, split), selected = key === undefined ? undefined : Number(key.slice(split + 1));
  if (key !== undefined && (split < 1 || String(selected) !== key.slice(split + 1) || !Number.isSafeInteger(selected) || selected! < 1 || !run.stores.some(store => store.agent === agent)))
    throw new Error("Unknown conversation in this run.");
  const conversations: WatchConversation[] = [], activity: WatchActivity[] = [], issues = [...run.issues];
  const unavailableAgents: string[] = [];
  for (const store of run.stores) {
    if (agent !== undefined && store.agent !== agent) continue;
    try {
      const observed = await withStore(store.path, db => {
        const conversations: WatchConversation[] = [], activity: WatchActivity[] = [];
        const registered = chats(db, store.namespace);
        const tasks = db.prepare(`SELECT record FROM tasks WHERE status<>'terminal' ${selected === undefined ? "" : "AND conversation_id=?"} ORDER BY id`)
          .all(...(selected === undefined ? [] : [selected])).map(row => parse(row.record));
        const rows = db.prepare(`SELECT c.record,
          (SELECT COUNT(*) FROM entries e WHERE e.conversation_id=c.id) AS entry_count,
          (SELECT e.record FROM entries e WHERE e.conversation_id=c.id ORDER BY e.commit_seq,e.id LIMIT 1) AS first_entry,
          (SELECT COUNT(*) FROM tasks t WHERE t.conversation_id=c.id AND t.status='terminal' AND json_extract(t.record,'$.state.outcome.status')='failed') AS failed
          FROM conversations c ${selected === undefined ? "" : "WHERE c.id=?"} ORDER BY c.id`)
          .all(...(selected === undefined ? [] : [selected]));
        for (const row of rows) {
          const record = parse(row.record), id = number(record.id), chat = registered.get(id);
          const active = tasks.filter(task => task.conversationId === id), entryCount = number(row.entry_count);
          if (!entryCount && !active.length && !chat && !record.owner) continue;
          const latestRows = db.prepare("SELECT record,commit_seq FROM entries WHERE conversation_id=? ORDER BY commit_seq DESC,id DESC LIMIT 8").all(id).reverse();
          const latest = projectEntries(store, latestRows), last = latest.at(-1);
          activity.push(...latest);
          const messageRow = db.prepare(`SELECT e.record,e.commit_seq FROM entries e
            WHERE e.conversation_id=? AND EXISTS (
              SELECT 1 FROM json_each(e.record,'$.model') m
              WHERE json_extract(m.value,'$.role')='assistant' AND (
                (json_type(m.value,'$.content')='text' AND length(trim(json_extract(m.value,'$.content')))>0)
                OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(m.value,'$.content')='array'
                  THEN json_extract(m.value,'$.content') ELSE '[]' END) p
                  WHERE p.type='object' AND json_extract(p.value,'$.type')='text' AND length(trim(json_extract(p.value,'$.text')))>0)))
            ORDER BY e.commit_seq DESC,e.id DESC LIMIT 1`).get(id);
          const latestMessage = messageRow && projectEntries(store, [messageRow]).filter(item => item.kind === "message" && item.role === "assistant").at(-1);
          const toolCalls = active.filter(task => task.kind === "pi.tool").flatMap(task => {
            if (!Number.isSafeInteger(task.input?.assistant)) return [];
            const callRow = db.prepare("SELECT record,commit_seq FROM entries WHERE id=? AND conversation_id=?").get(task.input.assistant, id);
            return callRow ? projectEntries(store, [callRow]).filter(item => item.kind === "tool-call" && item.toolCallId === task.input.callId) : [];
          });
          const agentWait = toolCalls.length > 0 && toolCalls.every(call => ["clone_agent", "delegate", "wait_for_agent"].includes(call.title));
          const hasWork = active.some(task => ["running", "runnable"].includes(task.state?.status));
          // A settled turn's native outcome, not process liveness, says whether it was answered.
          const settled = active.length ? undefined : db.prepare(`SELECT record FROM submissions
            WHERE conversation_id=? AND json_extract(record,'$.type') IN ('input','continue') ORDER BY id DESC LIMIT 1`).get(id);
          const outcome = settled && parse(settled.record);
          const unanswered = outcome?.status === "unanswered";
          const status: WatchConversation["status"] = !store.pids.length && active.length ? "unavailable"
            : agentWait || active.length && !hasWork ? "waiting" : hasWork ? "working" : unanswered ? "unanswered" : "idle";
          const generation = active.find(task => task.kind === "pi.generation");
          const detail = !store.pids.length && active.length ? "Unfinished native work; no process observed"
            : agentWait ? `Waiting for ${toolCalls.length} agent ${toolCalls.length === 1 ? "result" : "results"}`
            : toolCalls.length ? toolCalls.map(call => call.text).join(" · ")
              : generation ? generation.state?.checkpoint?.phase === "tools" ? "Running tools" : "Generating response"
                : active.some(task => /compaction/.test(task.kind)) ? "Compacting context"
                  : hasWork ? "Running native work" : active.length ? "Waiting on native work"
                    : unanswered ? `Last turn not answered (${String(outcome.reason)})${typeof outcome.detail === "string" ? `: ${redact(outcome.detail)}` : ""}`
                      : last?.text ?? "No recorded activity";
          const first = row.first_entry ? parse(row.first_entry) : undefined;
          const firstMessage = first && messages(first)[0];
          conversations.push({ key: `${store.agent}:${id}`, agent: store.agent, conversationId: id,
            title: redact(chat?.title) || openingTitle(first) || store.agent,
            parentKey: Number.isSafeInteger(record.owner?.conversationId) ? `${store.agent}:${record.owner.conversationId}` : undefined,
            active: active.length, failed: number(row.failed), status, activity: detail.replace(/\s+/g, " ").slice(0, 240),
            updatedAt: last?.at, startedAt: timestamp(chat?.createdAt) ?? timestamp(firstMessage?.timestamp), entryCount,
            latestMessage, currentTools: toolCalls });
        }
        return { conversations, activity };
      });
      conversations.push(...observed.conversations);
      activity.push(...observed.activity);
    } catch (error) {
      unavailableAgents.push(store.agent);
      issues.push(`${store.agent}: ${errorText(error)}`);
    }
  }
  activity.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id));
  conversations.sort((a, b) => Number(Boolean(a.parentKey)) - Number(Boolean(b.parentKey)) || a.agent.localeCompare(b.agent) || a.conversationId - b.conversationId);
  return { run, conversations, activity: activity.slice(-20), unavailableAgents, issues, observedAt: Date.now() };
}

export async function readWatchConversation(run: WatchRun, key: string, before?: WatchCursor): Promise<WatchPage> {
  const split = key.lastIndexOf(":"), agent = key.slice(0, split), conversationId = Number(key.slice(split + 1));
  const store = run.stores.find(item => item.agent === agent);
  if (!store || !Number.isSafeInteger(conversationId) || conversationId < 1) throw new Error("Unknown conversation in this run.");
  if (before && (!Number.isSafeInteger(before.sequence) || !Number.isSafeInteger(before.entryId))) throw new Error("Invalid history cursor.");
  return withStore(store.path, db => {
    if (!db.prepare("SELECT id FROM conversations WHERE id=?").get(conversationId)) throw new Error("Conversation is no longer available.");
    const rows = db.prepare(`SELECT record,commit_seq FROM entries WHERE conversation_id=?
      ${before ? "AND (commit_seq<? OR (commit_seq=? AND id<?))" : ""} ORDER BY commit_seq DESC,id DESC LIMIT ?`)
      .all(conversationId, ...(before ? [before.sequence, before.sequence, before.entryId] : []), pageSize + 1);
    const hasEarlier = rows.length > pageSize, visible = rows.slice(0, pageSize).reverse();
    const entries = projectEntries(store, visible);
    attachResults(db, entries);
    const first = visible[0];
    return { entries, hasEarlier, before: first ? { sequence: number(first.commit_seq), entryId: number(parse(first.record).id) } : undefined, observedAt: Date.now() };
  });
}

/** Refresh one retained activity without moving the reader's history position. */
export async function readWatchActivity(run: WatchRun, activity: WatchActivity): Promise<WatchActivity | undefined> {
  const split = activity.conversationKey.lastIndexOf(":"), agent = activity.conversationKey.slice(0, split);
  const conversationId = Number(activity.conversationKey.slice(split + 1));
  const store = run.stores.find(item => item.agent === agent);
  if (!store || !Number.isSafeInteger(conversationId) || conversationId < 1
    || !Number.isSafeInteger(activity.entryId) || activity.entryId < 1 || !Number.isSafeInteger(activity.sequence))
    throw new Error("Invalid activity identity in this run.");
  return withStore(store.path, db => {
    const row = db.prepare("SELECT record,commit_seq FROM entries WHERE id=? AND conversation_id=? AND commit_seq=?")
      .get(activity.entryId, conversationId, activity.sequence);
    if (!row) return undefined;
    const item = projectEntries(store, [row]).find(candidate => candidate.id === activity.id);
    if (item) attachResults(db, [item]);
    return item;
  });
}

/** Full retained public chat projection from the selected native store; no owner. */
export async function readWatchChatProjection(run: WatchRun, key: string) {
  const split = key.lastIndexOf(":"), agent = key.slice(0, split), id = Number(key.slice(split + 1));
  const store = run.stores.find(store => store.agent === agent);
  if (!store || !Number.isSafeInteger(id) || id < 1 || String(id) !== key.slice(split + 1)) throw new Error("Unknown native conversation.");
  return withStore(store.path, db => {
    const entries = db.prepare("SELECT record FROM entries WHERE conversation_id=? ORDER BY commit_seq,id").all(id).map(row => parse(row.record) as EntryRecord);
    const tasks = db.prepare("SELECT record FROM tasks WHERE conversation_id=? AND kind='pi.tool'").all(id).map(row => parse(row.record));
    const byId = new Map(entries.map(entry => [Number(entry.id), entry]));
    const messages = projectChatMessages(store.namespace, entries).map(message => {
      const entry = byId.get(Number(message.id.split(":")[0]));
      const data = entry?.data as {source?: string; from?: string} | undefined;
      const source = data?.source;
      const provenance = message.role !== "user" ? "agent" as const
        : entry?.kind === `${store.namespace}.message` && ["web","cli","slack","google-chat","phone","email"].includes(source ?? "") ? "user" as const
          : entry?.kind === `${store.namespace}.instance-message` ? "agent" as const : "runtime" as const;
      return {...message, provenance, ...(entry?.kind === `${store.namespace}.instance-message` ? {author:data?.from} : {})};
    });
    // Selected upload bytes are native input, not credential metadata. Preserve
    // them byte-for-byte for downloads/replay rather than redacting base64 text.
    return { messages: messages.map(message => ({...redact({...message, attachments: undefined}),
      ...(message.attachments ? {attachments:message.attachments} : {})})),
      toolCalls: redact(projectChatTools(entries, undefined, tasks as TaskRecord<unknown, unknown, unknown>[])) };

  });
}
