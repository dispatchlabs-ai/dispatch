# Routing and admission persistence

`WorkerRoutes` is backend-owned control state, not Pi task storage or an executor lease. Native Pi 1.0.4 still owns conversation execution/recovery. One active backend is supported; replicas and automatic takeover are not.

## API and integration

- Native SQLite: `await WorkerRoutes.open(directory, installationId)` preserves `routes.sqlite`, its local owner lock, route encoding and existing admission state.
- PostgreSQL: `await WorkerRoutes.openPostgres({database, installationId, recoverOwnerId?})`. `database` is a `pg.ClientConfig`; deployment callers use verified TLS through the loader below.
- `get`, `list`, `readSummary` and `admissionBlocked` are synchronous committed-cache reads. Returned route objects are decoded copies. Detected connection/transaction failure and close deny reads, including formerly cached routes.
- **Await** `ensure`, `ready`, `retiring`, `replaceRetired`, `updateSummary`, `setAdmissionBlocked` and `close`. SQLite callers must also await mutations. Commit intent before launcher effects; acknowledge a worker summary only after its write resolves.
- Mutation checks execute inside the serialized queue against the latest committed route. Old-attempt callbacks cannot overwrite a committed replacement. Caller input rejection does not poison the journal; database/uncertain-commit failure does.
- Fresh journals start with admission blocked. Reopen preserves persisted admission state, not proof that workers are absent. The caller must apply it before model refresh or public admission and perform independent reconciliation. The journal itself does not quiesce workers or issue network effects.
- Summary freshness is process-local monotonic observation time. Identical accepted summaries refresh it; stale/conflicting/failed writes do not. Reopened observations and observations from earlier attempts remain stale.

The backend must serialize lifecycle transitions. Keep journal-dependent drain separate from final teardown, and await `close()` even if another resource fails. Closing seals new operations, joins admitted mutations and releases ownership. No full application lifecycle qualification is implied by this component.

## Configuration and privileges

`workers/routing-config.ts` exports `readRoutingStoreConfig(file)` and `openConfiguredWorkerRoutes(config, recoverOwnerId?)`. Strict JSON:

```json
{
  "installationId": "installation-identity",
  "databaseUrlFile": "/run/secrets/routing-database.url",
  "databaseCaFile": "/run/config/postgres-ca.crt"
}
```

The application integration must match this installation ID to its backend installation. Use dedicated `dispatch_routing_owner` → `dispatch_routing` with ordinary own-schema/table privileges; no superuser, role administration or worker-provisioner authority. The adapter uses schema `dispatch_routing` and revokes PUBLIC schema/table access. Deployment provisioning owns database CONNECT ACLs and password authentication. No routing encryption key is required; treat routing data and URL files as sensitive and include routing state in the encrypted data capture.

The shared restricted-file reader and PostgreSQL TLS helper enforce the existing file/CA/hostname contract. Config must not contain `recoverOwnerId`, extra fields or legacy URL overrides. The loader emits fixed errors without URLs or parser diagnostics. URL buffers are cleared; JavaScript strings and client configuration remain in memory. No SQLite-to-PostgreSQL fallback or import is implemented.

## Ownership and recovery

PostgreSQL uses a dedicated non-reconnecting connection, a database-scoped advisory lock and a durable owner UUID. Every mutation checks the exact installation/owner row under transaction lock. Cache publication occurs only after successful COMMIT. Transaction failure permanently disables the instance, including synchronous reads; close retains its recovery latch after failure.

Healthy close clears only its own latch after queued work settles. Crash or session loss requires a matching invocation-only `recoverOwnerId`, exposed as `routes.ownerId`, **and independently confirmed old-controller retirement**. An available advisory lock or knowledge of the UUID is not evidence of retirement. Incorrect recovery IDs, different installations and active duplicate owners are refused. Database administrators/credential holders can alter control state: this is not protection against arbitrary database writes or backup rollback.

A routing journal is not evidence that its named workers are dead. Replacement still requires fresh launcher stopped/absent proof; route ownership alone cannot fence remote tools. Backup/restore must pair routing/admission, launcher attempts/tombstones, directory and worker stores, auth/provider/MCP state, keys and artifacts. Do not restore only this database and infer whole-application recovery. No migration, provisioning, activation or existing-installation changes are included.

## Acceptance boundary

Focused disposable-data qualification and source/type/build evidence are reported separately with exact revisions. Integrated caller awaits, Linux/container startup ordering, worker retirement, lifecycle failure paths and encrypted whole-application restore remain integration gates until explicitly exercised.
