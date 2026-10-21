# Changelog

## [Unreleased]

- Run continuous terminal work in the selected named conversation, retaining the
  initial goal and native loop checkpoints across restarts. Each final answer
  advances to the next pass; `pause_loop` records an explicit blocker. Preserve
  suspended work and reject accidental single-turn or different-session reuse.

- Supply repository `AGENTS.md` instructions to every directory-defined role and
  refresh target-repository guidance before model requests. Add an explicit saved
  working directory and native foreground delegation to named agents.

- Run natively on Windows with automatic private state/configuration ACLs and
  built-in Credential Manager access. Use the same terminal workflow without
  WSL, administrator privileges or an additional native runtime. Strip helper
  credential environment variables case-insensitively on Windows.

- Secure new and existing conversation directories with owner-only POSIX modes
  before opening SQLite, including databases, sidecars and status files. Reject
  unsafe file links and ownership. The subsequent Windows implementation above
  replaces the initial Windows rejection.
- Render terminal control characters as visible escapes in streaming responses,
  completed answers, history, diagnostics and returned errors. Preserve the
  original conversation text in storage and keep ordinary Unicode, tabs and
  newlines readable.

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
