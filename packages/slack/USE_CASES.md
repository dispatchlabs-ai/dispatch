# Slack use cases

This catalog records intended actor goals; accepted additions do not establish
implementation or deployment.

## 1. Existing Slack goals

- **SLK-001 — Connect:** install optional transport dependencies and configure a
  workspace/channel/agent binding with host-supplied secret names.
- **SLK-002 — Converse:** handle mentions and replies in established threads,
  including replies broadcast to the channel, attributing each human in one
  persistent conversation per thread while independent threads proceed concurrently.
- **SLK-003 — Discuss reports:** publish a report carrying an origin reference,
  retain its thread binding and backfill existing roots without rerunning work.
- **SLK-004 — Recover delivery:** deduplicate incoming event copies and resume
  native admission/turn/reply tasks after restart, retry thread lookups from
  locally saved input, and deliver a final answer when its stream was deleted,
  with explicit at-least-once posting. Keep long-running work visibly active
  beyond Slack's stream lifetime, renew the native loading indicator during quiet
  execution, and show safe execution-derived progress without requiring model
  narration. Retain EACH public response in chronological messages, including
  intermediate final answers before native completion continuations, tools and
  steering; never replace completed prose with a later response. Deduplicate by
  native response identity, not text or whole-run answer. Stream only the current
  response, recover ordered chunks/receipts, and preserve completed messages on
  Stop. Public tool labels remain independent from prose and private thinking.
  Keep unchanged external-workflow heartbeats in one editable status. Hosts select
  safe public operation labels; earlier completion must not clear later activity.
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

## 2. Shared service additions

Accepted November 9, 2026; integration with other clients remains to be qualified.

- **SLK-008 — Continue a shared thread elsewhere:** An authorized participant
  opens the same thread's durable conversation in another client while preserving
  human authorship, the agent principal, audience permissions and reply routing.

See [Runner's cross-interface goal](../runner/USE_CASES.md#2-portable-agents-and-published-packages)
and the [ownership direction](../runner/docs/definition-workspaces.md#accepted-portable-agent-direction).

## 3. Administrative boundaries

Slack app creation, workspace invitations, company policy and business research
belong to administrators or company definitions. The package does not infer those
permissions from a message or create an HTTP endpoint.
