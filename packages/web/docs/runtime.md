# Durable chat runtime

The application service owns `DispatchRuntime` in `server/runtime.ts`. It uses the unmodified `@earendil-works/pi-durable` 1.0.1 public API. The server supplies authenticated `{ companyId, userId }` scope to every operation and a server-side Pi `Models` implementation; credentials never enter conversation snapshots.

## Storage and lifetime

Each state directory contains Pi's `pi.sqlite` and a small `runtime-owner.sqlite` ownership lock. A SQLite exclusive transaction is held on the latter for the service lifetime. A competing runtime fails before opening Pi storage, and the operating system releases the lock after a crash. The lock does not limit conversations or model calls. State directories are private (mode `0700`); the databases are mode `0600`.

Pi owns native transcripts, submission admission, generations, queued inputs, cancellation, and recovery. Dispatch stores only application metadata and agent definitions in a Pi session document. It does not maintain another transcript or durable run-state database.

`DispatchRuntime.open()` installs the registry, opens storage, initializes the metadata document if absent, and calls `Harness.resume()`. `close()` stops the runtime without turning interrupted work into an explicit user cancellation. Frontend hot reload and browser connection lifetime must not close the service runtime.

## Commands and observations

- `createChat(scope, { requestId, agentDefinitionId?, title? })` admits an independent native conversation. Reusing the same creation request ID for the same user/company returns that conversation.
- `submit(scope, id, { requestId, text })` uses Pi's per-conversation request deduplication. Inputs received during a response become native follow-ups. An accepted request retry returns its native submission even if provider credentials later become unavailable.
- `stop(scope, id)` invokes native foreground cancellation, including queued follow-ups. It preserves committed partial output and returns the current snapshot.
- `getChat()` and `watchChat()` return the full native `ConversationView` and native submission records. The summary's status is derived from those records, including cancellation or failure before a first output token. It is not separately persisted.
- `watchChat()` supplies an initial `value`, then `start(async snapshot => ...)`, `stop()`, and `closed`. Emit the initial value before starting the listener. Each delivered value replaces the browser's previous snapshot. The wrapper takes a coherent current view and submission read on Pi's commit line; notifications can coalesce and no replay cursor is promised.

Closing a watcher stops observation only. Work continues while the browser is absent. The service transport must independently enforce session expiry/revocation for live subscriptions.

On recovery, Pi can retain an interrupted partial as an aborted assistant entry and retry the pending generation. This does not promise token-exact continuation or exactly-once provider billing. The first agent has no tools; external-effect replay policies belong to later, specified tool integrations.

## Agent definitions

The default agent uses the supplied provider/model/thinking configuration with an ordinary native instruction string and no tools or extensions. Named agents are company-shared. Each save appends an immutable revision, using `expectedRevision` to reject stale edits. Archiving appends an archived revision; creating a new chat from it is denied. Existing chats retain the native agent configuration copied at creation and remain usable.

Conversation reads, subscriptions, submission, and cancellation require both the creator's user ID and company ID. Named-definition access requires the company ID. HTTP authentication, account membership, and model credential resolution remain service responsibilities.

## Verification

From the repository root inside `nix develop`:

```sh
node --import tsx --test packages/web/test/runtime/runtime.test.ts
```

The controlled-provider tests cover independent concurrent chats; admission deduplication; user/company isolation; native transcript preservation; current snapshots after disconnection; partial and pre-token Stop; native provider failure; missing credentials; immutable agent revisions and archive behavior; and true process death during streamed output. The crash test uses `SIGKILL`, confirms exclusion of a competing owner, reopens the same storage, and verifies that Pi completes the original submission without duplicating its user entry.

These are deterministic integration tests against stock Pi. A separate real-provider smoke test is required when qualifying the complete service and its credential configuration.
