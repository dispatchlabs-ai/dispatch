// Initial layout adapted from Pi Durable 1.0.4 (MIT); see NOTICE.
import type { Client } from "pg";

export const STORE_TABLES = ["durable_metadata", "record_ids", "conversations", "entries", "tasks", "submissions", "documents", "document_revisions"] as const;

const INITIAL_SCHEMA: readonly string[] = [
  `CREATE TABLE dispatch_pi.durable_metadata (
    store_id TEXT COLLATE "C" PRIMARY KEY,
    next_id BIGINT NOT NULL CHECK (next_id BETWEEN 2 AND 9007199254740992),
    next_seq BIGINT NOT NULL CHECK (next_seq BETWEEN 1 AND 9007199254740992)
  )`,
  `CREATE TABLE dispatch_pi.record_ids (
    store_id TEXT COLLATE "C" NOT NULL REFERENCES dispatch_pi.durable_metadata(store_id),
    id BIGINT NOT NULL,
    PRIMARY KEY (store_id, id),
    record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
  )`,
  `CREATE TABLE dispatch_pi.conversations (
    store_id TEXT COLLATE "C" NOT NULL REFERENCES dispatch_pi.durable_metadata(store_id),
    id BIGINT NOT NULL,
    PRIMARY KEY (store_id, id),
    owner_conversation_id BIGINT,
    owner_task_id BIGINT,
    record TEXT NOT NULL
  )`,
  `CREATE INDEX conversations_by_owner_conversation ON dispatch_pi.conversations (store_id, owner_conversation_id, id)`,
  `CREATE INDEX conversations_by_owner_task ON dispatch_pi.conversations (store_id, owner_task_id, id)`,
  `CREATE TABLE dispatch_pi.entries (
    store_id TEXT COLLATE "C" NOT NULL REFERENCES dispatch_pi.durable_metadata(store_id),
    id BIGINT NOT NULL,
    PRIMARY KEY (store_id, id),
    conversation_id BIGINT NOT NULL,
    head BIGINT,
    commit_seq BIGINT NOT NULL,
    record TEXT NOT NULL
  )`,
  `CREATE INDEX entries_by_conversation ON dispatch_pi.entries (store_id, conversation_id, id DESC)`,
  `CREATE INDEX entry_heads_by_conversation ON dispatch_pi.entries (store_id, conversation_id, id DESC) WHERE head IS NOT NULL`,
  `CREATE TABLE dispatch_pi.tasks (
    store_id TEXT COLLATE "C" NOT NULL REFERENCES dispatch_pi.durable_metadata(store_id),
    id BIGINT NOT NULL,
    PRIMARY KEY (store_id, id),
    conversation_id BIGINT NOT NULL,
    kind TEXT COLLATE "C" NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
    abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
    background INTEGER NOT NULL CHECK (background IN (0, 1)),
    record TEXT NOT NULL
  )`,
  `CREATE INDEX tasks_by_status ON dispatch_pi.tasks (store_id, status, id)`,
  `CREATE INDEX tasks_by_conversation ON dispatch_pi.tasks (store_id, conversation_id, id)`,
  `CREATE INDEX tasks_by_abort_requested ON dispatch_pi.tasks (store_id, abort_requested, id)`,
  `CREATE INDEX tasks_by_background ON dispatch_pi.tasks (store_id, background, id)`,
  `CREATE TABLE dispatch_pi.submissions (
    store_id TEXT COLLATE "C" NOT NULL REFERENCES dispatch_pi.durable_metadata(store_id),
    id BIGINT NOT NULL,
    PRIMARY KEY (store_id, id),
    conversation_id BIGINT NOT NULL,
    request_id TEXT COLLATE "C",
    status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
    record TEXT NOT NULL
  )`,
  `CREATE INDEX submissions_by_conversation ON dispatch_pi.submissions (store_id, conversation_id, id)`,
  `CREATE INDEX submissions_by_status ON dispatch_pi.submissions (store_id, status, id)`,
  `CREATE TABLE dispatch_pi.documents (
    store_id TEXT COLLATE "C" NOT NULL REFERENCES dispatch_pi.durable_metadata(store_id),
    id BIGINT NOT NULL,
    PRIMARY KEY (store_id, id),
    kind TEXT COLLATE "C" NOT NULL,
    family INTEGER NOT NULL CHECK (family IN (0, 1)),
    key_value TEXT COLLATE "C" NOT NULL,
    scope_kind TEXT COLLATE "C" NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
    owner_id BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    retired_at BIGINT,
    record TEXT NOT NULL
  )`,
  // Opaque kinds/keys/request IDs are unbounded. Keep them out of B-tree keys.
  `CREATE INDEX documents_by_address
    ON dispatch_pi.documents (store_id, scope_kind, owner_id, family, created_at DESC, retired_at)`,
  `CREATE INDEX documents_by_scope ON dispatch_pi.documents (store_id, scope_kind, owner_id, id)`,
  `CREATE TABLE dispatch_pi.document_revisions (
    store_id TEXT COLLATE "C" NOT NULL REFERENCES dispatch_pi.durable_metadata(store_id),
    document_id BIGINT NOT NULL,
    seq BIGINT NOT NULL,
    kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('base', 'delta')),
    version BIGINT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (store_id, document_id, seq)
  )`,
  `CREATE INDEX document_revisions_by_kind ON dispatch_pi.document_revisions (store_id, document_id, kind, seq DESC)`,
];


/** Run on the dedicated connection before it is exposed to Storage. */
export async function migrate(client: Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await migrateWithinTransaction(client);
    await client.query("COMMIT");
  } catch (error) {
    // The connection is discarded on any initialization error, including uncertain COMMIT.
    try { await client.query("ROLLBACK"); } catch { /* Preserve initialization failure. */ }
    throw error;
  }
}

/** Caller owns BEGIN/COMMIT, allowing the worker schema and RLS to publish atomically. */
export async function migrateWithinTransaction(client: Client): Promise<void> {
  // Serialize schema installation across stores/processes in this database.
  await client.query("SELECT pg_advisory_xact_lock(1684632432, 1)");
  await client.query("CREATE SCHEMA IF NOT EXISTS dispatch_pi");
  await client.query(`CREATE TABLE IF NOT EXISTS dispatch_pi.schema_version (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version >= 0)
  )`);
  await client.query("INSERT INTO dispatch_pi.schema_version VALUES (1, 0) ON CONFLICT DO NOTHING");
  const { rows } = await client.query<{ version: number }>("SELECT version FROM dispatch_pi.schema_version WHERE singleton = 1");
  const version = rows[0]?.version;
  if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported PostgreSQL Pi schema version");
  if (version === 0) {
    for (const statement of INITIAL_SCHEMA) await client.query(statement);
  }
  if (version === 1) {
    await client.query(`ALTER TABLE dispatch_pi.tasks
      DROP CONSTRAINT tasks_status_check,
      ADD CONSTRAINT tasks_status_check CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal'))`);
  }
  if (version < 2) await client.query("UPDATE dispatch_pi.schema_version SET version = 2 WHERE singleton = 1");
}
