import { DatabaseSync } from "node:sqlite";
import { apply, type Op } from "@earendil-works/chord/delta";
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
