import type { Client } from "pg";
import { STORE_TABLES } from "./migrations.js";

/** Fail closed before opening a worker Session. Policy identity comes from the authenticated
 * session user, not store IDs in SQL predicates, application settings or a SET-able variable.
 */
export async function verifyWorkerAccess(client: Client, storeId: string): Promise<void> {
  const { rows: [role] } = await client.query(`SELECT current_user = session_user AS direct,
    r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
    dispatch_worker.bound_store() AS store_id,
    has_database_privilege(current_database(), 'CREATE,TEMP') AS database_ddl,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships
    FROM pg_roles r WHERE r.rolname=session_user`);
  if (!role?.direct || role.store_id !== storeId || role.rolsuper || role.rolcreaterole || role.rolcreatedb
    || role.rolreplication || role.rolbypassrls || role.database_ddl || role.memberships)
    throw new Error("Worker PostgreSQL credentials are not restricted to the bound store.");
  const { rows } = await client.query(`SELECT c.relname, row_security_active(c.oid) AS protected,
    has_table_privilege(c.oid, 'TRUNCATE,TRIGGER,REFERENCES') AS elevated
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='dispatch_pi' AND c.relname=ANY($1::text[])`, [STORE_TABLES]);
  if (rows.length !== STORE_TABLES.length || rows.some(row => !row.protected || row.elevated)) throw new Error("Worker table permissions or row security are inconsistent.");
  const { rows: [schemas] } = await client.query(`SELECT has_schema_privilege('dispatch_pi','CREATE') OR has_schema_privilege('dispatch_worker','CREATE')
    OR has_schema_privilege('public','CREATE') AS mutable`);
  if (schemas.mutable) throw new Error("Worker credentials allow schema mutation.");
  const { rows: [schema] } = await client.query("SELECT version FROM dispatch_pi.schema_version WHERE singleton=1");
  if (schema?.version !== 1) throw new Error("Worker PostgreSQL schema is not provisioned.");
}
