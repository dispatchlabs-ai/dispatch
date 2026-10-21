# Changelog

## [Unreleased]

- Allow wildcard channel routes, explicit peer-bot addressing, and mention-only
  participation in threads started for another bot, preserving ordinary replies
  in the bot's own threads and DMs.

- Render user mentions as Slack members in streamed and final replies, while
  keeping broadcast tags literal and preserving mentions across chunk boundaries.
- Extract optional Socket Mode routing, native incoming-turn admission, streamed
  receipts and reply recovery into `@dispatch/slack`.
- Bind published report roots to shared conversations with domain origins and
  support idempotent registration of retained report receipts on startup.
