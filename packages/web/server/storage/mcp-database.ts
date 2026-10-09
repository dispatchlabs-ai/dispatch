import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Client, types, type ClientConfig } from "pg";
import type { ConnectionAuthentication, ConnectionAuthorizationState } from "../../src/shared/contracts.js";

export type ConnectionRow = {
  id: string; company_id: string; owner_id: string; name: string; endpoint: string;
  state: ConnectionAuthorizationState; authentication: ConnectionAuthentication; provider: string;
  config: string; secret: string | null; identity: string; server_name: string;
  upstream_agent: string; upstream_run: string; scopes: string; created_at: number;
  error: string | null; refreshing: number; disconnect_notice: string | null;
};
export type McpQuery = <T extends object = Record<string, unknown>>(sql: string, values?: SQLInputValue[]) => Promise<T[]>;

export const MCP_SCHEMA = `CREATE TABLE IF NOT EXISTS integration_secrets (
  company_id TEXT NOT NULL, owner_id TEXT NOT NULL, source TEXT NOT NULL, secret TEXT, revision INTEGER NOT NULL,
  PRIMARY KEY(company_id, owner_id)
);
CREATE TABLE IF NOT EXISTS integration_secret_grants (
  company_id TEXT NOT NULL, definition_id TEXT NOT NULL, owner_id TEXT NOT NULL, active INTEGER NOT NULL,
  PRIMARY KEY(company_id, definition_id)
);
CREATE TABLE IF NOT EXISTS mcp_connections (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  name TEXT NOT NULL, endpoint TEXT NOT NULL, state TEXT NOT NULL,
  authentication TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', config TEXT NOT NULL,
  secret TEXT, identity TEXT NOT NULL DEFAULT '', server_name TEXT NOT NULL DEFAULT '',
  upstream_agent TEXT NOT NULL DEFAULT '', upstream_run TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL, created_at INTEGER NOT NULL, error TEXT, refreshing INTEGER NOT NULL DEFAULT 0, disconnect_notice TEXT
);
CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
  state_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
  session_id TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL,
  request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, authorization_url TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id, request_id)
);
CREATE TABLE IF NOT EXISTS mcp_connection_requests (
  session_id TEXT NOT NULL, request_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
  fingerprint TEXT NOT NULL, PRIMARY KEY(session_id,request_id)
);`;

export type McpPostgresOptions = { database: ClientConfig; installationId: string; encryptionKey: Buffer; recoverOwnerId?: string };

/** Single-owner persistence with a committed connection-record read cache.
 * Cached authorization is never served after a detected database/commit failure.
 * write() owns complete SQL transactions; its callback must not perform network effects.
 */
export class McpDatabase {
  private tail: Promise<void> = Promise.resolve();
  private failure?: Error;
  private closing?: Promise<void>;
  private records = new Map<string, ConnectionRow>();
  private constructor(private readonly sqlite?: DatabaseSync, private readonly postgres?: Client,
    readonly ownerId?: string, private readonly installationId?: string) {
    postgres?.on("error", () => { this.failure ??= new Error("MCP database connection lost; retire owner before recovery."); });
    postgres?.on("end", () => { this.failure ??= new Error("MCP database connection ended."); });
  }

  static sqlite(database: DatabaseSync) {
    const store = new McpDatabase(database);
    store.records = new Map((database.prepare("SELECT * FROM mcp_connections").all() as ConnectionRow[]).map(row => [row.id, row]));
    return store;
  }

  static async openPostgres(options: McpPostgresOptions) {
    if (!options.installationId || options.installationId.length > 200 || options.encryptionKey.length !== 32)
      throw new Error("MCP storage requires an installation and an external 32-byte key.");
    const client = new Client({ connectionTimeoutMillis: 10_000, ...options.database, application_name: "dispatch-mcp-connections",
      types: { getTypeParser: (oid, format) => oid === 20 ? (value: string) => {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error("Unsafe MCP integer.");
        return number;
      } : types.getTypeParser(oid, format) },
    });
    const store = new McpDatabase(undefined, client, randomUUID(), options.installationId);
    try {
      await client.connect();
      const [lock] = await store.raw<{ held: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('dispatch-mcp-connections-owner', 0)) AS held");
      if (!lock?.held) throw new Error("MCP owner already exists.");
      await store.raw("BEGIN");
      await store.raw(`CREATE SCHEMA IF NOT EXISTS dispatch_mcp;
        REVOKE ALL ON SCHEMA dispatch_mcp FROM PUBLIC;
        SET search_path TO dispatch_mcp, pg_catalog;
        CREATE TABLE IF NOT EXISTS identity (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), installation TEXT NOT NULL,
          key_hash TEXT NOT NULL, owner_id TEXT
        ); ${MCP_SCHEMA.replaceAll("INTEGER", "BIGINT")}`);
      const keyHash = createHmac("sha256", options.encryptionKey).update(JSON.stringify(["dispatch-mcp-key:v1", options.installationId])).digest("hex");
      const [identity] = await store.raw<{ installation: string; key_hash: string; owner_id: string | null }>("SELECT * FROM identity WHERE singleton=1 FOR UPDATE");
      if (identity) {
        if (identity.installation !== options.installationId || identity.key_hash !== keyHash) throw new Error("MCP installation/key mismatch.");
        if (identity.owner_id && identity.owner_id !== options.recoverOwnerId) throw new Error("Previous MCP owner requires confirmed retirement.");
        if (options.recoverOwnerId && identity.owner_id !== options.recoverOwnerId) throw new Error("MCP recovery identity mismatch.");
      } else {
        if (options.recoverOwnerId) throw new Error("Cannot recover an unknown MCP installation.");
        await store.raw("INSERT INTO identity (singleton,installation,key_hash) VALUES (1,$1,$2)", [options.installationId, keyHash]);
      }
      await store.raw("UPDATE identity SET owner_id=$1 WHERE singleton=1", [store.ownerId!]);
      // Recovery changes local status only. No token refresh, revocation or network.
      await store.raw("UPDATE mcp_connections SET state='reauthorize',refreshing=0,error=$1 WHERE refreshing=1", ["Credential renewal was interrupted. Authorize this connection again."]);
      await store.raw(`UPDATE mcp_connections SET state='reauthorize',error=$1 WHERE state='pending' AND NOT EXISTS
        (SELECT 1 FROM mcp_oauth_pending WHERE connection_id=mcp_connections.id AND consumed=0 AND expires_at>$2)`, ["Authorization was interrupted or expired. Authorize this connection again.", Date.now()]);
      const rows = await store.raw<ConnectionRow>("SELECT * FROM mcp_connections");
      await store.raw("COMMIT");
      store.assertHealthy();
      store.records = new Map(rows.map(row => [row.id, row]));
      return store;
    } catch {
      await client.end().catch(() => {});
      throw new Error("Cannot open MCP database; check ownership, external key and confirmed retired-owner recovery.");
    }
  }

  get healthy() { return !this.failure && !this.closing; }
  assertHealthy() { if (this.failure) throw this.failure; }
  row(id: string) { this.assertHealthy(); const row = this.records.get(id); return row ? { ...row } : undefined; }
  list() { this.assertHealthy(); return [...this.records.values()].map(row => ({ ...row })); }

  private raw: McpQuery = async <T extends object>(sql: string, values: SQLInputValue[] = []): Promise<T[]> => {
    this.assertHealthy();
    try {
      if (this.sqlite) {
        // Source-controlled SQL uses numbered parameters in both backends. Bind
        // in occurrence order for SQLite, including any repeated placeholders.
        const bindings: SQLInputValue[] = [];
        const statement = sql.replace(/\$(\d+)/g, (_match, number: string) => { bindings.push(values[Number(number) - 1]!); return "?"; });
        return this.sqlite.prepare(statement).all(...bindings) as T[];
      }
      const result = await this.postgres!.query(sql, values);
      this.assertHealthy();
      return (Array.isArray(result) ? [] : result.rows) as T[];
    } catch {
      this.failure ??= new Error("MCP database operation failed; outcome may be uncertain. Retire owner before recovery.");
      throw this.failure;
    }
  };

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("MCP database is closing."));
    const result = this.tail.then(() => { this.assertHealthy(); return operation(); });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  read<T extends object>(sql: string, values?: SQLInputValue[]): Promise<T[]> {
    return this.enqueue(() => this.raw<T>(sql, values));
  }

  write<T>(ids: string[], operation: (query: McpQuery) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      try {
        await this.raw(this.sqlite ? "BEGIN IMMEDIATE" : "BEGIN");
        if (this.postgres) {
          const rows = await this.raw("SELECT singleton FROM identity WHERE singleton=1 AND installation=$1 AND owner_id=$2 FOR UPDATE", [this.installationId!, this.ownerId!]);
          if (rows.length !== 1) throw new Error("MCP database ownership changed.");
        }
        const result = await operation(this.raw);
        const changed: ConnectionRow[] = [];
        for (const id of new Set(ids)) {
          const [row] = await this.raw<ConnectionRow>("SELECT * FROM mcp_connections WHERE id=$1", [id]);
          if (!row) throw new Error("MCP connection disappeared during mutation.");
          changed.push(row);
        }
        await this.raw("COMMIT");
        this.assertHealthy();
        // Synchronous publication of the complete transaction while queue-owned.
        for (const row of changed) this.records.set(row.id, row);
        return result;
      } catch {
        // Even a rejected/uncertain commit invalidates every cached authorization.
        // Seal synchronous cache reads before rollback can yield, including when
        // ownership validation (rather than raw SQL) caused the failure.
        this.failure ??= new Error("MCP transaction failed; cached authorization is disabled until recovery.");
        // Rollback uses the underlying connection because raw() is now poisoned.
        try { if (this.sqlite) this.sqlite.exec("ROLLBACK"); else await this.postgres!.query("ROLLBACK"); } catch {}
        throw this.failure;
      }
    });
  }

  async flush() { await this.tail; this.assertHealthy(); }

  close() {
    this.closing ??= this.tail.then(async () => {
      try {
        if (this.postgres && !this.failure) await this.raw("UPDATE identity SET owner_id=NULL WHERE singleton=1 AND installation=$1 AND owner_id=$2", [this.installationId!, this.ownerId!]);
      } finally {
        try { if (this.sqlite) this.sqlite.close(); else await this.postgres!.end(); }
        finally { this.records.clear(); }
      }
    });
    return this.closing;
  }
}
