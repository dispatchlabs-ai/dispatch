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
  narration. Show the latest public response across model rounds and process
  restarts; completion of an earlier turn must not clear a later active turn.
- **SLK-005 — Share a workspace:** allow an agent in invited channels and DMs;
  direct explicit mentions to the intended bot and keep another bot's threads
  from becoming competing automatic conversations.
- **SLK-006 — Bind search credentials:** hand an eligible event's action token
  and verified origin to trusted host code without putting credentials in native
  input. Redelivery can refresh that handoff without duplicating the message;
  a failed handoff leaves the event unacknowledged for retry.

Slack app creation, workspace invitations, company policy and business research
belong to administrators or company definitions. The package does not infer those
permissions from a message or create an HTTP endpoint.
