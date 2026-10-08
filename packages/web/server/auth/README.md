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

Focused auth TypeScript check and whitespace review passed on October 8. Source/deslop review covered transactional grouping, challenge and counter consumption, committed revocation notification, no-cache reads, strict-file reuse, numeric timestamp decoding and failure handling. Full service TypeScript currently requires the owner-assigned caller changes; this standalone base also lacks installed AWS SDK dependencies. No automated tests, disposable runtime qualification, deployment, browser sign-in, PostgreSQL concurrency/failure/restore checks, or final integrated Nix build were performed by this component owner. Those remain acceptance requirements; type checks do not establish authentication correctness.
