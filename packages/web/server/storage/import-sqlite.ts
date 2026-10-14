import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client, types } from "pg";
import { migrateWithinTransaction } from "./postgres/migrations.js";

// Offline administration only. This never opens a Harness or alters the source.
const layouts = {
  record_ids: ["id", "record_type"],
  conversations: ["id", "owner_conversation_id", "owner_task_id", "record"],
  entries: ["id", "conversation_id", "head", "commit_seq", "record"],
  tasks: ["id", "conversation_id", "kind", "status", "abort_requested", "background", "record"],
  submissions: ["id", "conversation_id", "request_id", "status", "record"],
  documents: ["id", "kind", "family", "key_value", "scope_kind", "owner_id", "created_at", "retired_at", "record"],
  document_revisions: ["document_id", "seq", "kind", "version", "content"],
} as const;

/** Import an idle schema-v1 snapshot into an empty dedicated PostgreSQL database. */
export async function importSqlite(filename: string, connectionString: string, storeId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(storeId)) throw new Error("Invalid store ID");
  const source = new DatabaseSync(filename, { readOnly: true });
  const target = new Client({ connectionString, application_name: "dispatch-offline-import", types: {
    getTypeParser(oid, format) {
      if (oid === 20 && format !== "binary") return (value: string) => {
        const n = Number(value);
        if (!Number.isSafeInteger(n)) throw new Error("Integer outside supported range");
        return n;
      };
      return types.getTypeParser(oid, format);
    },
  } });
  const receipts: Record<string, { rows: number; sha256: string }> = {};
  try {
    source.exec("BEGIN");
    if (source.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("SQLite integrity check failed");
    if (source.prepare("SELECT version FROM durable_schema WHERE singleton=1").get()?.version !== 1) throw new Error("Unsupported SQLite schema");
    const expectedTables = ["durable_schema", "durable_metadata", ...Object.keys(layouts)].sort();
    const actualTables = source.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) throw new Error("Unexpected SQLite tables");
    if (source.prepare("SELECT 1 FROM tasks WHERE status != 'terminal' LIMIT 1").get()
      || source.prepare("SELECT 1 FROM submissions WHERE status IN ('queued','placed') LIMIT 1").get()) {
      throw new Error("Source must be idle: settle tasks and submissions before taking the snapshot");
    }
    const metadata = source.prepare("SELECT next_id,next_seq FROM durable_metadata WHERE singleton=1").get();
    if (!metadata) throw new Error("Missing source metadata");
    const nextId = Number(metadata.next_id), nextSeq = Number(metadata.next_seq);
    if (!Number.isSafeInteger(nextId) || !Number.isSafeInteger(nextSeq)) throw new Error("Invalid source counters");
    await target.connect();
    await target.query("BEGIN");
    const key = createHash("sha256").update(`dispatch-pi-store:${storeId}`).digest().readBigInt64BE().toString();
    const lock = await target.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired", [key]);
    if (!lock.rows[0]?.acquired) throw new Error("Target store has an owner");
    await migrateWithinTransaction(target);
    // Migration is a new-database operation, never an append or replacement.
    await target.query("LOCK TABLE dispatch_pi.durable_metadata IN ACCESS EXCLUSIVE MODE");
    if ((await target.query("SELECT 1 FROM dispatch_pi.durable_metadata LIMIT 1")).rowCount) throw new Error("Target database already contains a store");
    await target.query("INSERT INTO dispatch_pi.durable_metadata VALUES ($1,$2,$3)", [storeId,nextId,nextSeq]);
    for (const [table, columns] of Object.entries(layouts)) {
      const actualColumns = source.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      if (JSON.stringify(actualColumns) !== JSON.stringify(columns)) throw new Error(`Unexpected columns in ${table}`);
      const order = table === "document_revisions" ? "document_id,seq" : "id";
      const fields = columns.join(",");
      const digest = createHash("sha256");
      let count = 0;
      let batch: unknown[][] = [];
      const flush = async () => {
        if (!batch.length) return;
        const values = batch.flat();
        const width = columns.length + 1;
        const placeholders = batch.map((_, i) => `(${Array.from({length:width}, (_,j) => `$${i*width+j+1}`).join(",")})`).join(",");
        await target.query(`INSERT INTO dispatch_pi.${table} (store_id,${fields}) VALUES ${placeholders}`, values);
        batch = [];
      };
      for (const row of source.prepare(`SELECT ${fields} FROM ${table} ORDER BY ${order}`).iterate()) {
        const values = columns.map(column => row[column]);
        digest.update(JSON.stringify(values) + "\n");
        batch.push([storeId,...values]);
        count++;
        if (batch.length === 250) await flush();
      }
      await flush();
      const expected = digest.digest("hex");
      const readback = createHash("sha256");
      let readCount = 0;
      await target.query(`DECLARE imported_rows NO SCROLL CURSOR FOR SELECT ${fields} FROM dispatch_pi.${table} WHERE store_id=$1 ORDER BY ${order}`, [storeId]);
      while (true) {
        const result = await target.query("FETCH 250 FROM imported_rows");
        if (!result.rows.length) break;
        for (const row of result.rows) {
          readback.update(JSON.stringify(columns.map(column => row[column])) + "\n");
          readCount++;
        }
      }
      await target.query("CLOSE imported_rows");
      if (count !== readCount || expected !== readback.digest("hex")) throw new Error(`Readback mismatch in ${table}`);
      receipts[table] = { rows: count, sha256: expected };
    }
    const { rows: [saved] } = await target.query("SELECT next_id,next_seq FROM dispatch_pi.durable_metadata WHERE store_id=$1", [storeId]);
    if (saved.next_id !== nextId || saved.next_seq !== nextSeq) throw new Error("Metadata readback mismatch");
    await target.query("COMMIT");
    return { storeId, nextId, nextSeq, tables: receipts };
  } catch (error) {
    await target.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await target.end().catch(() => {});
    source.close();
  }
}
