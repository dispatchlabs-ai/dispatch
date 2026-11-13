import { openSqliteSnapshot } from "@dispatch/runner/records";
import { readRecords } from "./records";
import type { RawReadRequest } from "../shared/contracts";

export async function readSqlite(path: string, request: RawReadRequest) {
  const db = openSqliteSnapshot(path);
  try {
    return await readRecords(
      {
        table: (name) => name,
        scope: "1=1",
        instanceMessage: `json_extract(record, '$.kind') LIKE '%.instance-message'`,
        assistantEntry: `json_extract(e.record, '$.kind')='pi.assistant'`,
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
