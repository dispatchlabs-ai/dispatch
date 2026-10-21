import { createHash, createHmac } from "node:crypto";
import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { verifiedPostgresConfig } from "../storage/postgres/tls.js";
import { migrateWithinTransaction, STORE_TABLES } from "../storage/postgres/migrations.js";

const tables = STORE_TABLES;
export type WorkerStoreConfig = { kind: "postgres"; storeId: string; connectionString: string; ca?: string; access: "worker" };
export type WorkerStoreProvisionerOptions = { connectionString: string; ca?: string; installationId: string; credentialKey: string };
const storePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Backend-only provisioning in a dedicated database. RLS uses SESSION_USER, never a caller-set GUC.
 * Role/mapping/privilege publication is transactional. Uncertain outcomes poison this connection;
 * reopen and reconcile the same deterministic role, never issue a new store identity on timeout.
 */
export class WorkerStoreProvisioner {
  private tail: Promise<unknown> = Promise.resolve();
  private failure?: Error;
  private closing?: Promise<void>;
  private constructor(private readonly client: Client, private readonly options: WorkerStoreProvisionerOptions) {
    client.on("error", () => { this.failure ??= new Error("Worker provisioning connection lost."); });
    client.on("end", () => { this.failure ??= new Error("Worker provisioning connection ended."); });
  }

  static async open(options: WorkerStoreProvisionerOptions): Promise<WorkerStoreProvisioner> {
    if (!options.installationId || options.installationId.length > 200 || !/^[A-Za-z0-9_-]{43,256}$/.test(options.credentialKey)) throw new Error("Invalid worker provisioning identity/key.");
    const url = new URL(options.connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password || !url.pathname.slice(1)) throw new Error("Explicit worker database credentials and database are required.");
    if ([...url.searchParams.keys()].some(key => !["sslmode", "sslrootcert", "uselibpqcompat"].includes(key))) throw new Error("Unsupported worker database URL parameters; credentials must be in URL authority only.");
    const client = new Client({ ...(options.ca === undefined ? { connectionString: options.connectionString } : verifiedPostgresConfig(options.connectionString, options.ca)), connectionTimeoutMillis: 60_000, application_name: "dispatch-worker-provisioner" });
    const provisioner = new WorkerStoreProvisioner(client, options);
    try {
      await client.connect();
      await provisioner.requirePrivatePasswordDdl();
      const { rows: [role] } = await client.query(`SELECT r.rolsuper, r.rolcreaterole, r.rolbypassrls, d.datname, pg_get_userbyid(d.datdba) = current_user AS owner
        FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname = current_user AND d.datname = current_database()`);
      if (!role?.owner || !role.rolcreaterole || role.rolsuper || role.rolbypassrls) throw new Error("Provisioner must own its dedicated database with CREATEROLE, without superuser/RLS bypass.");
      const { rows: [lock] } = await client.query("SELECT pg_try_advisory_lock(1684632432, 2) AS acquired");
      if (!lock.acquired) throw new Error("Worker database already has a provisioner.");
      const keyHash = createHmac("sha256", options.credentialKey).update("dispatch-worker-database-key-v1").digest("hex");
      await client.query("BEGIN");
      const { rows: [existing] } = await client.query("SELECT to_regnamespace('dispatch_worker') AS workers, to_regnamespace('dispatch_pi') AS pi");
      if (!existing.workers) {
        if (existing.pi) throw new Error("Refusing to convert an existing native Pi database into worker storage.");
        await migrateWithinTransaction(client);
        await client.query(`CREATE SCHEMA dispatch_worker;
          CREATE TABLE dispatch_worker.identity (singleton integer PRIMARY KEY CHECK(singleton=1), installation text NOT NULL, key_hash text NOT NULL);
          CREATE TABLE dispatch_worker.roles (role_name name PRIMARY KEY, store_id text UNIQUE NOT NULL);
          REVOKE ALL ON SCHEMA dispatch_worker, dispatch_pi FROM PUBLIC;
          REVOKE ALL ON ALL TABLES IN SCHEMA dispatch_worker, dispatch_pi FROM PUBLIC;
          REVOKE CREATE ON SCHEMA public FROM PUBLIC;
          CREATE FUNCTION dispatch_worker.bound_store() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
            AS 'SELECT store_id FROM dispatch_worker.roles WHERE role_name = SESSION_USER';
          REVOKE ALL ON FUNCTION dispatch_worker.bound_store() FROM PUBLIC`);
        await client.query(`REVOKE ALL ON DATABASE ${escapeIdentifier(role.datname)} FROM PUBLIC`);
        await client.query("INSERT INTO dispatch_worker.identity VALUES (1, $1, $2)", [options.installationId, keyHash]);
        for (const table of tables) {
          await client.query(`ALTER TABLE dispatch_pi.${table} ENABLE ROW LEVEL SECURITY;
            CREATE POLICY dispatch_worker_store ON dispatch_pi.${table} USING (store_id = (SELECT dispatch_worker.bound_store())) WITH CHECK (store_id = (SELECT dispatch_worker.bound_store()))`);
        }
      }
      const { rows: [identity] } = await client.query("SELECT installation, key_hash FROM dispatch_worker.identity WHERE singleton=1");
      if (identity?.installation !== options.installationId || identity.key_hash !== keyHash) throw new Error("Worker database installation/key mismatch.");
      const { rows } = await client.query(`SELECT c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) = current_user AS owned,
        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dispatch_pi' AND c.relname = ANY($1::text[])`, [tables]);
      if (rows.length !== tables.length || rows.some(row => !row.owned || !row.relrowsecurity || row.policies !== 1)) throw new Error("Worker database row-security policy is inconsistent.");
      // Additive backend-owned protocol state; the Pi storage schema stays compatible
      // with already-running legacy workers during an explicit rollout.
      const { rows: [remote] } = await client.query("SELECT to_regclass('dispatch_worker.storage_sessions') AS present");
      if (!remote.present) await client.query(`CREATE TABLE dispatch_worker.storage_sessions (
        store_id text COLLATE "C" PRIMARY KEY REFERENCES dispatch_pi.durable_metadata(store_id),
        attempt_id text NOT NULL, session_id text NOT NULL, closed boolean NOT NULL DEFAULT false,
        sequence bigint NOT NULL DEFAULT 0, request_hash text, result text);
        ALTER TABLE dispatch_worker.storage_sessions ENABLE ROW LEVEL SECURITY;
        CREATE POLICY dispatch_worker_store ON dispatch_worker.storage_sessions
          USING (store_id = (SELECT dispatch_worker.bound_store())) WITH CHECK (store_id = (SELECT dispatch_worker.bound_store()));
        REVOKE ALL ON dispatch_worker.storage_sessions FROM PUBLIC`);
      const { rows: [remotePolicy] } = await client.query(`SELECT c.relrowsecurity, pg_get_userbyid(c.relowner) = current_user AS owned,
        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c WHERE c.oid = 'dispatch_worker.storage_sessions'::regclass`);
      if (!remotePolicy?.owned || !remotePolicy.relrowsecurity || remotePolicy.policies !== 1)
        throw new Error("Remote storage row-security policy is inconsistent.");
      await client.query("COMMIT");
      provisioner.assertHealthy();
      return provisioner;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Connection may already be lost. */ }
      await client.end().catch(() => {});
      // Never attach raw SQL/connection errors: role creation statements contain credentials.
      if (error instanceof Error && !('code' in error)) throw error;
      throw new Error("Worker database provisioning initialization failed.");
    }
  }

  ensure(storeId: string): Promise<WorkerStoreConfig> {
    if (!storePattern.test(storeId)) return Promise.reject(new Error("Invalid worker store ID."));
    if (this.closing) return Promise.reject(new Error("Worker provisioning is closing."));
    const work = this.tail.then(async (): Promise<WorkerStoreConfig> => {
      this.assertHealthy();
      const identity = JSON.stringify(["dispatch-worker-role-v1", this.options.installationId, storeId]);
      const role = `dw_${createHash("sha256").update(identity).digest("hex").slice(0, 48)}`;
      const password = createHmac("sha256", this.options.credentialKey).update(identity).digest("base64url");
      const quoted = escapeIdentifier(role);
      try {
        await this.requirePrivatePasswordDdl();
        await this.client.query("BEGIN");
        const { rows: [mapping] } = await this.client.query("SELECT store_id FROM dispatch_worker.roles WHERE role_name=$1", [role]);
        const { rows: [existing] } = await this.client.query("SELECT oid, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=$1", [role]);
        if (mapping && mapping.store_id !== storeId) throw new Error("Worker role identity conflict.");
        if (existing && !mapping) throw new Error("Worker role exists outside the provisioning journal.");
        if (mapping && !existing) throw new Error("Worker role missing; restore cluster roles before reopening.");
        if (existing && (existing.rolsuper || existing.rolcreaterole || existing.rolcreatedb || existing.rolreplication || existing.rolbypassrls)) throw new Error("Worker role has elevated privileges.");
        if (!existing) {
          await this.client.query(`CREATE ROLE ${quoted} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
          await this.client.query("INSERT INTO dispatch_worker.roles VALUES ($1,$2)", [role, storeId]);
        }
        const { rows: memberships } = await this.client.query("SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)", [role]);
        if (memberships.length) throw new Error("Worker role must not belong to another role.");
        // Reconcile a restored role's password against the retained installation key.
        await this.client.query(`ALTER ROLE ${quoted} PASSWORD ${escapeLiteral(password)}`);
        const { rows: [db] } = await this.client.query("SELECT current_database() AS name");
        await this.client.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(db.name)} TO ${quoted};
          GRANT USAGE ON SCHEMA dispatch_pi, dispatch_worker TO ${quoted};
          GRANT EXECUTE ON FUNCTION dispatch_worker.bound_store() TO ${quoted};
          GRANT SELECT ON dispatch_pi.schema_version TO ${quoted};
          GRANT SELECT, INSERT, UPDATE ON dispatch_worker.storage_sessions TO ${quoted}`);
        for (const table of tables) await this.client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON dispatch_pi.${table} TO ${quoted}`);
        await this.client.query("COMMIT");
        this.assertHealthy();
        const url = new URL(this.options.connectionString);
        url.username = role; url.password = password;
        return { kind: "postgres", storeId, connectionString: url.toString(), access: "worker", ...(this.options.ca === undefined ? {} : { ca: this.options.ca }) };
      } catch {
        try { await this.client.query("ROLLBACK"); } catch { /* Do not reuse uncertain state. */ }
        this.failure ??= new Error("Worker store provisioning failed; reopen to reconcile the same store.");
        throw this.failure;
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }

  private async requirePrivatePasswordDdl(): Promise<void> {
    // Password DDL contains SQL literals: parameter redaction alone is insufficient.
    // Verify inherited settings without granting this application privileged SET authority.
    for (const [setting, expected] of [
      ["log_statement", "none"], ["log_min_duration_statement", "-1"],
      ["log_min_duration_sample", "-1"], ["log_min_error_statement", "panic"],
      ["log_error_verbosity", "terse"], ["log_parameter_max_length", "0"],
      ["log_parameter_max_length_on_error", "0"], ["password_encryption", "scram-sha-256"],
      ["pgaudit.log", "none"], ["pg_stat_statements.track_utility", "off"],
    ] as const) {
      const { rows: [current] } = await this.client.query("SELECT current_setting($1, true) AS value", [setting]);
      const optional = setting === "pgaudit.log" || setting === "pg_stat_statements.track_utility";
      if (current.value !== expected && !(optional && current.value === null)) {
        throw new Error(`Unsafe worker provisioning session setting: ${setting}.`);
      }
    }
  }

  get healthy(): boolean { return !this.failure && !this.closing; }

  close(): Promise<void> { return this.closing ??= this.tail.then(() => this.client.end()); }
  private assertHealthy() { if (this.failure) throw this.failure; }
}
