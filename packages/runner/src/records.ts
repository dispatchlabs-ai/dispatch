import { DatabaseSync } from "node:sqlite";
import { apply, type Op } from "@earendil-works/chord/delta";
import type { ConversationRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";

/** Read native committed state without acquiring execution ownership or changing schema. */
export function openSqliteSnapshot(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    const version = db.prepare("SELECT version FROM durable_schema WHERE singleton=1").get()?.version;
    if (version !== 1 && version !== 2) throw new Error("Unsupported Pi Durable SQLite schema. This reader supports schemas 1 and 2 and never changes them.");
    return db;
  } catch (error) { db.close(); throw error; }
}

export type DocumentRevision = { seq: number; kind: string; version: number; content: unknown };

/** Reconstruct retained revisions using the released Chord delta contract. */
export function replayDocument(revisions: readonly DocumentRevision[]) {
  const base = revisions.findLast(revision => revision.kind === "base");
  if (!base) throw new Error("No retained base revision.");
  let value = structuredClone(base.content) as JsonValue, sequence = base.seq;
  for (const revision of revisions) {
    if (revision.seq <= base.seq) continue;
    if (revision.seq <= sequence || revision.kind !== "delta" || revision.version !== base.version)
      throw new Error("Unsupported document revision boundary.");
    if (!Array.isArray(revision.content)) throw new Error("Invalid native document delta.");
    for (const op of revision.content) {
      if (!Array.isArray(op) || (op[0] !== "r" && (!Array.isArray(op[1]) ||
        op[1].some((key: unknown) => ["__proto__", "prototype", "constructor"].includes(String(key))))))
        throw new Error("Invalid native document path.");
    }
    value = apply(value, revision.content as Op[]);
    sequence = revision.seq;
  }
  return { value, sequence, version: base.version };
}

export function readSqliteDocument(db: DatabaseSync, id: number, at = Number.MAX_SAFE_INTEGER) {
  const rows = db.prepare(`SELECT seq,kind,version,content FROM document_revisions
    WHERE document_id=? AND seq<=? AND seq>=COALESCE((SELECT MAX(seq) FROM document_revisions
      WHERE document_id=? AND kind='base' AND seq<=?),0) ORDER BY seq`).all(id, at, id, at);
  return replayDocument(rows.map(row => ({ seq: Number(row.seq), kind: String(row.kind),
    version: Number(row.version), content: JSON.parse(String(row.content)) })));
}

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

/** Visible fork ancestry, oldest first. A parent contributes only through the fork point. */
export function transcriptSegments(db: DatabaseSync, id: number) {
  const segments: { id: number; through: number }[] = [];
  const seen = new Set<number>();
  let through = Number.MAX_SAFE_INTEGER;
  for (;;) {
    if (seen.has(id)) throw new Error("Invalid fork ancestry.");
    seen.add(id);
    const row = db.prepare("SELECT record FROM conversations WHERE id=?").get(id);
    if (!row) throw new Error("Missing conversation in the source store.");
    const { parent } = JSON.parse(String(row.record)) as ConversationRecord;
    segments.unshift({ id, through });
    if (!parent) return segments;
    through = Math.min(through, parent.at);
    id = parent.conversationId;
  }
}
