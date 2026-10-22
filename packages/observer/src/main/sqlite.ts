import { DatabaseSync } from "node:sqlite";
import { readRecords } from "./records";
import type { RawReadRequest } from "../shared/contracts";

export async function readSqlite(path: string, request: RawReadRequest) {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=3000; BEGIN");
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='durable_schema'",
      )
      .get();
    const schema = table
      ? db.prepare("SELECT version FROM durable_schema WHERE singleton=1").get()
      : undefined;
    if (schema?.version !== 1)
      throw new Error(
        "Unsupported SQLite schema. Observer reads Pi Durable schema 1 (1.1–1.3); it never migrates a database.",
      );
    return await readRecords(
      {
        table: (name) => name,
        scope: "1=1",
        rows: async (sql, ...values) => db.prepare(sql).all(...values),
      },
      request,
    );
  } finally {
    db.close();
  }
}
