import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@earendil-works/chord/json";
import type { DocumentRecord, EntryRecord, RunSummary, SubmissionRecord } from "@earendil-works/pi-durable";
import { openSqliteSnapshot, readSqliteDocument, redact, transcriptSegments } from "./records.js";

export type ReviewRun = { conversation: number; first: number; answer: number; last: number; reason: RunSummary["reason"] };
export const reviewPageSize = 48_000;

function submissions(db: DatabaseSync, conversation: number, answer: number) {
  return db.prepare("SELECT record FROM submissions WHERE conversation_id=? AND status='done' AND json_extract(record,'$.answer')=? ORDER BY id")
    .all(conversation, answer).map(row => JSON.parse(String(row.record)) as SubmissionRecord);
}

/** Recover an earlier answered run from its native receipt, including inputs placed together. */
export function retainedRun(database: string, submission: number): ReviewRun {
  const db = openSqliteSnapshot(database);
  try {
    const row = db.prepare("SELECT record FROM submissions WHERE id=?").get(submission);
    const receipt: SubmissionRecord | undefined = row && JSON.parse(String(row.record));
    if (receipt?.status !== "done" || receipt.type === "write") throw new Error("Select a completed input or continue submission.");
    const { conversationId: conversation, answer } = receipt;
    const saved = db.prepare("SELECT json_extract(record,'$.input') AS run FROM tasks WHERE conversation_id=? AND kind=? AND json_extract(record,'$.input.answer')=? LIMIT 1")
      .get(conversation, JSON.stringify("dispatch.queue-run-review"), answer);
    if (saved) return JSON.parse(String(saved.run)) as ReviewRun;
    const inputs = submissions(db, conversation, answer);
    const entries = inputs.flatMap(input => input.type === "input" && input.entry !== undefined ? [Number(input.entry)] : []);
    const message = db.prepare("SELECT json_extract(record,'$.model[0].stopReason') AS reason FROM entries WHERE conversation_id=? AND id=?").get(conversation, answer);
    if (!entries.length || inputs.some(input => input.type === "continue") || !message || message.reason === "toolUse") {
      throw new Error("The exact boundaries of this older continued or tool-terminated run were not retained.");
    }
    return { conversation, first: Math.min(...entries), answer, last: answer, reason: "answer" };
  } finally { db.close(); }
}

function jsonText(text: string) {
  try { return JSON.parse(text); } catch { return text; }
}

/** Preserve distinct tool details and system prompt sections. Remove duplicate MCP envelopes and opaque provider content. */
function messageEvidence(message: NonNullable<EntryRecord["model"]>[number]) {
  if (message.role === "system") return message;
  const content = typeof message.content === "string" ? message.content : message.content.map(block => {
    if (block.type === "text") return message.role === "toolResult" ? jsonText(block.text) : block.text;
    if (block.type === "toolCall") return { toolCall: block.name, id: block.id, arguments: block.arguments };
    return { omitted: block.type };
  });
  if (message.role === "toolResult") {
    let details = message.details;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const fields = { ...details } as Record<string, JsonValue>;
      if (isDeepStrictEqual(fields.content, message.content)) delete fields.content;
      if (Array.isArray(content) && content.length === 1 && isDeepStrictEqual(fields.structuredContent, content[0])) delete fields.structuredContent;
      details = Object.keys(fields).length ? fields : undefined;
    }
    return { role: message.role, tool: message.toolName, call: message.toolCallId, error: message.isError, content, details };
  }
  return { role: message.role, content, ...(message.role === "assistant" ? { stop: message.stopReason } : {}) };
}

function transcript(db: DatabaseSync, conversation: number, first: number, last: number, cutoff: number) {
  return db.prepare("SELECT record FROM entries WHERE conversation_id=? AND id BETWEEN ? AND ? AND commit_seq<=? ORDER BY id")
    .all(conversation, first, last, cutoff).map(row => {
      const e = JSON.parse(String(row.record)) as EntryRecord;
      return { entry: e.id, kind: e.kind, task: e.byTaskId, head: e.head, edits: e.edits, data: e.data, messages: e.model?.map(messageEvidence) };
    });
}

function documents(db: DatabaseSync, conversation: number, at: number) {
  return db.prepare("SELECT record FROM documents WHERE scope_kind='conversation' AND owner_id=? AND created_at<=? AND (retired_at IS NULL OR retired_at>?) ORDER BY id")
    .all(conversation, at, at).map(row => JSON.parse(String(row.record)) as DocumentRecord)
    .filter(doc => !["pi.provider", "pi.inbox", "pi.live"].includes(doc.kind)).map(doc => {
      const identity = { document: doc.id, kind: doc.kind, key: doc.key };
      try { return { ...identity, ...readSqliteDocument(db, doc.id, at) }; }
      catch { return { ...identity, coverage: "Revision unavailable at this commit" }; }
    });
}

function runHistory(db: DatabaseSync, conversation: number, first: number, last: number, cutoff: number, endTime?: number) {
  const entries = transcript(db, conversation, first, last, cutoff);
  const taskIds = new Set<number>(entries.flatMap(e => e.task === undefined ? [] : [Number(e.task)]));
  const tasks = db.prepare("SELECT record FROM tasks WHERE conversation_id=? AND id<=? ORDER BY id").all(conversation, last)
    .map(row => JSON.parse(String(row.record))).filter(t => t.id >= first || taskIds.has(t.id)).map(t => {
      taskIds.add(t.id);
      const result = t.state.outcome?.result;
      const terminal = (endTime !== undefined && t.endedAt <= endTime) || entries.some(e => e.entry === result?.entryId);
      return { task: t.id, kind: t.kind, owner: t.owner, ...(terminal ? { outcome: t.state.outcome } : { coverage: "Terminal outcome unconfirmed at cutoff" }) };
    });
  const children = db.prepare("SELECT id,owner_task_id FROM conversations WHERE owner_conversation_id=? AND id<=? ORDER BY id")
    .all(conversation, last).filter(row => taskIds.has(Number(row.owner_task_id)));
  const lines = [`Conversation ${conversation}`, evidenceLine({ tasks, documentsAtEnd: documents(db, conversation, cutoff) }),
    ...entries.map(evidenceLine)];
  for (const child of children) {
    const id = Number(child.id);
    const start = db.prepare("SELECT MIN(commit_seq) AS seq FROM entries WHERE conversation_id=? AND commit_seq<=?").get(id, cutoff)?.seq;
    lines.push(evidenceLine({ child: id, ownerTask: child.owner_task_id, ...(start ? { documentsAtStart: documents(db, id, Number(start)) } : {}) }));
    // Only settled child receipts with an immutable entry inside the review window prove an outcome.
    const receipts = db.prepare("SELECT record FROM submissions WHERE conversation_id=? AND json_extract(record,'$.answer')<=?").all(id, last);
    lines.push(evidenceLine({ childReceipts: receipts.map(row => JSON.parse(String(row.record))) }));
    lines.push(...runHistory(db, id, 0, last, cutoff, endTime));
  }
  return lines;
}

function evidenceLine(value: unknown) { return JSON.stringify(redact(value)); }

/** All reads share a SQLite snapshot and the original run's inclusive end, even if another turn has since completed. */
export function runEvidence(database: string, run: ReviewRun, section: "run" | "context") {
  const db = openSqliteSnapshot(database);
  try {
    const point = db.prepare("SELECT commit_seq AS seq, json_extract(record,'$.model[0].timestamp') AS at FROM entries WHERE conversation_id=? AND id=?");
    const start = point.get(run.conversation, run.first), end = point.get(run.conversation, run.last);
    if (!start || !end || run.first > run.answer || run.answer > run.last) throw new Error("The run boundaries do not match this conversation.");
    const cutoff = Number(end.seq);
    if (section === "context") {
      return transcriptSegments(db, run.conversation).flatMap(segment =>
        transcript(db, segment.id, 0, Math.min(segment.through, run.first - 1), cutoff).map(evidenceLine)).join("\n");
    }
    const receipts = submissions(db, run.conversation, run.answer);
    const header = { run, completionEvidenceSequence: cutoff, receipts, documentsAtStart: documents(db, run.conversation, Number(start.seq)),
      coverage: "Includes the run's entries, system sections, tool calls and results, bounded owned children and retained document revisions. Earlier transcript is available as context. Binary media, private reasoning and opaque provider state are omitted. External artifacts are evidenced only to the extent recorded." };
    return [evidenceLine(header), ...runHistory(db, run.conversation, run.first, run.last, cutoff, typeof end.at === "number" ? end.at : undefined)].join("\n");
  } finally { db.close(); }
}
