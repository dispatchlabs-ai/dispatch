# Changelog

## [Unreleased]

- Add `environmentProvider`, a host model provider that binds one of Pi's built-in providers and authenticates it from that provider's own environment variable. `modelProviders.module` accepts a Runner export such as `@dispatch/runner/environment-provider` as well as an absolute path.
- The default release launcher repeats the kit composer's warnings before `NAME catalog`.

## [0.11.2] - 2026-11-12

- Include process discovery's `lsof` dependency in Nix agent/watch commands and the development shell.

- Correct public setup commands, current runtime/distribution guidance and the replacement of Agent Scaffold by the Dispatch Kit.

## [0.11.1] - 2026-11-12

- Handle large inventory arrays, inspect declared systemd template instances, keep disabled services stopped during upgrades and backups, and record and restore state ownership and permissions before replacing the original root.
- Let new coordinator input release a `delegate` or `clone_agent` wait while its
  owned native worker continues. Add scoped `steer_child`, `cancel_child` and
  interruptible `wait_for_child` controls; retain results through restart without
  automatic transport callbacks. Recover older foreground-owned calls without
  duplicating their children; those calls retain their original blocking wait.
- Share read-only unfinished-store inspection with Fleet and allow trusted fenced workspace release rebinding without losing source or artifacts.

## [0.11.0] - 2026-11-12

- Add `dispatch-upgrade` (and `NAME upgrade` in a release's default launcher): from one machine declaration of the selected releases and their consumers, report what is installed where (`status`), check readiness without changing anything (`preflight`), take a verified closed-state backup of each state root (`backup`, `restore`), and move profiles, supervised launchd or systemd services and session owners to the selection, remove what it supersedes and verify that nothing installed or running can load another Pi Durable (`converge`), with a JSON receipt per run. See [upgrading a machine](docs/upgrade.md). `selectRuntime` accepts `beforeSelect`, run under the state root's lock before the version is recorded.

## [0.10.2] - 2026-11-12

- Kit composition accepts `models` in `kit.json`; see the [kit](../kit/README.md).

## [0.10.1] - 2026-11-12

- Fix `withEval` releases whose definitions import `@dispatch/eval`: the package is in place before the catalog is built.

## [0.10.0] - 2026-11-12

- Kit composition accepts `omit` in `kit.json` and `DIR/NAME.company.md` addenda for any kit Markdown file; see the [kit](../kit/README.md).
- `mkAgentRelease` accepts `withEval = true`: the release builder installs the [evaluation package](../eval/README.md) under `lib/NAME/eval` with `bin/dispatch-eval` and a Python interpreter carrying the engine's dependency, and records it in `release.json` under `eval`. It requires the builder's own Runner version. Releases built without it are unchanged.
- Export `sessionAgent`, which retains a session's initial agent selection, for hosts that open an ordinary session directory themselves.

## [0.9.0] - 2026-11-12

- `mkAgentRelease` accepts `withKit = true`: the release builder composes the [kit](../kit/README.md) of starter agents and skills under the company tree, appends `agents/ROLE/company.md` to that kit role, fails on a company file at a kit path unless `kit.json` declares the replacement with a reason, and records the kit in `release.json` and `share/NAME/kit.json`. Releases built without it are unchanged.

## [0.8.0] - 2026-11-12

- `publishReply` accepts optional `details` (label and text): kept on the background-reply entry and in the model message, so the replying agent reads them, and projected on the chat message with the reply's time (`at`) so clients can show them collapsed.

- Run exactly one Pi Durable version per state root. `stateRoot/.runtime.json` records it under a lock: an older runtime refuses to open stores, and any other runtime first closes every live process of another version that owns stores there, waits for all of them, and only then selects itself; interrupted session work is resumed on the selected runtime afterwards. The CLI and `run`/`ChatService.open` (`runtimeRoot`) share the check.
- Let ordinary sessions follow the selected release instead of stranding on the one that created them: owners exit after `ownerIdleMinutes` (default 60), an idle owner with another identity is replaced, a busy owner is joined only when it differs in definitions and not in host configuration, and changed definitions apply once saved work is idle (unfinished work continues with its stored conversation configuration). `--update-definitions` and `--replace-owner` are no longer required.

- Abandon a gateway model request whose stream shows no progress for 3 minutes (minimal/low), 5 minutes (medium) or 10 minutes (high thinking) and let Pi's retry send a fresh one. Stalled Codex requests previously waited for the gateway's 900-second upstream limit; xhigh/max and unstated levels keep that limit. Empty or whitespace-only deltas are not progress (stalled requests streamed such tool-call argument deltas for 15 minutes).

- Patch the packaged Claude Code provider so replayed requests keep signed thinking from earlier assistant turns. Claude Code's history replay dropped it at every tool-use boundary; the same upstream revision is retained with one source patch.

- Avoid sorting entry payloads during saved conversation discovery and selected-history polling, reducing large-history loading cost without truncating history. Catalog entries report chat-index registration and originating transport.

- Restrict bookkeeping termination to the immediate native answer/continuation/status-only sequence, so earlier progress cannot suppress findings after work.

- End status-only completion bookkeeping through native tool termination after a delivered answer, without suppressing unfinished work or new input responses.

- Expose read-only task/submission sidebar states without fetching conversation transcripts.

- Always steer active work for ordinary user chat input at native boundaries; keep internal peer/schedule policies and explicit Stop unchanged.
- Use released Pi 1.5.2 for native Claude Fable 5.2 metadata, thinking levels and pricing. Preserve the Claude Code provider source pin, existing release pins and native session state; live discovery selects the current Fable model. Move Chord foundation types to their public subpaths.

- Make ordinary CLI sessions detached shared owners in their exact native state; discover safely, preserve native receipt/drain/history/replay, and recover existing work without another prompt.
- Project native input/continue submission lifecycle in live and retained chat snapshots, distinguishing stopped turns from tool or request narration.

## [0.7.0] - 2026-11-09

- Bind local commands atomically to expected installation metadata and render retained prompt answers on request replay without resubmitting.

- Share one supervised native owner with CLI and Backend clients; preserve native receipts, Stop, recovery, attachments and tool observations. Add explicit multi-adapter reply routing and conversation-only schedule policy.

- Match JSON-encoded native SQLite tool-task kinds in read-only projection, restoring live task state and retained nested call identity without acquiring ownership.

- Port reviewed native chat improvements: installation-scoped routing and read-only catalogs, retained tool traces and UTF-8/image input/recovery through local and central workers; refresh current shadcn Web compositions.

- Prepare public npm metadata and the complete reusable runtime closure with dependency-order archives and a separately authorized publishing path.

- Export the shared public native message projection for live and saved-history adapters, retaining errors/commentary/timestamps.

- Expose supported host-model, settings and read-only watch-reader subpaths; trusted provider-only hosts no longer require a gateway.


- Align the remaining terminal UI dependency to Pi 1.5.0 and refresh shared locked build inputs alongside Remote and Observer. Web retains its separate Pi 1.4.0 pins. Existing alpha archives and installed runtimes are unchanged.

- Record accepted portable-agent principal, capability, conversation and package
  goals, with linked Remote, Fleet and Slack scope and Pi-based publishing
  guidance; this documentation does not implement or release those additions.

- Run the on-demand launcher and service from their configured host directory,
  so provider subprocesses survive removal of the caller's directory. Watch
  reports a settled unanswered turn as Not answered with its native reason.

- Allow trusted host-owned native Pi provider factories in the service and
  on-demand CLI, including stable aliases for existing agent model selections.
  Package a pinned experimental Claude Code subscription provider separately
  through Nix; keep credentials with the official CLI and preserve native tools,
  state and upstream billing guards.

- Preserve the caller's abort signal across authenticated gateway requests and
  retries, including after response headers arrive and temporary requests expire.

- Include native queued/placed receipt states in handoff progress and distinguish
  requested changes from verified work. Suppress progress during cancellation
  and publish one stop confirmation after native work drains. Acknowledged stops
  settle without a redundant model round; empty acknowledgements do not terminate.

- Keep chat models available in provider pools when another model type shares
  the same ID.

- Accept renewable authorization callbacks for gateway catalog and inference
  requests, including provider pools; refresh once on an authentication rejection
  before admission, with cancellation and same-origin credential confinement.

- Record explicit Stop in unfinished request summaries, including owned children
  and paused-store recovery. Preserve completed requests and ordinary suspension;
  prevent cancelled input from reopening a request while abort takes effect.
- Finish native cancellation before acknowledging Stop even after a worker has
  exited or exceeded its cooperative cleanup deadline.
- Retain the actual Stop input for thread cleanup recovery and acknowledgement
  identity, preserving the thread's originally selected agent.

- Share durable thread-process supervision across delivery adapters; carry terminal
  workflow status explicitly without changing existing Slack routes or identities.

- Compose optional immutable Fleet application releases; allow isolated native
  tools to use host-supplied Pi Storage and execution environments.
- Support one exact root-owned persistent workspace bind for fleet recovery,
  retaining default disposable-workspace behavior for other installations.

- Select `factory.yaml` defaultAgent for new CLI sessions and retain the initial selection when resuming.
- Apply trusted host bindings recursively to private workers; accept broker-backed workspace transports.

- Let direct CLI installations select a trusted artifact source factory so
  files on an authenticated remote computer use the native publication path.

- Hide Watch's scrollbar when the content fits; show it while scrolling longer
  session lists, histories and details.

- Open agent lists at the first conversation and retain unassigned or unavailable
  agent hosts in the full list on narrow terminals.

- Make Watch readable during long runs: keep the latest public update and current
  activity visible, group and pair tool calls/results, add searchable history,
  an error filter, mouse navigation and a responsive agent sidebar.

- Discover direct and nested native service stores as well as on-demand sessions,
  so the shared terminal watcher can serve different company applications.

- Add a separate read-only terminal watcher for local application sessions,
  with process discovery, agent activity, navigable history and matching tool
  results. Viewer exit leaves execution untouched. Nix application releases can
  add this companion while retaining an explicitly pinned execution runtime.

- Yield peer-work waits to queued steering and allow explicit steering messages
  for corrections to active instances, preserving ordinary follow-up delivery.

- Support one editable workflow status and atomic returned-result handoff to the
  supervisor. Retain a stable request identity through follow-ups.

- Publish new public workflow evidence from all participating sources, deduplicate
  repeated milestones, and route quiet heartbeats to an optional editable status
  sink. Preserve narration timestamps and provider commentary labels; suppress
  stale reports while human steering is queued and seed upgraded live cursors.

- Use Pi 1.5 for native execution and transport integration; upgrade the runner and adapters together. Preserve TypeBox tool schemas through a direct dependency.

- Preserve each conversation's exact extension selection when installing host
  summary and reference tools on reopen; registry-only worker capabilities no
  longer become enabled on coordinators or other saved roles.

- Add `wait_for_agent` for existing instance-message assignments, following native
  child ownership and peer handoffs through settlement without model polling.
  Expose recipient capabilities in discovery and drain admitted peer work before
  on-demand CLI exit. Preserve independent lifetimes and distinguish idle work
  from successful acceptance; expose the trusted session path to inspection tools
  and packaged workflow references to every on-demand participant.

- Add opt-in request completion records with Pi Durable's native end-of-answer
  continuation. Preserve the original goal and remaining work through follow-ups,
  compaction and recovery; require a current completion or explicit input/cancel
  assessment before a model answer can end the run.

- Expose configured delegates through `list_agents`, with model/thinking,
  declared tools, host catalog pricing and observations from retained receipts.
  Return child-subtree usage and elapsed-time receipts on delegated results
  without duplicating native usage accounting; retain selection rationales.
  Pricing is estimated and returned answers are not quality verdicts.

- Add opt-in digest-pinned disposable development desktops with host-owned release
  bindings, streamed native tools, verified source checkpoints, explicit cleanup,
  and on-demand CLI recovery through the original runtime and definitions.
  Keep packaged workflow references available through a bounded read-only
  resource tool, and stream checkpoints through the live guest filesystem.

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
