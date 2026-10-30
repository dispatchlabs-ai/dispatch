# Changelog

## [Unreleased]

- Use native terminal submission/loop outcomes for exit status; an earlier
  recovered provider error no longer turns completed work into a failed command.

- Separate summary output allowance from compaction trigger reserves without
  modifying Pi Durable. Preserve the working context and model/thinking, recover
  incomplete summaries through smaller sections, and keep summary work, usage,
  provider retry deadlines and cancellation in native owned tasks.

- Observe separately hosted workflows with native durable progress tasks, atomic
  reply queuing, milestone updates and optional regular progress reports.

- Expose native compaction budgets and failed-run inbox policy in service
  configuration. Add same-conversation manual compaction and report held input,
  compaction progress and failures without resubmitting work or resetting state.

- Pin agent releases to patched Node 24.22.1 and patched shared TLS, Brotli and
  c-ares dependencies; expose the same runtime toolchain for application builds.

- Add model-free native tool workers/proxies, host definition preparation and
  per-input authenticated knowledge gates.
- Compose optional Slack and separately locked business dependencies in agent
  Nix releases; export the native tool launcher.

- Detach retained-artifact results before native transactions settle so
  deduplicated publication and explicit delivery retries return usable metadata.
- Retain documents/images independently of workspace lifetime; expose scoped
  downloads and native delivery receipts across clients, including owned children.
  Add explicit failed-delivery retries without regenerating bytes. First adoption
  requires an idle definition migration.
- Make company instruction provenance definition-root-relative so changing a
  release store path does not invalidate unchanged definitions. Preserve absolute
  target-checkout guidance and explicit idle migration for changed definitions.
  Earlier absolute-path fingerprints require a one-time explicit migration.
- Add a focused Nix Runner package and shared agent-release builder with copied
  definitions, source provenance and build-time catalog loading. Agent repos own
  locked composition; hosts retain secrets/state. The on-demand CLI isolates
  named session stores and uses the terminal client without calendars/listeners.
- Allow terminal hosts to include instance-message recipients in the same
  process without starting their autonomous schedules.
- Manual Linux x86_64 qualification observed parallel streaming processes,
  retained native skill calls/results, history reopening and same-store owner
  rejection. Linux x86_64 and macOS arm64 packages built; other platforms and
  live provider/business workflows remain unqualified by this work.

- POSIX owned process groups with concurrent IPC, enforced tree termination and paused-store cancellation cleanup.

- Move Gmail implementation and its MIME dependencies into `@dispatch/email`.
  Retain an asynchronous `@dispatch/runner/gmail` compatibility entry point;
  installations must include the email package. Email owns sending enablement,
  general outbound tools, uncapped content handling and native delivery recovery.

- Add agent-local cron/timezone schedules with explicit missed-run and instance
  policies, optional expiry, native timer recovery and idempotent admission.
  Expose next/last occurrence and native task state through the service/CLI.
  Waiting timers do not block idle definition updates; existing work survives
  schedule edits and disablement. No external scheduler or concurrency cap.
- Manual macOS/Node 24 observation verified timed synthetic inputs, multiple
  schedules, existing-instance admission, latest-only offline recovery, unchanged
  restart identities, disabled/re-enabled timers, expired activation, and Eastern
  DST calculations. Killing the owner after submission but before receipt recording
  recovered the same input and conversation. These are bounded mechanics checks,
  not an automated suite or a claim about financial side effects or all crash modes.

- Read HTML-only mail without loading remote resources; prefer plain-text
  alternatives and send safe rendered HTML plus plain-text fallbacks.
- Download authenticated-message attachments into private per-message storage,
  expose manifests to native file/document tools, and add `email_attach` for
  user-requested reply files. Preserve file hashes, native turn recovery and
  sender-only delivery, with no automatic execution.

- Reconcile uncertain Gmail sends by a stable delivery header in the Sent thread,
  rather than an RFC Message-ID which Gmail can rewrite. Document alias-sender
  filter conditions to keep sent replies out of the catch-all label.

- Add an optional Gmail adapter with alias/thread/sender conversation bindings,
  authenticated sender restrictions, native durable admission and final replies,
  labeled incoming/sent mail and uncertain-send reconciliation without blind
  resending. Reply-all and unsolicited background email are excluded.

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
