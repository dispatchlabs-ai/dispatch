# Slack use cases

- **SLK-001 — Connect:** install optional transport dependencies and configure a
  workspace/channel/agent binding with host-supplied secret names.
- **SLK-002 — Converse:** handle mentions and replies in established threads,
  attributing each human in one persistent conversation per thread.
- **SLK-003 — Discuss reports:** publish a report carrying an origin reference,
  retain its thread binding and backfill existing roots without rerunning work.
- **SLK-004 — Recover delivery:** deduplicate incoming event copies and resume
  native turn/reply tasks after restart, with explicit at-least-once posting.
- **SLK-005 — Share a workspace:** allow an agent in invited channels and DMs;
  direct explicit mentions to the intended bot and keep another bot's threads
  from becoming competing automatic conversations.

Slack app creation, workspace invitations, company policy and business research
belong to administrators or company definitions. The package does not infer those
permissions from a message or create an HTTP endpoint.
