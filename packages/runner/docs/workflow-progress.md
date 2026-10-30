# Separately hosted workflow progress

`createWorkflowProgress` observes an existing run; its execution and authorization
remain host-owned. Register the returned `extension` before native recovery, then
call `watch(api, context, requestId, watch)` after an idempotent start or follow-up.
The watch carries the external run, display author, authenticated origin and
optional reply destination. Never derive origin authority from model text.

Provide `observe`, `authorize`, a `ReplySink` when delivering externally, and
positive `observeEveryMs` / `progressEveryMs` intervals. `observe` returns a stable
milestone `cursor`, factual `summary` and `settled`. Use recorded progress and
execution receipts, not partial model text. `settled` means the assignment
returned; it does not assert successful acceptance.

Native tasks publish cursor changes, periodic latest-progress reports and final
results. History and the transport outbox commit atomically; transport delivery
retains its existing retry semantics. A repeated request reuses its monitor;
follow-ups reuse an active monitor or start one after the previous assignment
settles. Compatible reopenings resume native deadlines. Observation outages stay
visible and retry; authorization is rechecked before observation and delivery.

Stopping this monitor stops observation, not the external work. The host must
separately implement and report actual cancellation. No host process timer,
second durable queue, credentials or application-specific execution lives here.
