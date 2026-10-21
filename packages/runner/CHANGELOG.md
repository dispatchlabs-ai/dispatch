# Changelog

## [Unreleased]

- Withhold raw chat-provider error details before durable storage while preserving
  Pi retry and context-overflow categories.

- Add optional host-owned API-key sources and terminal setup: native stores,
  external vault helpers, session-only input and explicit environment use.
  Source metadata stays outside the project, and native/helper failures do not
  fall back to plaintext. Helpers resolve on demand; OAuth storage is separate.

- Add opt-in company and agent skill catalogs with on-demand text reads, scoped
  IDs, startup snapshots and definition/content revision tracking.
- Add a direct streaming terminal client with named persistent conversations,
  one-shot prompts, history and interruption recovery.
- Distribute an integrity-pinned runner-only source snapshot for the standalone
  agent scaffold, without requiring checked-in archives or npm publication.

- Accept the native Pi `max` thinking level in agent definitions.

- Extract standalone directory definitions, native schedules, shared conversations
  and private handoffs into `@dispatch/runner` on Pi Durable 1.3.0.
- Add headless adapter lifecycle, existing-host attachment and domain origin
  initialization while preserving configurable native persistence identities.
