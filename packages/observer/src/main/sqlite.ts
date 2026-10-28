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
    if (schema?.version !== 1 && schema?.version !== 2)
      throw new Error(
        "Unsupported SQLite schema. Observer reads Pi Durable schemas 1 and 2 (1.1–1.4); it never migrates a database.",
      );
    return await readRecords(
      {
        table: (name) => name,
        scope: "1=1",
        assistantText: `EXISTS (SELECT 1 FROM json_each(e.record, '$.model') m
          WHERE json_extract(m.value, '$.role')='assistant' AND (
            (json_type(m.value, '$.content')='text' AND length(trim(json_extract(m.value, '$.content')))>0)
            OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(m.value, '$.content')='array' THEN json_extract(m.value, '$.content') ELSE '[]' END) p
              WHERE json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END, '$.type')='text' AND length(trim(json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END, '$.text')))>0)))`,
        rows: async (sql, ...values) => db.prepare(sql).all(...values),
      },
      request,
    );
  } finally {
    db.close();
  }
}
