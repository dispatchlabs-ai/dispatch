# Slack use cases

- **SLK-001 — Connect:** install optional transport dependencies and configure a
  workspace/channel/agent binding with host-supplied secret names.
- **SLK-002 — Converse:** handle mentions and replies in established threads,
  including replies broadcast to the channel, attributing each human in one
  persistent conversation per thread.
- **SLK-003 — Discuss reports:** publish a report carrying an origin reference,
  retain its thread binding and backfill existing roots without rerunning work.
- **SLK-004 — Recover delivery:** deduplicate incoming event copies and resume
  native admission/turn/reply tasks after restart, retry thread lookups from
  locally saved input, and deliver a final answer when its stream was deleted,
  with explicit at-least-once posting. Keep long-running work visibly active
  beyond Slack's stream lifetime, renew the native loading indicator during quiet
  execution, and show safe execution-derived progress without requiring model
  narration. Retain completed public commentary in order across model rounds and
  process restarts, followed by the final answer. Stream initial response text
  without waiting for status writes; buffer unfinished sentences in editable
  tool progress. Recognize successful native termination with a delivered
  acknowledgement without a duplicate reply or false failure notice.
  Keep unchanged external-workflow heartbeats in one editable status. Allow trusted hosts to describe the
  actual operation and select public subjects for both the progress message and
  loading text; completion of an earlier turn must not clear a later active turn.
- **SLK-005 — Share a workspace:** allow an agent in invited channels and DMs;
  direct explicit mentions to the intended bot and keep another bot's threads
  from becoming competing automatic conversations. One app can select trusted
  profiles per channel, retaining each thread's agent and profile across recovery;
  host adapters enforce the selected capabilities without model-supplied grants.
- **SLK-006 — Bind search credentials:** hand an eligible event's action token
  and verified origin to trusted host code without putting credentials in native
  input. Redelivery can refresh that handoff without duplicating the message;
  a failed handoff leaves the event unacknowledged for retry.

- **SLK-007 — Own thread lifecycles:** optionally launch an isolated process per
  thread, steer active work, cancel its owned descendants without affecting other
  threads, and retain history and cancellation decisions across restart. A trusted
  executor may place the whole native thread remotely while one coordinator keeps
  Socket Mode, release pins and stream receipts; worker Web API calls use a scoped
  host relay without Slack tokens.

Slack app creation, workspace invitations, company policy and business research
belong to administrators or company definitions. The package does not infer those
permissions from a message or create an HTTP endpoint.
