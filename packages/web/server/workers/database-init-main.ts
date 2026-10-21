import { parseArgs } from "node:util";
import { Client, escapeIdentifier as ident, escapeLiteral as literal } from "pg";
import { z } from "zod";
import { readRestrictedConfigurationFile as readRestricted } from "../storage/restricted-config-file.js";
import { verifiedPostgresConfig } from "../storage/postgres/tls.js";

const names = ["auth", "provider", "catalog", "directory", "routing", "launcher", "workers"] as const;
const path = z.string().startsWith("/");
const commonConfig = z.object({
  installationId: z.string().min(1).max(200), caFile: path,
  stores: z.record(z.enum(names), path),
});
const configSchema = z.union([
  commonConfig.extend({ adminUrlFile: path }).strict(),
  commonConfig.extend({ adminSecretFile: path, host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
    port: z.number().int().min(1).max(65535).default(5432) }).strict(),
]);
type Store = { name: typeof names[number]; url: URL; role: string; database: string; password: string; marker: string };
let stage = "input validation";

async function text(filename: string, secret = true): Promise<string> {
  const bytes = await readRestricted(filename, secret);
  try { return bytes.toString("utf8"); } finally { bytes.fill(0); }
}
function client(url: URL, ca: string): Client {
  const result = new Client({ ...verifiedPostgresConfig(url.toString(), ca), connectionTimeoutMillis: 60_000,
    statement_timeout: 30_000, query_timeout: 35_000, application_name: "dispatch-database-init" });
  // Never allow pg's asynchronous error event to dump connection or statement details.
  result.on("error", () => { process.exitCode = 1; });
  return result;
}
async function transaction(db: Client, action: () => Promise<void>): Promise<void> {
  await db.query("BEGIN");
  try { await action(); await db.query("COMMIT"); }
  catch { await db.query("ROLLBACK").catch(() => {}); throw new Error("Initialization transaction failed."); }
}

async function requireSessionSetting(db: Client, name: string, value: string): Promise<void> {
  const read = async () => (await db.query("SELECT current_setting($1) AS value", [name])).rows[0].value;
  // RDS can enforce a safe parameter-group value while denying the operator SET permission.
  if (await read() === value) return;
  await db.query("SELECT set_config($1, $2, false)", [name, value]);
  if (await read() !== value) throw new Error("Required provisioning session setting is not effective.");
}

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: "string" }, create: { type: "boolean" }, verify: { type: "boolean" },
    "confirm-services-stopped": { type: "boolean" }, help: { type: "boolean" },
  }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log("dispatch-database-init --config /private/config.json (--verify | --create --confirm-services-stopped)");
    return;
  }
  if (!values.config || Boolean(values.create) === Boolean(values.verify)
    || (values.create && !values["confirm-services-stopped"])) throw new Error("Explicit operation required.");
  const config = configSchema.parse(JSON.parse(await text(values.config)));
  const ca = await text(config.caFile, false);
  let adminUrl: URL;
  if ("adminUrlFile" in config) adminUrl = new URL((await text(config.adminUrlFile)).trim());
  else {
    const secret = z.object({ username: z.string().min(1), password: z.string().min(1) })
      .parse(JSON.parse(await text(config.adminSecretFile)));
    adminUrl = new URL(`postgresql://${config.host}:${config.port}/postgres`);
    adminUrl.username = secret.username;
    adminUrl.password = secret.password;
  }
  verifiedPostgresConfig(adminUrl.toString(), ca);
  if (!adminUrl.password) throw new Error("Explicit operator credentials required.");
  const adminRole = decodeURIComponent(adminUrl.username);
  const stores: Store[] = [];
  for (const name of names) {
    const url = new URL((await text(config.stores[name])).trim());
    verifiedPostgresConfig(url.toString(), ca);
    const role = decodeURIComponent(url.username), database = decodeURIComponent(url.pathname.slice(1));
    const password = decodeURIComponent(url.password);
    if (url.hostname !== adminUrl.hostname || (url.port || "5432") !== (adminUrl.port || "5432")
      || !/^[a-z][a-z0-9_]{2,62}$/.test(role) || !/^[a-z][a-z0-9_]{2,62}$/.test(database)
      || role.startsWith("pg_") || database.startsWith("pg_") || role === adminRole
      || database === decodeURIComponent(adminUrl.pathname.slice(1))
      || !/^[A-Za-z0-9_-]{43,256}$/.test(password) || password === decodeURIComponent(adminUrl.password)
      || stores.some(store => store.role === role || store.database === database || store.password === password))
      throw new Error("Distinct installation-scoped database identities required.");
    stores.push({ name, url, role, database, password, marker: `dispatch-database-init-v1:${config.installationId}:${name}` });
  }
  const admin = client(adminUrl, ca);
  try {
    stage = "operator connection and preflight";
    await admin.connect();
    const { rows: [version] } = await admin.query("SELECT current_setting('server_version_num')::int / 10000 AS major");
    if (![17, 18].includes(version.major)) throw new Error("PostgreSQL 17 or 18 required.");
    const { rows: [lock] } = await admin.query("SELECT pg_try_advisory_lock(1684632432, 7) AS acquired");
    if (!lock.acquired) throw new Error("Another initializer is active.");
    if (values.create) {
      const { rows: existing } = await admin.query(`SELECT rolname AS name FROM pg_roles WHERE rolname=ANY($1::text[])
        UNION ALL SELECT datname FROM pg_database WHERE datname=ANY($2::text[])`,
      [stores.map(store => store.role), stores.map(store => store.database)]);
      if (existing.length) throw new Error("Creation refuses existing roles or databases, including partial initialization.");

      // Refuse to send password parameters until ordinary/error/audit query logging is disabled.
      // Keep passwords out of SQL text too: use a temporary SECURITY INVOKER function with bind parameters.
      stage = "private provisioning session";
      for (const [setting, value] of [
        ["log_statement", "none"], ["log_min_duration_statement", "-1"],
        ["log_min_duration_sample", "-1"], ["log_min_error_statement", "panic"], ["log_error_verbosity", "terse"],
        ["log_parameter_max_length", "0"], ["log_parameter_max_length_on_error", "0"],
        ["password_encryption", "scram-sha-256"],
      ] as const) await requireSessionSetting(admin, setting, value);
      for (const setting of ["pgaudit.log", "pg_stat_statements.track_utility"]) {
        const { rows: [current] } = await admin.query("SELECT current_setting($1, true) AS value", [setting]);
        if (current.value !== null) await requireSessionSetting(admin, setting, setting === "pgaudit.log" ? "none" : "off");
      }
      await admin.query(`CREATE FUNCTION pg_temp.dispatch_set_password(role_name text, secret text) RETURNS void
        LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN
          EXECUTE format('ALTER ROLE %I PASSWORD %L', role_name, secret);
        EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Credential provisioning failed';
        END $$;
        REVOKE ALL ON FUNCTION pg_temp.dispatch_set_password(text,text) FROM PUBLIC`);
      stage = "fresh role creation";
      await transaction(admin, async () => {
        for (const store of stores) {
          await admin.query(`CREATE ROLE ${ident(store.role)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
          await admin.query(`COMMENT ON ROLE ${ident(store.role)} IS ${literal(store.marker)}`);
          // PostgreSQL requires SET permission to create a database owned by another role.
          // Membership is operator -> application, never application -> operator or another store.
          await admin.query(`GRANT ${ident(store.role)} TO ${ident(adminRole)} WITH INHERIT FALSE, SET TRUE`);
        }
      });
      stage = "fresh database creation";
      for (const store of stores) {
        // CREATE DATABASE cannot join the role transaction. Until the ACL commits it accepts no connections.
        await admin.query(`CREATE DATABASE ${ident(store.database)} OWNER ${ident(store.role)} TEMPLATE template0 ALLOW_CONNECTIONS false`);
        await transaction(admin, async () => {
          await admin.query(`SET LOCAL ROLE ${ident(store.role)}`);
          await admin.query(`REVOKE ALL ON DATABASE ${ident(store.database)} FROM PUBLIC`);
          await admin.query(`COMMENT ON DATABASE ${ident(store.database)} IS ${literal(store.marker)}`);
          await admin.query(`ALTER DATABASE ${ident(store.database)} ALLOW_CONNECTIONS true`);
        });
      }
      stage = "credential activation";
      await transaction(admin, async () => {
        for (const store of stores) {
          await admin.query("SELECT pg_temp.dispatch_set_password($1, $2)", [store.role, store.password]);
          await admin.query(`ALTER ROLE ${ident(store.role)} LOGIN ${store.name === "workers" ? "CREATEROLE" : "NOCREATEROLE"}`);
        }
      });
    }

    stage = "database identity and isolation verification";
    for (const store of stores) {
      const owner = client(store.url, ca);
      try {
        await owner.connect();
        if (values.create) await owner.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
        const { rows: [identity] } = await owner.query(`SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
          r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolinherit,
          shobj_description(r.oid, 'pg_authid') AS role_marker,
          d.datname, d.datdba=r.oid AS owns_database, shobj_description(d.oid, 'pg_database') AS db_marker,
          EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS member_of_other_role,
          EXISTS(SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d',d.datdba))) WHERE grantee=0) AS public_database_grant,
          EXISTS(SELECT 1 FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
            WHERE n.nspname='public' AND a.grantee=0) AS public_schema_grant
          FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname=current_user AND d.datname=current_database()`);
        if (identity.rolname !== store.role || identity.datname !== store.database || !identity.owns_database || !identity.rolcanlogin
          || identity.rolsuper || identity.rolbypassrls || identity.rolcreatedb || identity.rolreplication || identity.rolinherit
          || identity.rolcreaterole !== (store.name === "workers") || identity.member_of_other_role
          || identity.public_database_grant || identity.public_schema_grant
          || identity.role_marker !== store.marker || identity.db_marker !== store.marker)
          throw new Error("Database identity or privileges do not match.");
        for (const other of stores.filter(other => other !== store)) {
          const { rows: [access] } = await owner.query("SELECT has_database_privilege(current_user, $1, 'CONNECT') AS allowed", [other.database]);
          if (access.allowed) throw new Error("Cross-store connection grant found.");
        }
      } finally { await owner.end().catch(() => {}); }
    }
    console.log(JSON.stringify({ operation: values.create ? "created" : "verified", stores: names, verifiedTls: true,
      separateDatabaseOwners: true, workerProvisionerOnlyCreateRole: true }));
  } finally { await admin.end().catch(() => {}); }
}

main().catch(() => {
  console.error(`Database initialization failed during ${stage}. Preserve inputs and partial state; inspect privately. No automatic reset or retry.`);
  process.exitCode = 1;
});
