# Changelog

## [Unreleased]

- Carry trusted common-client text/image bytes through existing native admission and delivery; declare explicit background reply transport.

- Reuse the automatic working message for the final answer and one owned status
  for Stop, preserving the chosen acknowledgement across retries and restart.
  Retain earlier progress as history without Google Chat deletion tombstones.
- Add Google Chat app delivery through Pub/Sub, native durable thread admission,
  steering, deduplicated replies, editable progress and authenticated Stop.
- Support host-owned per-thread processes and request-scoped workflow continuation.
