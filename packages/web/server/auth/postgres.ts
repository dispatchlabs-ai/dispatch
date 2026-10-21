import { Client, types, type ClientConfig } from "pg";
import { AsyncAuthStore, type AuthValue } from "./store.js";
import { AUTH_SCHEMA } from "./schema.js";

export interface PostgresAuthOptions {
  database: ClientConfig;
  installationId: string;
  companyId: string;
  keyFingerprint: string;
}

/** One installation per dedicated auth database; operator and backend share transaction locking. */
export class PostgresAuthStore extends AsyncAuthStore {
  private constructor(private readonly client: Client) {
    super();
    client.on("error", error => { this.failure ??= new Error("Authentication database connection lost", { cause: error }); });
    client.on("end", () => { this.failure ??= new Error("Authentication database connection ended"); });
  }

  static async open(options: PostgresAuthOptions): Promise<PostgresAuthStore> {
    if (!options.installationId.trim() || !options.companyId.trim()) throw new Error("Authentication installation and company identity are required");
    const client = new Client({
      ...options.database,
      application_name: "dispatch-auth",
      connectionTimeoutMillis: 60_000,
      keepAlive: true,
      types: { getTypeParser(oid, format) {
        if (oid === 20 && format !== "binary") return (value: string) => {
          const number = Number(value);
          if (!Number.isSafeInteger(number)) throw new Error("Authentication integer exceeds the safe numeric range");
          return number;
        };
        return types.getTypeParser(oid, format);
      } },
    });
    const store = new PostgresAuthStore(client);
    try {
      await client.connect();
      await store.transaction(async () => {
        await client.query("CREATE SCHEMA IF NOT EXISTS dispatch_auth; REVOKE ALL ON SCHEMA dispatch_auth FROM PUBLIC; SET LOCAL search_path TO dispatch_auth, pg_catalog");
        await client.query(`CREATE TABLE IF NOT EXISTS auth_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL, installation_id TEXT NOT NULL, company_id TEXT NOT NULL, key_fingerprint TEXT NOT NULL
        )`);
        const identity = await client.query<{ version: number; installation_id: string; company_id: string; key_fingerprint: string }>("SELECT * FROM auth_identity WHERE singleton = 1");
        const row = identity.rows[0];
        if (row && (row.version !== 1 || row.installation_id !== options.installationId || row.company_id !== options.companyId || row.key_fingerprint !== options.keyFingerprint)) {
          throw new Error("Authentication database identity or encryption key mismatch; restore the matching database/key pair");
        }
        if (!row) {
          const existing = await client.query("SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'dispatch_auth' AND tablename <> 'auth_identity' LIMIT 1");
          if (existing.rowCount) throw new Error("Authentication tables lack installation identity; refusing implicit adoption");
          await client.query("INSERT INTO auth_identity VALUES (1, 1, $1, $2, $3)", [options.installationId, options.companyId, options.keyFingerprint]);
        }
        await client.query(AUTH_SCHEMA.replace(/\bINTEGER\b/g, "BIGINT"));
      });
      return store;
    } catch (error) {
      await store.close().catch(() => {});
      throw error;
    }
  }

  protected async execute(sql: string, parameters: AuthValue[]) {
    this.assertHealthy();
    let index = 0;
    // Repository-owned statements only; no SQL literals containing question marks.
    const query = sql.replace(/\?/g, () => `$${++index}`).replace(/name COLLATE NOCASE/g, "lower(name)");
    if (index !== parameters.length) throw new Error("Invalid authentication parameter count");
    const result = await this.client.query(query, parameters);
    return { rows: result.rows, changes: result.rowCount ?? 0 };
  }
  protected async begin() {
    await this.client.query("BEGIN");
    try {
      // All adapters use this database-scoped lock, including standalone operator invocations.
      await this.client.query("SELECT pg_advisory_xact_lock(1684108385, 1970563176)");
      await this.client.query("SET LOCAL search_path TO dispatch_auth, pg_catalog");
    } catch (error) {
      await this.client.query("ROLLBACK").catch(() => { this.failure = new Error("Authentication transaction startup failed", { cause: error }); });
      throw error;
    }
  }
  protected async commit() {
    const result = await this.client.query("COMMIT");
    if (result.command !== "COMMIT") throw new Error("Authentication COMMIT was not acknowledged");
  }
  protected async rollback() { await this.client.query("ROLLBACK"); this.assertHealthy(); }
  protected async disconnect() { await this.client.end(); }
}
