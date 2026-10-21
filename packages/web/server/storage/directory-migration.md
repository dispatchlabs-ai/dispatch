# Backend directory PostgreSQL configuration and migration

Status: loader implemented; entrypoint integration belongs to Developer. The migration procedure below is a **proposed, unexecuted operator procedure**, not migration tooling or permission to cut over existing installations. Native SQLite and existing PostgreSQL trials remain unchanged. See [worker ownership and backup contracts](../../docs/conversation-workers.md).

## Loader contract

`await readDirectoryStoreConfig(filename)` reads strict JSON:

```json
{
  "storeId": "existing-directory-store-id",
  "databaseUrlFile": "/run/secrets/directory-database.url",
  "databaseCaFile": "/run/config/postgres-ca.crt"
}
```

The store ID must be the existing directory store ID when retaining data, not a new installation label. The URL names the dedicated directory database and its ordinary owner (for example, `dispatch_directory_owner` / `dispatch_directory`), never the bootstrap superuser or worker-role provisioner. The loader validates URL/CA through `verifiedPostgresConfig`; actual server identity and database permissions are checked when the caller opens storage. It does not prove database ownership, installation identity or restored data correctness.

Configuration and CA must be non-group/world-writable regular files owned by root or the effective UID. URL files must be mode 0600 and owned by the effective UID. The shared reader rejects final-component symlinks and files over 1 MiB; parent directories must also be operator-controlled. Paths inside JSON are absolute. Errors omit raw credentials and parser details. Temporary URL buffers are cleared, but the returned JavaScript connection string necessarily remains in memory; never log it.

The result is `{kind:"postgres",storeId,connectionString,ca}` with no worker-access flag. The loader opens no database, runs no migrations and modifies no marker. The caller must reject conflicting legacy storage environment settings and fail startup on configured loader failure, never fall back to SQLite/plaintext. It passes the result into the existing directory runtime path; `openPiStorage` retains its endpoint/store marker enforcement and normal schema-version checks. No encryption key is required by this loader.

## Stopped-writer PostgreSQL-to-PostgreSQL migration

This procedure covers an existing **directory-only PostgreSQL database** moving to a dedicated ordinary-owner database. It does not convert SQLite, split mixed directory/conversation stores, import auth/MCP/provider state, or transfer worker-role mappings. If the source is shared with those stores, stop and design a separately reviewed extraction; do not dump an entire shared database into the directory target.

1. Inventory the exact source endpoint, logical store ID, schema version, directory runtime path and marker, application revision, ownership/ACLs and dependent routing/auth/credential/artifact state. Prove the selected source is directory-only. Pin source and target versions and record a rollback plan before changes.
2. Obtain the installation's maintenance authorization. Persist public admission closure, settle admitted writes, drain workers while their callbacks remain available, and obtain fresh zero-worker/no-unresolved-attempt evidence. Quiesce remaining support writers. Stop backend, launcher and operator CLI writers and independently confirm termination; advisory locks or expired connections do not prove retirement. Keep restart automation disabled throughout.
3. Capture a complete paired encrypted backup of directory and worker databases, cluster roles, local state, retained keys/secrets, routing/launcher state and artifact bytes according to the installation runbook. Verify archive integrity and independently recoverable password escrow. A directory dump alone is not a rollback backup. Do not proceed while escrow or paired capture is unresolved.
4. Provision a distinct, empty target database and dedicated ordinary owner through the reviewed opt-in provisioner. Preserve source data and credentials. Revoke PUBLIC CONNECT and unintended grants; verify intended-owner access and cross-controller denials. Do not restore cluster-wide roles or source superuser ownership into this target.
5. With all writers still stopped, capture a consistent custom-format PostgreSQL dump of the reviewed directory-only source. Review its object inventory before restore. Restore into the empty target with stop-on-error, no source ownership and no source ACL restoration, under the target owner (or a controlled restore session explicitly assuming that owner). Select compatible `pg_dump`/`pg_restore` versions. Never use destructive clean/overwrite against the source. Restore failure blocks activation; do not continue from a partially restored target without a reviewed reset.
6. Compare every directory table's logical-store inventory, row counts and canonical content digests, metadata counters, commit sequences, tasks/checkpoints and schema version. Check object ownership and grants explicitly. Counts alone do not establish equivalence. Confirm no worker mapping schema, foreign credentials or unexpected stores were copied. Preserve the exact store ID; do not renumber native IDs or rewrite documents. Verify application-readable directory/routing references against the paired state in an isolated rehearsal.
7. Prepare a separate copy of the stopped backend local state for the target, preserving all non-directory state. The old `postgres-store.json` intentionally refuses the changed endpoint. Retain its original bytes with the source backup. Only after verified restore and explicit cutover approval may the operator write a target marker in the separate copy with the **same store ID** and the target endpoint in the exact format used by `openPiStorage` (`hostname:effective-port/database`, default port 5432). Do not delete the original marker, remove `pi.sqlite`, or bypass mismatch checks in application code. An existing SQLite file requires a different migration design, not removal.
8. Configure the new URL/CA file references and retain persisted drain. Start only the target backend/controller with old executors independently confirmed absent. Verify authenticated history, directory and artifact references, explicit owner recovery where applicable, TLS identity and negative cases, persisted drain across restart, and backup/restore in isolation before undrain. Never run original and restored executors concurrently. Opening the target can perform schema initialization; compare state before first open and qualify that exact candidate.
9. Record exact revisions, backup identities, target binding, verification results and explicit undrain approval. Once new writes are admitted, the old source is stale: reverting the URL is not rollback. Roll back only with every target writer stopped and a reviewed consistent whole-state restore or forward recovery; retain both sides for reconciliation rather than merge silently.

## Outstanding acceptance

No migration, marker rewrite, database dump/restore or deployment was performed by this loader work. Entrypoint conflict rejection, Linux permissions/mounts, dedicated-owner runtime behavior, data-equivalence tooling, isolated whole-application restore, resumed model/tool execution and rollback rehearsal remain unverified. Do not activate from this document alone. Source review and type/build checks are not evidence that a live migration succeeded.
