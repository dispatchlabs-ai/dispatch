# Changelog

## [Unreleased]

- Align shared Pi dependencies with Runner at 1.5.2 for native Fable 5.2 support; existing installations remain pinned.

## [0.7.0] - 2026-11-09

- Carry trusted common-client text/image bytes through existing native admission and delivery; declare explicit background reply transport.

- Reuse the automatic working message for the final answer and one owned status
  for Stop, preserving the chosen acknowledgement across retries and restart.
  Retain earlier progress as history without Google Chat deletion tombstones.
- Add Google Chat app delivery through Pub/Sub, native durable thread admission,
  steering, deduplicated replies, editable progress and authenticated Stop.
- Support host-owned per-thread processes and request-scoped workflow continuation.
