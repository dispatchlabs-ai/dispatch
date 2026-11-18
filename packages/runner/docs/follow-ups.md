# Persistent follow-ups

Import `followUps` from `@dispatch/runner/follow-ups` and include the returned extension in the agent definition. Supply an enrolled owner, polling interval, named source readers, review instructions and a recipient-bound [notification destination](monitors.md). The usual host and clients start and resume these tasks. Each case runs independently.

The owner starts a case in a private conversation with a stable ID, title, selected source keys and an optional absolute baseline. Give it a first event to notify on, individual questions to settle, or both. For example, the owner can ask to hear when a supplier first replies and whether two separate shipments will arrive by a named date. Each answer carries the author, time, link and an exact passage from the source. A definitive negative answer also settles a question.

The optional [Gmail package](../../email/README.md#read-only-follow-ups) supplies `mail-thread` and `mail-search`. The [Slack monitor](../../slack/README.md#read-only-monitoring) supplies `slack.followUp` for a named thread. Register them with `sources: { ...gmailFollowUpSources({ accountsFile }), "slack-thread": slack.followUp }`. Keep source names and account aliases stable when resuming saved cases.

Each source declares a description for its key and implements `read(key, since, signal, call)`. A source that names a configured MCP connection receives its host-bound read client. Return messages with source-stable IDs, original timestamps, author, text and HTTPS links. Mark the owner's outgoing messages and automatic responses. Use the same ID when multiple selectors can return the same message, and surface incomplete reads as errors.

Changed incoming messages trigger a private review. The durable task records each notification before delivery and retries it with the same ID. Status includes source coverage, outstanding questions and delivery receipts. A failed source read keeps the case open. After the requested first event and all answers have been delivered, the case closes. The owner can also stop it from private chat.
