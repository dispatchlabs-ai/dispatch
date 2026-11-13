// Read-only reader for native Pi Durable SQLite stores.
//
// It opens the store file with a separate query-only SQLite connection. It never opens a Pi Durable session, takes
// an owner lock, migrates a schema or runs work, so it is safe beside a live owner. Every entry is kept, no text is
// shortened, and evidence that is not in the store is named in `coverage` instead of being filled in from current
// state. Credentials and opaque provider state are redacted.
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { openSqliteSnapshot, readSqliteDocument } from "@dispatch/runner/records";
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationRecord, DocumentRecord, EntryRecord } from "@earendil-works/pi-durable";

export type Source = { id: string; agent: string; database: string; description: string };
type Row = Record<string, string | number | null>;
type Chat = { id: string; agent: string; conversationId: number; title: string; key: string };
type Document = { record: DocumentRecord; seq: number; value: JsonValue };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Opaque provider state and credentials have no explanatory value. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return value
    .replace(/\b(?:xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, "[credential redacted]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY_ID))\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s\n]+)/g, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[private key redacted]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:authorization|cookie|set-cookie|headers|password|secret|credentials|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|botToken|appToken|privateKey|thinkingSignature|textSignature|encrypted_content)$|(?:^|_)(?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY_ID)$/i.test(key)
      ? "[redacted]" : redact(item),
  ]));
  return value;
}

/** One page of a redacted value as text, with the hash of the whole text. */
export function textPage(value: unknown, offset = 0) {
  const safe = redact(value);
  const text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  return { text: text.slice(offset, offset + 12000), offset, characters: text.length,
    nextOffset: offset + 12000 < text.length ? offset + 12000 : null, sha256: digest(text) };
}

/** Select a field of a record with a JSON pointer such as /value/items. */
export function selectPath(value: unknown, pointer = "") {
  if (!pointer) return value;
  if (!pointer.startsWith("/")) throw new Error("Use an empty path or a JSON pointer such as /value/items.");
  let selected = value;
  for (const component of pointer.slice(1).split("/")) {
    const key = component.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!selected || typeof selected !== "object" || !Object.prototype.hasOwnProperty.call(selected, key)) throw new Error("The record does not contain that path.");
    selected = (selected as Record<string, unknown>)[key];
  }
  return selected;
}

/**
 * Run `read` against a temporary private copy of a store (with its -wal and -shm files) instead of the store itself.
 * The directory is created 0700 and each file 0600; the copy is removed before this returns, whether `read`
 * succeeded or threw. The original is never opened.
 */
export async function withInspectionCopy<T>(database: string, read: (copy: string) => T | Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "dispatch-eval-inspect-"));
  try {
    await chmod(directory, 0o700);
    const copy = join(directory, basename(database));
    for (const suffix of ["", "-wal", "-shm"]) {
      if (suffix && !await stat(database + suffix).catch(() => undefined)) continue;
      await copyFile(database + suffix, copy + suffix);
      await chmod(copy + suffix, 0o600);
    }
    return await read(copy);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (await stat(directory).catch(() => undefined)) throw new Error(`Could not remove the temporary inspection copy at ${directory}.`);
  }
}

/** A separate SQLite reader: never open a Pi Durable session, acquire its owner lock or run work. */
export class NativeRecords {
  readonly db: DatabaseSync;
  readonly observedAt = new Date().toISOString();
  readonly sequence: number;
  readonly source: Source;
  constructor(source: Source) {
    this.source = source;
    this.db = openSqliteSnapshot(source.database);
    try {
      this.sequence = Number(this.one("SELECT next_seq FROM durable_metadata WHERE singleton = 1")!.next_seq) - 1;
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  rows(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).all(...args) as Row[]; }
  one(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).get(...args) as Row | undefined; }
  stamp() { return { source: this.source.id, sequence: this.sequence, observedAt: this.observedAt }; }
  record<T>(table: "conversations" | "entries" | "tasks" | "submissions" | "documents", id: number): T {
    const row = this.one(`SELECT record FROM ${table} WHERE id = ?`, id);
    if (!row) throw new Error(`No ${table} record ${id} in this source.`);
    return JSON.parse(String(row.record)) as T;
  }
  /** A document's value at a commit sequence, rebuilt from its retained revisions. */
  document(id: number, at = this.sequence): Document {
    const record = this.record<DocumentRecord>("documents", id);
    if (record.kind === "pi.provider") throw new Error("Opaque provider state is not exposed by this reader.");
    const { value, sequence } = readSqliteDocument(this.db, id, at);
    return { record, seq: sequence, value };
  }
  documents(conversationId?: number) {
    const rows = conversationId === undefined
      ? this.rows("SELECT record FROM documents WHERE scope_kind = 'session' AND retired_at IS NULL ORDER BY id")
      : this.rows("SELECT record FROM documents WHERE scope_kind = 'conversation' AND owner_id = ? AND retired_at IS NULL ORDER BY id", conversationId);
    return rows.map(row => JSON.parse(String(row.record)) as DocumentRecord).filter(doc => doc.kind !== "pi.provider");
  }
  byKind(kind: string, conversationId?: number) {
    const record = this.documents(conversationId).find(doc => doc.kind === kind);
    return record ? this.document(record.id) : undefined;
  }
  chats(): Chat[] {
    // Runner namespaces are installation-owned. Read only its native chat indexes.
    return this.documents().filter(doc => typeof doc.kind === "string" && doc.kind.endsWith(".chats")).flatMap(doc => {
      const index = this.document(doc.id).value as { byId?: Record<string, Chat>; keys?: Record<string, string> };
      const keys = new Map(Object.entries(index?.keys ?? {}).map(([key, id]) => [id, key]));
      return Object.values(index?.byId ?? {}).map(chat => ({ ...chat, key: keys.get(chat.id) ?? "" }));
    });
  }
  identities() {
    const identities = new Map<number, { agent: string; chatId?: string; handoffEntryId?: number }>();
    for (const chat of this.chats()) identities.set(chat.conversationId, { agent: chat.agent, chatId: chat.id });
    for (const row of this.rows(`SELECT e.id, json_extract(m.value, '$.details.agent') AS agent,
      json_extract(m.value, '$.details.conversationId') AS child
      FROM entries e, json_each(e.record, '$.model') m
      WHERE json_extract(m.value, '$.role') = 'toolResult'
        AND json_extract(m.value, '$.toolName') = 'ask_' || json_extract(m.value, '$.details.agent')
        AND json_extract(m.value, '$.isError') = 0 ORDER BY e.id`)) {
      if (typeof row.agent === "string" && typeof row.child === "number") {
        identities.set(row.child, { agent: row.agent, handoffEntryId: Number(row.id) });
      }
    }
    return identities;
  }
  conversation(id: number) {
    const record = this.record<ConversationRecord>("conversations", id);
    const docs = this.documents(id);
    const agent = docs.find(doc => doc.kind === "pi.agent");
    const saved = agent ? this.document(agent.id).value as Record<string, unknown> : undefined;
    const chats = this.chats().filter(chat => chat.conversationId === id);
    return { ...this.stamp(), sourceAgent: this.source.agent, identity: this.identities().get(id) ?? null, conversation: record, chats,
      savedConfiguration: agent ? { documentId: agent.id, model: saved?.model, thinkingLevel: saved?.thinkingLevel } : null,
      documents: docs.map(doc => ({ id: doc.id, kind: doc.kind, key: doc.key, history: doc.history })),
      children: this.rows("SELECT record FROM conversations WHERE owner_conversation_id = ? ORDER BY id", id).map(row => JSON.parse(String(row.record))),
      forks: this.rows("SELECT record FROM conversations WHERE json_extract(record, '$.parent.conversationId') = ? ORDER BY id", id).map(row => JSON.parse(String(row.record))),
      tasks: this.rows("SELECT id, kind, status, record FROM tasks WHERE conversation_id = ? ORDER BY id", id).map(row => {
        const task = JSON.parse(String(row.record));
        return { id: task.id, kind: task.kind, state: task.state.status, phase: task.state.checkpoint?.phase,
          outcome: task.state.outcome?.status, startedAt: task.startedAt, endedAt: task.endedAt, owner: task.owner };
      }),
      ownEntryCount: this.one("SELECT COUNT(*) AS count FROM entries WHERE conversation_id = ?", id)?.count,
      transcriptNote: "Entries include history before resets and compaction, plus context-edit markers. They are not a reconstruction of one active model request.",
    };
  }
  /** The conversations whose entries are visible from `id`: its fork ancestors up to each fork point, then itself. */
  segments(id: number) {
    const segments: { id: number; through: number }[] = [];
    const seen = new Set<number>();
    let current = this.record<ConversationRecord>("conversations", id), through = Number.MAX_SAFE_INTEGER;
    for (;;) {
      if (seen.has(current.id)) throw new Error("Invalid fork ancestry.");
      seen.add(current.id); segments.unshift({ id: current.id, through });
      if (!current.parent) break;
      through = Math.min(through, current.parent.at);
      current = this.record<ConversationRecord>("conversations", current.parent.conversationId);
    }
    return segments;
  }
  /** A page of entries as redacted excerpts, in ascending ID order, including inherited fork history. */
  entries(id: number, after: number, limit: number, query?: string) {
    const segments = this.segments(id);
    const args: SQLInputValue[] = segments.flatMap(part => [part.id, part.through]);
    const visible = segments.map(() => "(conversation_id = ? AND id <= ?)").join(" OR ");
    args.push(after);
    if (query) args.push(query);
    args.push(limit + 1);
    const rows = this.rows(`SELECT record, commit_seq FROM entries WHERE (${visible}) AND id > ?
      ${query ? "AND instr(lower(record), lower(?)) > 0" : ""} ORDER BY id LIMIT ?`, ...args);
    const entries = rows.slice(0, limit).map(row => {
      const entry = JSON.parse(String(row.record)) as EntryRecord;
      const safe = JSON.stringify(redact(entry));
      return { id: entry.id, conversationId: entry.conversationId, inherited: entry.conversationId !== id,
        kind: entry.kind, sequence: row.commit_seq, byTaskId: entry.byTaskId, head: entry.head,
        excerpt: safe.slice(0, 1400), characters: safe.length, truncated: safe.length > 1400 };
    });
    return { ...this.stamp(), conversationId: id, entries, nextAfter: rows.length > limit ? entries.at(-1)!.id : null };
  }

  /**
   * Every entry visible from a conversation, complete: inherited parent entries up to each fork point (marked
   * `inherited`), then its own. Entries without model messages (resets, compaction, context edits, data entries) are
   * kept as envelopes. Text and tool calls and results are copied in full; other content (for example reasoning) is
   * not copied, and its types are returned in `omittedContent`.
   */
  transcript(id: number) {
    const segments = this.segments(id);
    const rows = this.rows(`SELECT record, commit_seq FROM entries WHERE ${segments.map(() => "(conversation_id = ? AND id <= ?)").join(" OR ")} ORDER BY id`,
      ...segments.flatMap(part => [part.id, part.through]));
    const out: Record<string, unknown>[] = [], omitted = new Set<string>();
    for (const row of rows) {
      const x = JSON.parse(String(row.record));
      const envelope = { entry: x.id, sequence: Number(row.commit_seq), inherited: x.conversationId !== id, kind: x.kind, byTaskId: x.byTaskId ?? null };
      if (!(x.model ?? []).length) { out.push({ ...envelope, role: null, at: null, ...(x.data !== undefined ? { data: x.data } : {}) }); continue; }
      for (const m of x.model ?? []) {
        const content: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
        const other = [...new Set(content.map(c => c.type as string).filter(t => t !== "text" && t !== "toolCall"))];
        other.forEach(t => omitted.add(t));
        out.push({ ...envelope, role: m.role, at: m.timestamp ?? null, ...(other.length ? { omittedContent: other } : {}),
          text: content.filter(c => c.type === "text").map(c => c.text).join("\n") || undefined,
          toolCalls: content.filter(c => c.type === "toolCall").map(c => ({ id: c.id, name: c.name, arguments: c.arguments })),
          ...(m.role === "toolResult" ? { tool: m.toolName, toolCallId: m.toolCallId, isError: !!m.isError } : {}),
          ...(m.usage ? { usage: m.usage } : {}), ...(m.model ? { model: m.model } : {}), ...(m.stopReason ? { stopReason: m.stopReason } : {}),
          ...(x.data !== undefined ? { data: x.data } : {}) });
      }
    }
    return { segments: segments.map(part => part.id), forked: segments.length > 1, entries: out, omittedContent: [...omitted].sort() };
  }

  /**
   * The agent configuration at a commit sequence, rebuilt from retained revisions of the conversation's `pi.agent`
   * document. When that revision is not retained only the current configuration is returned, and coverage says so.
   */
  configurationAt(id: number, start: number | undefined, end: number | undefined) {
    const doc = this.documents(id).find(d => d.kind === "pi.agent");
    if (!doc) return { value: null, coverage: ["configuration_unavailable"] };
    const current = this.document(doc.id).value as any;
    let atStart: any = null;
    const coverage: string[] = [];
    try { atStart = start ? this.document(doc.id, start).value : null; } catch { atStart = null; }
    if (atStart) {
      coverage.push("configuration_at_start");
      const changes = this.one("SELECT COUNT(*) AS n FROM document_revisions WHERE document_id = ? AND seq > ? AND seq <= ?", doc.id, start!, end ?? this.sequence);
      if (Number(changes?.n)) coverage.push("configuration_changed_after_start");
    } else coverage.push("configuration_at_start_not_retained", "configuration_current_only");
    const v = atStart ?? current;
    return { value: { model: v?.model ?? null, thinking: v?.thinkingLevel ?? null, instructions: v?.instructions ?? null,
      instructions_sha256: v?.instructions ? digest(v.instructions) : null, document: doc.id, at: atStart ? start : this.sequence }, coverage };
  }

  /**
   * Everything retained about one conversation: transcript, configuration at its start, its own documents, recorded
   * usage, tasks and submissions with their outcomes, and every child conversation followed the same way.
   * `coverage` names what is present and what is unavailable.
   */
  evidence(id: number): Record<string, unknown> {
    const view = this.conversation(id);
    const t = this.transcript(id);
    const own = t.entries.filter(e => !e.inherited);
    const start = (own[0]?.sequence ?? t.entries[0]?.sequence) as number | undefined, end = t.entries.at(-1)?.sequence as number | undefined;
    const config = this.configurationAt(id, start, end);
    const usageDoc = this.byKind("pi.usage", id);
    const coverage = [...config.coverage, t.forked ? "fork_history_included" : "no_fork", usageDoc ? "usage_recorded" : "usage_unavailable",
      ...t.omittedContent.map(type => `content_omitted:${type}`)];
    const children = view.children.map(c => this.evidence(c.id));
    if (children.length) coverage.push(`children_followed:${children.length}`);
    return {
      conversationId: id, conversation: view.conversation, identity: view.identity, configuration: config.value,
      documents: Object.fromEntries(view.documents.filter(d => !["pi.live", "pi.inbox", "pi.agent", "pi.usage"].includes(d.kind))
        .map(d => [d.kind, this.document(d.id).value])),
      usage: usageDoc?.value ?? null,
      tasks: this.rows("SELECT record FROM tasks WHERE conversation_id = ? ORDER BY id", id).map(row => {
        const task = JSON.parse(String(row.record));
        return { id: task.id, kind: task.kind, owner: task.owner ?? null, startedAt: task.startedAt ?? null, endedAt: task.endedAt ?? null,
          status: task.state.status, outcome: task.state.outcome ?? null };
      }),
      submissions: this.rows("SELECT id, record FROM submissions WHERE conversation_id = ? ORDER BY id", id).map(row => ({ id: Number(row.id), ...JSON.parse(String(row.record)) })),
      forks: view.forks.map(f => f.id), transcript: t, children, coverage,
    };
  }
}

export type RecordSelection = { database: string; documentKind?: string; conversation?: number; ids?: number[]; limit?: number };

/**
 * Units of evidence from one store: the conversations that own a document of `documentKind` (newest first), or one
 * known `conversation`. The result is redacted.
 */
export function readRecords(selection: RecordSelection) {
  if (!selection.documentKind && selection.conversation === undefined) throw new Error("Select a document kind or one conversation.");
  const r = new NativeRecords({ id: "native", agent: "native", database: selection.database, description: "" });
  try {
    if (selection.conversation !== undefined) return redact({ observed: r.stamp(), units: [{ ...r.evidence(selection.conversation), selected: null }] });
    const rows = r.rows("SELECT id, owner_id FROM documents WHERE kind = ? AND scope_kind = ? ORDER BY id DESC", JSON.stringify(selection.documentKind), "conversation")
      .filter(x => !selection.ids || selection.ids.includes(Number(x.owner_id))).slice(0, selection.limit);
    return redact({ observed: r.stamp(), units: rows.map(row => ({ ...r.evidence(Number(row.owner_id)),
      selected: { kind: selection.documentKind, document: r.document(Number(row.id)).value } })) });
  } finally { r.close(); }
}
