# Postgres

A service-only implementation of Pi Durable **1.5.0 public Storage**. Native
conversation/task/entry/document/submission records remain authoritative. No Web
company/project schema. [Runnable composition](../../examples/chat/README.md).

```ts
import { PostgresStorage } from "@dispatch/postgres";
// Consumer supplies a private connection string and verified CA outside source.
const storage = await PostgresStorage.open({connectionString, ca, storeId: "example:helper"});
// Transfer storage to Harness.open(); its native close owns storage.close().
```

A connection owns exactly one logical store under a PostgreSQL advisory lock,
never reconnects silently, and fails closed after uncertain COMMIT. Text JSON
preserves embedded NULs/surrogates. Grouped commit delivers ordered per-batch
sequence receipts after confirmed SQL commit; semantic refusal retains only the
accepted prefix, driver errors roll back the group. Safe-integer allocation and
read-only repeatable snapshots use the released public interface.
`readSnapshot(options, callback)` never claims writer ownership, initializes a
store or opens/resumes a Harness. Page until native cursors are exhausted.

`PostgresStorageService(options, authorizeStore)` accepts Remote StorageRequest
operations. A persistent executor session, monotonic mutation sequence and content
hash bind retries; mutation plus receipt share one SQL transaction. A clean close
allows a new session; disconnect/crash does not. Retired sessions never reopen.
`retireRemoteSession(exactSession)` is **offline administration only**, after an
operator proves the old executor stopped and reconciles external effects. An SQL
lock alone is not external-effect fencing. No elapsed-time replacement.

Only the central service holds SQL credentials. A trusted route must authorize the
exact run/agent store before calling the storage service. Never expose it as raw SQL
or let workers select arbitrary stores. Use verified TLS/CA for network PostgreSQL;
plain URLs without CA are for an isolated local database only.

Source/type/build and interactive synthetic central composition are distinct from
full storage conformance or production-recovery qualification. No automated tests
are added or run in Dispatch. [Upstream MIT notice](NOTICE).

## Package distribution

The reusable runtime closure is prepared for public npm publication; this source
change is not a registry release. For dependency-order builds, reviewed archives,
external consumers and separately authorized publishing, follow the
[package release path](https://github.com/dispatchlabs-ai/dispatch/blob/main/scripts/README.md).
