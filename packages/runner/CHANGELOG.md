# Changelog

## [Unreleased]

- Add an optional Gmail adapter with alias/thread/sender conversation bindings,
  authenticated sender restrictions, native durable admission and final replies,
  labeled incoming/sent mail and uncertain-send reconciliation without blind
  resending. Attachments, reply-all and unsolicited background email are excluded.

- Pass installation model-retry policy through to stock Pi Durable, with sustained
  capped backoff, optional jitter and native pending-retry details in snapshots.
  No replacement task loop or workflow resubmission is introduced.

- Add opt-in `clones: true` and `clone_agent` for parallel coordinator assignments.
  Children inherit the stored native agent configuration without copying history
  or widening tool filters. Native ownership and stable submissions preserve
  cancellation/recovery; domain instructions own QA expectations and acceptance.

- Document the accepted agent-local scheduling design and proposed API. Cron,
  timezone scheduling and the `schedules` field remain unimplemented; existing
  triggers and live installations are unchanged.

- Add opt-in service-local messaging between independent top-level instances,
  native replay-safe delivery/outcome receipts and optional replies. Recipients
  retain their own configuration, host adapters and cancellation lifecycle.

- Add an independently installed agent service, a private Unix-socket client API
  and CLI, optional transport adapters, and separate runtime/definition pins.
  Share one native owner across clients and publish conversation-list changes.

- Document installation-owned runtime dependencies and separate company definition checkouts, including immutable deployment and native schema migration boundaries.

- Upgrade the runner's Chord, Pi AI and Pi Durable dependencies to 1.4.0.
  Declare explicit delta-only document checkpoint policies and use native durable
  sleeps for schedules and handoff progress, preserving existing checkpoint shapes.
  Opening SQLite upgrades its schema to version 2; back up closed stores before
  upgrading because Pi 1.3.0 cannot reopen them. Published alpha.4 is unchanged.

- Accept an optional application-owned Storage factory in headless, chat and
  individual-agent entry points, including remote SQLite stores. Preserve the
  default local storage path and working-directory ownership checks.

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
