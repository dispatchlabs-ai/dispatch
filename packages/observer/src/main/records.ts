import type {
  RawSnapshot,
  RawReadRequest,
  RecordData,
} from "../shared/contracts";

type Row = Record<string, unknown>;
export interface Query {
  rows(sql: string, ...values: (number | string)[]): Promise<Row[]>;
  table(name: string): string;
  scope: string;
}
const record = (row: Row): RecordData => JSON.parse(String(row.record));
const number = (value: unknown) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("A stored identifier exceeds the supported numeric range.");
  return result;
};

/** Fixed queries only, inside a short caller-owned read-only snapshot. */
export async function readRecords(
  query: Query,
  request: RawReadRequest,
): Promise<RawSnapshot> {
  const { table, scope } = query;
  const rows = (sql: string, ...values: (number | string)[]) =>
    query.rows(sql, ...values);
  const [metadata] = await rows(
    `SELECT next_seq FROM ${table("durable_metadata")} WHERE ${scope}`,
  );
  if (!metadata)
    throw new Error(
      "This logical Pi store does not exist or is not visible to this database identity.",
    );
  const sequence = number(metadata.next_seq) - 1;
  if (request.since === sequence)
    return {
      sequence,
      observedAt: new Date().toISOString(),
      conversations: [],
      entries: [],
      tasks: [],
      documents: [],
      hasEarlier: false,
      unchanged: true,
    };
  const conversations = await rows(`SELECT c.record,
    (SELECT COUNT(*) FROM ${table("entries")} e WHERE ${scope.replaceAll("store_id", "e.store_id")} AND e.conversation_id=c.id) AS entry_count,
    (SELECT e.record FROM ${table("entries")} e WHERE ${scope.replaceAll("store_id", "e.store_id")} AND e.conversation_id=c.id ORDER BY e.commit_seq DESC,e.id DESC LIMIT 1) AS latest_entry,
    (SELECT COUNT(*) FROM ${table("tasks")} t WHERE ${scope.replaceAll("store_id", "t.store_id")} AND t.conversation_id=c.id AND t.status<>'terminal') AS active,
    (SELECT COUNT(*) FROM ${table("tasks")} t WHERE ${scope.replaceAll("store_id", "t.store_id")} AND t.conversation_id=c.id AND t.status='terminal' AND t.record LIKE '%"status":"failed"%') AS failed
    FROM ${table("conversations")} c WHERE ${scope.replaceAll("store_id", "c.store_id")} ORDER BY c.id DESC`);
  const result: RawSnapshot = {
    sequence,
    observedAt: new Date().toISOString(),
    conversations: conversations.map((row) => ({
      record: record(row),
      entryCount: number(row.entry_count),
      latestEntry: row.latest_entry
        ? JSON.parse(String(row.latest_entry))
        : undefined,
      active: number(row.active),
      failed: number(row.failed),
    })),
    entries: [],
    tasks: [],
    documents: [],
    hasEarlier: false,
  };
  if (request.conversationId === undefined) return result;
  const byId = new Map(
    result.conversations.map((item) => [item.record.id, item.record]),
  );
  if (!byId.has(request.conversationId))
    throw new Error(
      "This conversation is no longer available in the selected store.",
    );
  const selected = new Set<number>([request.conversationId]);
  // Only native owner edges establish descendants. Fork ancestry is separate.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of byId.values())
      if (
        item.owner &&
        selected.has(item.owner.conversationId) &&
        !selected.has(item.id)
      ) {
        selected.add(item.id);
        changed = true;
      }
  }
  const visible = new Map(
    [...selected].map((id) => [id, Number.MAX_SAFE_INTEGER]),
  );
  let ancestor = byId.get(request.conversationId)!;
  const seen = new Set<number>();
  let through = Number.MAX_SAFE_INTEGER;
  while (ancestor.parent) {
    if (seen.has(ancestor.id))
      throw new Error("Invalid circular fork ancestry in saved records.");
    seen.add(ancestor.id);
    through = Math.min(through, ancestor.parent.at);
    const parent = byId.get(ancestor.parent.conversationId);
    if (!parent) break;
    if (!selected.has(parent.id))
      visible.set(parent.id, Math.max(visible.get(parent.id) ?? 0, through));
    ancestor = parent;
  }
  const clauses = [...visible]
    .map(() => "(conversation_id=? AND id<=?)")
    .join(" OR ");
  const values = [...visible].flatMap(([id, at]) => [id, at]);
  const entries = await rows(
    `SELECT record,commit_seq FROM ${table("entries")} WHERE ${scope} AND (${clauses}) ${request.before ? "AND (commit_seq<? OR (commit_seq=? AND id<?))" : ""} ORDER BY commit_seq DESC,id DESC LIMIT ?`,
    ...values,
    ...(request.before
      ? [
          request.before.sequence,
          request.before.sequence,
          request.before.entryId,
        ]
      : []),
    request.limit + 1,
  );
  result.hasEarlier = entries.length > request.limit;
  result.entries = entries
    .slice(0, request.limit)
    .reverse()
    .map((row) => {
      const value = record(row);
      return {
        record: value,
        sequence: number(row.commit_seq),
        inherited: !selected.has(value.conversationId),
      };
    });
  const ids = [...selected];
  const placeholders = ids.map(() => "?").join(",");
  result.tasks = (
    await rows(
      `SELECT record FROM ${table("tasks")} WHERE ${scope} AND conversation_id IN (${placeholders}) ORDER BY id`,
      ...ids,
    )
  ).map(record);
  const taskIds = result.tasks.map((task) => task.id as number);
  const docs = await rows(
    `SELECT record FROM ${table("documents")} WHERE ${scope} AND kind<>? AND (scope_kind='session' OR (scope_kind='conversation' AND owner_id IN (${placeholders})) ${taskIds.length ? `OR (scope_kind='task' AND owner_id IN (${taskIds.map(() => "?").join(",")}))` : ""}) ORDER BY id`,
    JSON.stringify("pi.provider"),
    ...ids,
    ...taskIds,
  );
  const selectedDocs = docs
    .map(record)
    .filter(
      (doc) =>
        doc.kind !== "pi.provider" &&
        !/credential|secret|auth-token/i.test(doc.kind),
    );
  if (selectedDocs.length) {
    const revisions = await rows(
      `SELECT r.document_id,r.seq,r.kind,r.version,r.content FROM ${table("document_revisions")} r WHERE ${scope.replaceAll("store_id", "r.store_id")} AND r.document_id IN (${selectedDocs.map(() => "?").join(",")}) AND r.seq >= COALESCE((SELECT MAX(b.seq) FROM ${table("document_revisions")} b WHERE ${scope.replaceAll("store_id", "b.store_id")} AND b.document_id=r.document_id AND b.kind='base'),0) ORDER BY r.document_id,r.seq`,
      ...selectedDocs.map((doc) => doc.id),
    );
    const grouped = new Map<
      number,
      RawSnapshot["documents"][number]["revisions"]
    >();
    for (const revision of revisions) {
      const id = number(revision.document_id),
        list = grouped.get(id) ?? [];
      list.push({
        seq: number(revision.seq),
        kind: String(revision.kind),
        version: number(revision.version),
        content: JSON.parse(String(revision.content)),
      });
      grouped.set(id, list);
    }
    result.documents = selectedDocs.map((doc) => ({
      record: doc,
      revisions: grouped.get(doc.id) ?? [],
    }));
  }
  return result;
}
