# Separately hosted workflow progress

`createWorkflowProgress` observes an existing run; its execution and authorization
remain host-owned. Register the returned `extension` before native recovery, then
call `watch(api, context, requestId, watch)` after an idempotent start or follow-up.
The watch carries the external run, display author, authenticated origin and
optional reply destination. Never derive origin authority from model text.

Provide `observe`, `authorize`, a `ReplySink` when delivering externally, and
positive `observeEveryMs` / `progressEveryMs` intervals. `observe` returns a stable
milestone `cursor`, factual `summary` and `settled`. It can also return `updates`
with a stable `source`, `id`, public `text` and optional epoch-millisecond `at`,
plus an `activity` description from current execution. Supply the latest update
from every participating worker, not just its coordinator. Use committed public
commentary, recorded progress and execution receipts, never private reasoning,
partial model text or raw tool output. `settled` means the assignment returned;
it does not assert successful acceptance.

Native tasks publish new narrative evidence at the progress interval and final
results. Changing a tool or active-role list does not republish the last prose.
Use `narration: "status"` with `statusSink` to keep routine updates in one
editable message per external run, including across follow-ups. An `onSettled`
callback receives the returned `result` and commits a host-owned continuation
atomically instead of publishing a second final reply. The supervisor decides
whether the user's requested outcome is complete. Persist its request identity
and revalidate it when admitting any delayed continuation.
Unchanged IDs or identical text from a source are suppressed. Optional `statusSink`
updates one editable status identified by its stable key; without it, quiet periods
produce no heartbeat posts. Slack's `queueStatus` implements that sink and reports
elapsed time without a new milestone. Queued human inputs suppress stale narrative
delivery while the supervising agent processes them. A host's long read-only waits
must also yield to native steering; observing progress does not interrupt tools.

History and the narrative transport outbox commit atomically; transport delivery
retains its existing retry semantics. A repeated request reuses its monitor;
follow-ups reuse an active monitor or start one after the previous assignment
settles. Compatible reopenings resume native deadlines. Observation outages stay
visible and retry; authorization is rechecked before observation and delivery.
Older live checkpoints seed their current progress IDs on reopening rather than
replaying their last milestone. Preserve the original native stores and definitions.

Stopping this monitor stops observation, not the external work. The host must
separately implement and report actual cancellation. No host process timer,
second durable queue, credentials or application-specific execution lives here.
