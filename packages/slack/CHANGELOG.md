# Changelog

## [Unreleased]

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
