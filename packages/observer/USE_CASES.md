# Observer use cases

Dispatch Observer helps an operator understand local agent work and read the
recorded conversations behind it. This catalog contains 20 intended user goals;
stable IDs survive implementation changes. Unchecked boxes mean the whole goal
is not yet fully implemented and verified across its supported conditions, not
that the capability is absent.

Behavioral contracts and boundaries live in [use-case behavior](docs/use-case-behavior.md)
and [design guidance](DESIGN_GUIDE.md). Dated evidence and platform limits live in
[usage and qualification](docs/usage-guide.md#compatibility-and-qualification),
not in this goal catalog.

## 1. Find and understand work

- [ ] **OBS-018 — Find local work.** An operator discovers workflows and standalone conversations on this machine without knowing each database path.
- [ ] **OBS-019 — Find the latest workflow activity.** An operator identifies the most recently recorded workflow activity among available sources without guessing from assignment numbers or confusing observation time with work time.
- [ ] **OBS-006 — Follow an active agent.** An operator follows retained agent activity while distinguishing execution evidence, unfinished tasks, source connectivity and viewing mode.
- [ ] **OBS-007 — Follow delegation.** An operator follows recorded sender, assignment and native parent relationships to understand who requested work and how it was handed off.
- [ ] **OBS-009 — Understand a workflow.** An operator understands recorded steps, attempts, phases and outcomes while distinguishing partial evidence from the whole workflow's state.
- [ ] **OBS-020 — Understand the reported result.** An operator sees an assignment's latest reported result and reads its source response without treating that report as proof of workflow completion.

## 2. Read the evidence

- [ ] **OBS-010 — Read the conversation.** An operator reads formatted saved messages and inline tool activity in workflow context without losing their place as new records arrive.
- [ ] **OBS-008 — Inspect a tool action.** An operator understands a saved tool call and its identity-matched result, including available timing, errors and missing or truncated evidence.
- [ ] **OBS-011 — Review earlier work.** An operator reads finished or interrupted work even when the executing process is no longer available.
- [ ] **OBS-012 — Replay recorded activity.** An operator steps or plays through retained events without executing tools, contacting a model or changing agent state.
- [ ] **OBS-013 — Recognize incomplete evidence.** An operator distinguishes recorded facts from unavailable relationships, timestamps, intermediate states and artifacts.
- [ ] **OBS-014 — Recover from a disconnect.** An operator retains the last readable view and reconnects to its source without restarting work or silently leaving playback.

## 3. Connect to existing state

- [ ] **OBS-001 — Open local SQLite.** An operator opens an existing supported Pi SQLite database read-only while its owner is running or stopped.
- [ ] **OBS-002 — Read central Postgres.** An operator inspects an authorized Postgres logical store without mixing identities or records from other stores.
- [ ] **OBS-003 — Tunnel to Postgres.** An operator reaches an authorized Postgres store through SSH or AWS SSM without exposing a public database port or bypassing authentication.
- [ ] **OBS-004 — Read remote SQLite.** An operator inspects SQLite on its host through an authorized helper and protected transport without mounting the live database over a network.
- [ ] **OBS-005 — Manage saved sources.** An operator manages named connections and appearance in Settings while preserving the current reading and inspection state.

## 4. Operate safely on desktop

- [ ] **OBS-015 — Use a native desktop viewer.** An operator navigates readable, resizable, keyboard-accessible windows on each qualified desktop platform.
- [ ] **OBS-016 — Inspect unfamiliar extensions.** An operator receives a faithful generic record view or an actionable compatibility explanation without automatic migration.
- [ ] **OBS-017 — Inspect untrusted content safely.** An operator deliberately reads sensitive saved content without executing it or automatically retrieving linked resources.

## Deliberate boundaries

Observer is read-only toward agent state: it does not launch agents, send messages,
retry tools, migrate stores or acquire execution ownership. Mobile layouts,
remote automatic discovery, hosted multi-user aggregation and arbitrary artifact
retrieval are outside the current scope. Local preferences and owned connection
transports are separate from agent execution. Existing stores remain canonical;
a new telemetry database is not required.

Before removing a supported capability, inspect actual usage evidence and record
its environment, time window, attribution and coverage limits separately. Missing
instrumentation or no observed hits does not establish that a capability is unused.
