# Changelog

## [Unreleased]

- Remove owned status messages on Stop and send one replay-safe acknowledgement;
  remove automatic working status only after the final reply is delivered.
- Add Google Chat app delivery through Pub/Sub, native durable thread admission,
  steering, deduplicated replies, editable progress and authenticated Stop.
- Support host-owned per-thread processes and request-scoped workflow continuation.
