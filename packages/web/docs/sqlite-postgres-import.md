# Offline SQLite to PostgreSQL import

Use this operator command to move an **idle native single-runtime** Pi store to
a new, dedicated PostgreSQL database. It does not split conversations into
workers, merge installations, change authentication storage, relocate paths,
start a service, or provide automatic failover.

1. Stop the source backend and all other writers. Verify process termination and
   settle tasks/submissions before taking a complete private backup of application
   state, keys, credentials, attachments and workspaces. Preserve that backup.
   A live SQLite-only snapshot is not a whole-installation recovery point.
2. Provision a distinct empty PostgreSQL database and ordinary owner. Keep it
   private; use the deployment's trusted local connection. Do not reuse a trial
   database or point an application at this target yet.
3. From the source checkout's Nix development shell, inject the target URL through
   a private environment and run:

   ```sh
   npx tsx scripts/import-sqlite.ts /private/snapshot/runtime/pi.sqlite new-store-id
   ```

   `DISPATCH_POSTGRES_URL` is required. The command accepts schema versions 1 and 2,
   the exact known table/column layout, terminal tasks, and settled submissions.
   It reads SQLite in one read-only transaction, holds the target store ownership
   lock, refuses any existing target store, and copies all eight Pi tables in one
   PostgreSQL transaction. Native IDs, counters, JSON text, indexed values and
   document revisions are retained without rewriting. Every copied table is
   read back in primary-key order and checked by count and SHA-256 over canonical
   row arrays before commit. The success receipt includes counters and per-table
   digests, without record contents or credentials.
4. Preserve the receipt. On failure, keep the source and target for investigation.
   Ordinary failures roll back, but a lost COMMIT acknowledgement is uncertain;
   do not blindly retry or activate. A rerun refuses a populated target.
5. Prepare a **new** local-state directory from the complete backup, omitting only
   `runtime/pi.sqlite` and its sidecars and the ephemeral runtime-owner lock.
   Preserve the original SQLite backup unchanged. Configure the exact target URL,
   store ID and new data directory. Normal startup creates its PostgreSQL binding
   marker; do not edit markers or weaken the ordinary backend-selection guards.
6. Reconcile machine-specific working directories and external credentials. Keep
   every old executor stopped before admitting work at the destination. Verify
   password/TOTP sign-in (passkeys are origin-bound), saved history, current
   documents, real model/tool use, attachments and restart persistence. Back up
   PostgreSQL together with the full local state. Once the target accepts new
   writes, the source snapshot is stale; reverting a URL is not rollback.

The importer is direct-storage administration, requiring filesystem and database
authority. It is not an authenticated end-user API. It preserves Pi state only;
authentication, provider and managed-connection SQLite databases and encryption
keys must travel with the complete local-state copy. Do not log raw database
errors: PostgreSQL constraint diagnostics may contain private document contents.
