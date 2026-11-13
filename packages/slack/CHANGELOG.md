# Changelog

## [Unreleased]

## [0.13.0] - 2026-11-13

- Prepare a public reusable package. Admit channel input through shared host validation and preserve native transactional continuation and delivery receipts.

## [0.8.0] - 2026-11-12

- Align shared Pi dependencies with Runner at 1.5.2 for native Fable 5.2 support; existing installations remain pinned.

## [0.7.0] - 2026-11-09

- Separate durable Stop cancellation progress from retryable acknowledgement delivery, so transport failures cannot cancel newer common-client input.

- Preserve every public native assistant response separately across tools, steering, completion continuations and restart. Replace run-wide mutable progress prose with ordered response identities; Stop closes only current streams. Native slack-turn task version2 requires idle upgrade from version1.

- Carry trusted common-client text/image bytes through existing native admission and delivery; declare explicit background reply transport.

- Include a known remaining answer suffix when closing an uninterrupted stream,
  exposing the completed first message before its canonical update. Consume the
  suffix durably before sending so uncertain stops and recovery cannot replay it.

- Deliver initial partial text without waiting for a sentence or status API call.
  Renew and clear thread indicators in a recoverable native background task.
  Preserve ordered acknowledgements for successful tool-requested termination
  without a duplicate reply or false empty-answer notice.

- Remove temporary progress messages after the ordered final reply is delivered,
  instead of leaving a canned completion message. Resume cleanup retries without
  reposting the answer; preserve commentary and failure details.

- Reuse Runner thread supervision while preserving Slack process, route, profile
  and cancellation recovery behavior.

- Add trusted channel profiles, pinned per supervised thread, while preserving
  string channel routes and keeping capability grants with host policy.
- Allow host-injected thread execution and a token-free worker Web API relay;
  preserve local process defaults, native delivery tasks and existing release pins.

- Preserve retained thread identities when routes change, and optionally pin immutable application entrypoints and Node executables for recovery.

- Share one reply when a follow-up joins active work. Persist commentary cursors
  on first use and claim each native message once across observers and recovery.

- Resume unfinished requests from trusted workflow results after active work and
  human input settle. Revalidate admission and preserve answer ownership on recovery.

- Retain completed public commentary as ordered replies before the final answer,
  using native entry cursors and delivery receipts across restart. Add durable
  editable workflow statuses with coalesced updates and metadata-based recovery.

- Use Pi 1.5 for native execution and transport integration; upgrade the runner and adapters together. Preserve TypeBox tool schemas through a direct dependency.

- Show native tool activity in progress and loading messages, with an optional
  trusted host formatter for readable operations and selected public subjects.
  Keep the subject visible between tool rounds and buffer unfinished sentences.

- Compose the existing thread-process protocol through `runSlackHost`, preserving
  native state, durable Stop, stream receipts and host-owned workspace cleanup.

- Resume unfinished external uploads when Slack reports their allocated IDs as
  `file_deleted`; retain the same ID and still require a verified thread share.
- Add a host evidence gate for partial model text without hiding native activity.
- Retry retained Stop cleanup on supervisor recovery before restarting thread work.

- Deliver retained artifacts with Slack's external-upload API, installed file
  scopes and exact originating-thread receipts. Preserve allocated file identities
  across retry/restart; never report queued or failed uploads as sent.
- Optional per-thread process routing with durable cancellation cutoffs and recovery; busy messages steer the active run without duplicate answers.

- Hand event-scoped search credentials to an optional trusted host callback
  without recording bearer tokens in native transcripts or model context.

- Keep the native thread working indicator alive across tool work and stream
  rollover, clear it on completion, and preserve delivery when status calls fail.
  Read fresh native state when queued or completing turns refresh thread status.
- Show current-round tool counts, retry/context state and elapsed time during
  otherwise silent execution, without exposing reasoning or tool contents.
  Preserve literal Markdown characters in editable progress instead of escaping
  the same text twice.

- Convert tool-backed or long-running streams into editable progress messages
  before Slack's expiry; show later model responses and resume progress updates
  after restart without restarting the underlying work.
- Preserve Markdown formatting when finalizing streamed replies and when posting
  completed replies without a stream, instead of displaying formatting markers
  as literal text.

- Match the runner's Pi Durable/Chord 1.4.0 peers. Keep document changes as deltas
  and use durable sleeps for admission and delivery retries without changing
  saved checkpoint shapes or at-least-once delivery semantics. Upgrade both
  packages together; Pi 1.4's SQLite schema upgrade cannot be rolled back to 1.3.

- Save incoming messages before Slack thread lookups, retry lookups durably,
  and preserve admission order within each thread across restarts. Retain
  existing deduplication keys when upgrading the inbox.
- Recover deleted stream messages by posting the completed answer as an ordinary
  thread reply, and admit human replies sent with "Also send to channel".

- Allow wildcard channel routes, explicit peer-bot addressing, and mention-only
  participation in threads started for another bot, preserving ordinary replies
  in the bot's own threads and DMs.

- Render user mentions as Slack members in streamed and final replies, while
  keeping broadcast tags literal and preserving mentions across chunk boundaries.
- Extract optional Socket Mode routing, native incoming-turn admission, streamed
  receipts and reply recovery into `@dispatch/slack`.
- Bind published report roots to shared conversations with domain origins and
  support idempotent registration of retained report receipts on startup.
