# Durable chat runtime

The application service owns `DispatchRuntime` in `server/runtime.ts`. It uses the unmodified `@earendil-works/pi-durable` 1.0.1 public API. The server supplies authenticated `{ companyId, userId }` scope to every operation and a server-side Pi `Models` implementation; credentials never enter conversation snapshots.

## Storage and lifetime

Each state directory contains Pi's `pi.sqlite` and a small `runtime-owner.sqlite` ownership lock. A SQLite exclusive transaction is held on the latter for the service lifetime. A competing runtime fails before opening Pi storage, and the operating system releases the lock after a crash. The lock does not limit conversations or model calls. State directories are private (mode `0700`); the databases are mode `0600`.

Pi owns native transcripts, submission admission, generations, queued inputs, cancellation, and recovery. Dispatch stores only application metadata and agent definitions in a Pi session document. It does not maintain another transcript or durable run-state database.

`DispatchRuntime.open()` installs the registry, opens storage, subscribes to native commit publications, and commits a fresh instance UUID in the metadata document before calling `Harness.resume()`. The startup metadata write seeds the observer with Pi's persisted commit sequence even when reopening existing storage; a read-only initialization would produce no publication. The marker contains no execution state, and snapshot ordering uses only the native commit sequence. `close()` stops the runtime without turning interrupted work into an explicit user cancellation. Frontend hot reload and browser connection lifetime must not close the service runtime.

## Commands and observations

- `createChat(scope, { requestId, agentDefinitionId?, title? })` admits an independent native conversation. Reusing the same creation request ID for the same user/company and payload returns that conversation; a different title or agent definition with that ID returns `409`.
- `submit(scope, id, { requestId, text })` uses Pi's per-conversation request deduplication. Inputs received during a response become native follow-ups. An accepted request retry with the same text returns its native submission even if provider credentials later become unavailable. Reusing an ID with changed text returns `409`, including after cancellation or restart.
- `stop(scope, id)` invokes native foreground cancellation, including queued follow-ups. It preserves committed partial output and returns the current snapshot.
- `getChat()` and `watchChat()` return the full native `ConversationView` and native submission records. The summary's status is derived from those records, including cancellation or failure before a first output token. It is not separately persisted. A failed generation remains visibly failed when Pi retains queued follow-ups; a subsequent input lets Pi continue the queue.
- Every chat summary carries `revision`, Pi's latest native commit sequence read on the same serialized boundary as the snapshot. The browser can reject an older REST/list/SSE response using this value, including across service restarts. Message timestamps remain for display and sorting, not snapshot ordering. Reads do not increment a separate revision counter or persist per-chat status.
- `watchChat()` supplies an initial `value`, then `start(async snapshot => ...)`, `stop()`, and `closed`. Emit the initial value before starting the listener. Each delivered value replaces the browser's previous snapshot. The wrapper takes a coherent current view and submission read on Pi's commit line; notifications can coalesce and no replay cursor is promised.

Closing a watcher stops observation only. Work continues while the browser is absent. The service transport must independently enforce session expiry/revocation for live subscriptions.

On recovery, Pi can retain an interrupted partial as an aborted assistant entry and retry the pending generation. This does not promise token-exact continuation or exactly-once provider billing. The first agent has no tools; external-effect replay policies belong to later, specified tool integrations.

## Agent definitions

The default agent uses the supplied provider/model/thinking configuration with an ordinary native instruction string and no tools or extensions. Named agents are company-shared. Each save appends an immutable revision, using `expectedRevision` to reject stale edits. Archiving appends an archived revision; creating a new chat from it or editing it is denied. There is no restore workflow in this slice; create a new definition to reuse its configuration. Existing chats retain the native agent configuration copied at creation and remain usable.

Conversation reads, subscriptions, submission, and cancellation require both the creator's user ID and company ID. Named-definition access requires the company ID. HTTP authentication, account membership, and model credential resolution remain service responsibilities.

## Request identity

Pi removes a cancelled queued input from its inbox, so its terminal submission record cannot always recover the original text. Dispatch keeps SHA-256 input fingerprints in a native conversation-scoped metadata document. The fingerprint is reserved on Pi's serialized commit line before calling its public submission API. It contains no pending/completed operation state and does not own execution. If the service stops between reservation and native admission, a same-payload retry proceeds to normal Pi submission.

The public submission API has no callback for atomically attaching application metadata to admission. This two-step reservation preserves request identity while leaving admission and deduplication to Pi. A pre-fingerprint development record cannot be verified and returns `409`, requiring a new request ID; there is no released-data migration contract.
