# Changelog

## [Unreleased]

- Add a host evidence gate for partial model text without hiding native activity.
- Retry retained Stop cleanup on supervisor recovery before restarting thread work.

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
