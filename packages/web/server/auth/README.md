# Authentication persistence integration

This component preserves SQLite and adds a dedicated PostgreSQL authentication database. It does not migrate existing state or activate a deployment.

## Interfaces

- SQLite: `await createAuth(config)` retains `databasePath` and `secretPath` and opens admitting.
- PostgreSQL: `await openConfiguredAuth(await readAuthStoreConfig(filename), { origin, rpId, companyId, companyName })` from `config.ts`. Opens **quiesced**. Call `await auth.resume()` only after persisted installation admission allows it.
- Direct PostgreSQL factory: `AuthService.openPostgres({ database, installationId, encryptionKey, origin, rpId, companyId, companyName })`. `database` is a pg ClientConfig; production callers use the verified-TLS loader, not arbitrary connection configuration.
- Await `authenticate`, `isSessionValid`, `listCompanyPeople`, `getCompanyPerson`, `revokeSession`, `issueInvitation`, `issueRecoveryInvitation`, `handle`, `quiesce`, `resume`, and `close`. `admitting` is a synchronous status getter.
- `onRevocation(() => void | Promise<void>)` registers synchronously. Committed revocations join all listener promises. Listeners must return their cleanup promises; a failure is reported even though database revocation already committed. Do not invoke service lifecycle changes from a listener: quiesce joins that revocation operation.

Caller changes belong in `app.ts` (including async SSE authorization and rejection handling), `index.ts`, `auth-cli.ts`, and `workers/backend-main.ts`. The people-directory adapters already return promises. Caller integration must serialize lifecycle transitions, drain requests before closing, and verify admission after resume. A standalone operator invocation must explicitly resume and await close. Cold backup must exclude operator invocations as well as backend writes.

## Configuration and authority

Strict JSON fields: `{installationId,databaseUrlFile,databaseCaFile,encryptionKeyFile}`. URL and key files must be regular non-symlink files, current-UID owned, mode 0600; public config/CA files must be current-UID/root owned and not group/other writable. Missing or malformed files fail; this loader never generates or repairs secrets. Encryption key is independent raw 32-byte random material. Verified PostgreSQL TLS uses the shared explicit-host verifier. Integration dependencies: TLS helper from `aa9448c` and restricted-file reader from `dafc927`.

Deployment names: `dispatch_auth_owner` owns `dispatch_auth`; adapter schema is `dispatch_auth`. Provision schema/table creation rights without superuser/CREATEROLE and explicitly restrict database CONNECT. Suggested paths are `/run/config/auth-store.json`, `/run/secrets/auth-database.url`, `/run/secrets/auth-credentials.key`, `/run/config/postgres-ca.crt`.

A singleton schema-version/installation/company/key-fingerprint record rejects mismatched reopen. Keep the database and external key together in coordinated backups. No automatic key rotation or schema downgrade exists.

## Transaction and failure boundaries

The per-connection queue and async transaction context prevent unrelated requests joining another request's transaction. PostgreSQL uses a database-scoped transaction advisory lock shared by backend and operator adapters, so multi-query authentication decisions and writes observe serialized committed state. This is not a conversation-worker fence. SQLite retains its existing schema and BEGIN IMMEDIATE transactions. Transactions never encompass password hashing or WebAuthn verification. Existing challenge consumption, TOTP counters, recovery codes, invitations and credential-version checks remain authoritative; security changes recheck session authority inside the final transaction.

There is no authorization cache. Separate operator changes are seen on subsequent database checks; cross-process subscription cleanup still relies on the caller's periodic checks, as before. Connection loss, failed rollback and uncertain COMMIT fail closed without reconnect/retry. A successful revocation cannot undo an external action already authorized. Quiesce rejects new operations and joins admitted operations, including local revocation listeners. PostgreSQL startup does not clean expired state before resume; bootstrap/schema identity checks still access the database.

## Acceptance evidence and limits

Source/type checks passed at `e6e0550`; later integrated caller/build evidence belongs to the backend owner. Focused disposable observations at this auth revision used macOS ARM64, Node 24.21.0 and PostgreSQL 17.11 over loopback without TLS:

- PostgreSQL starts quiesced. Separate-connection revocation is visible on the next session check and after reopen; wrong-key reopen is refused. The exercised superseded-resume ordering stays quiesced, not an exhaustive race proof.
- SQLite/PostgreSQL deliberate transaction errors roll back while an unrelated queued write survives. SQLite retains committed data after reopen. PostgreSQL connection termination rejects successive reads without reconnecting.
- Fixture overrides before COMMIT, after actual COMMIT and during rollback reject current, queued and subsequent operations without replay; close succeeds on both adapters. Independent PostgreSQL reads confirm only the committed case retains its mutation. These are method-injected failures, not wire-level uncertain-COMMIT evidence.
- A throwing revocation listener does not skip a delayed listener. Revocation, quiesce and close join delayed cleanup; admission rejects during drain. Deletion is committed before listeners and survives reopen.
- A cold auth-only logical dump restores under a new nonsuperuser owner, opens quiesced, retains a seeded valid session and denies a revoked session. Wrong key/company/installation are refused; the retired source role cannot log in after source sessions close.

Disposable schemas/databases/roles were removed and PostgreSQL stopped. Probe scripts and output remain in the ignored `.local/auth-qualification/` worktree directory. No existing installation changed. These observations do not establish fresh password/TOTP or passkey sign-in, auth TLS/browser behavior, wire-level uncertain COMMIT, exhaustive lifecycle interleavings, backend startup/drain integration, Linux execution or encrypted whole-application restore. Those remain acceptance gates; component checks do not establish package readiness.
