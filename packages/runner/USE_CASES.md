# Runner use cases

This catalog records intended actor goals, including accepted additions; it does
not certify implementation, package publication or installation qualification.

## 1. Existing execution and application goals

- **RUN-001 — Start application definitions:** a Markdown file defines a
  conversational agent; optional TypeScript adds capabilities and schedules.
  A root `agent.md` and `dispatch serve` suffice; no trigger, dummy input, factory
  file, host JSON, generated application code or Nix is required for conversation.
- **RUN-002 — Recover work:** preserve native tasks, conversations and submissions
  across restarts, with one owner per SQLite session and stable native identities.
  Secure new and existing stores with owner-only POSIX permissions or native
  Windows ACLs before opening them; reject unsafe paths or unsupported permission
  enforcement without asking users to configure permissions themselves.
- **RUN-003 — Share conversations:** admit idempotent turns, inspect history and
  streaming state, and bind external thread keys to application-supplied origins.
- **RUN-004 — Attach domain workflows:** share a host with specialized native
  workflows while giving discussions their own configured tools and instructions.
- **RUN-005 — Delegate privately:** keep each conversation's helper and progress
  separate, preserving the existing native ownership and recovery model.
- **RUN-006 — Use scoped skills:** opt into company and agent-specific skill
  discovery, load instructions/resources on demand and retain revision evidence.
- **RUN-007 — Chat in a terminal:** connect to an explicitly started host, stream
  turns, return to named conversations and disconnect while work continues.
  Explicit Stop cancels the selected owned work. Display untrusted terminal
  controls as visible escapes without changing stored conversation content.
- **RUN-008 — Use host-owned credentials:** configure a native store or trusted
  vault helper, resolve API keys directly into Pi, inspect only source metadata,
  and explicitly select session/environment compatibility without plaintext
  fallback; bind trusted native providers to existing agent model names, including
  a locally authenticated Claude Code subscription. This does not supply isolation
  for untrusted code or OAuth storage.
- **RUN-009 — Work in a repository:** supply each agent with repository instructions
  and its own role instructions, select a saved working directory, and delegate
  bounded assignments to named agents with native ownership and recovery.

- **RUN-010 — Choose storage:** supply an application-owned Pi Storage factory,
  including the optional remote SQLite service, while retaining local status
  projections, ownership checks and the default local SQLite path.

- **RUN-011 — Install a shared agent service:** independently select runtime
  and definition revisions, discover available agents, and use local clients
  and transport adapters against the same native conversation owner.

- **RUN-012 — Message independent instances:** address permitted agent instances,
  create an independent recipient when needed, deliver assignments/updates and
  optional replies through native queued inputs, and inspect attributed outcomes
  without parent-owned delegation or another persistence/recovery system.

- **RUN-014 — Coordinate parallel clones:** opt into fresh, task-owned children
  with the parent's stored agent configuration and tool filters, run independent
  assignments concurrently, and reconcile their reports through native tool
  results, ownership and recovery. Release a wait for new coordinator input, then
  steer, cancel or resume waiting for only that coordinator's delegated children.

- **RUN-015 — Wait through provider outages:** configure sustained native model retries
  with capped exponential backoff and jitter, inspect the next attempt, recover
  the same submission after restart, and cancel without a replacement workflow.

- **RUN-016 — Converse by email:** expose native work through the
  [email package](../email/USE_CASES.md), sharing conversations, tasks and recovery
  rather than embedding email policy or a second runtime in Runner.

- **RUN-013 — Schedule agent-local assignments:** define named schedules and
  predefined prompts beside an agent, including daily calendar-time execution
  in an explicit timezone, with shared Runner admission and native Pi recovery.
  See the [calendar contract and recovery](docs/schedules.md).

- **RUN-017 — Own process trees:** supervise trusted POSIX workers and inherited
  descendants; distinguish recoverable suspension from durable cancellation.

- **RUN-018 — Release an agent application:** install a published runtime in an
  ordinary application and lockfile; optionally package it with Nix. Upgrade the
  library and restart the host independently of source definitions and native state.

- **RUN-019 — Isolate native tools:** retain native execution/retry identities
  while a host runs tools outside its credential-bearing primary process.
- **RUN-020 — Require knowledge consultation:** withhold actions and answers until
  authenticated knowledge evidence covers the current request, including steering.

- **RUN-021 — Recover context compaction:** configure native trigger reserves,
  distinguish held input from executing work, and compact the same conversation
  to continue queued work without discarding history or replaying completed tools.
  Budget summaries separately from the trigger, recover incomplete summaries
  with smaller source sections, and retain attempts, usage and cancellation in
  Pi's native task ownership and recovery model.

- **RUN-022 — Resume a disposable development workspace:** pin the application
  release and prepared desktop image on admission; keep native history and host
  credentials outside the guest; preserve source/results before reclaiming the
  writable layer, and restore unfinished work on its original release.

- **RUN-023 — Select workers with cost evidence:** A coordinator can inspect configured worker capabilities and catalog prices, delegate concurrently, and use recorded outcomes, elapsed time and usage costs to inform later choices.

- **RUN-024 — Await an independent workflow:** A conversational agent can discover specialized capabilities, send a scoped assignment, await native children and subsequent peer handoffs, and reconcile the final report in its original conversation without model polling or duplicate admission.

- **RUN-025 — Watch local sessions:** An operator can discover running application sessions, follow agent activity, inspect retained conversations and matching tool results, and leave the terminal viewer without affecting execution.
  Keep the latest public update visible, browse compact action groups, search
  loaded history, and inspect tool errors through keyboard or mouse navigation.

## 2. Portable agents and published packages

Accepted November 9, 2026. These additions require integration and qualification;
the [ownership direction](docs/definition-workspaces.md#accepted-portable-agent-direction)
records the agreed boundaries and existing foundations.

- **RUN-026 — Act as an agent principal:** An agent acts through its own service
  identities and granted authority, with actions attributed to that principal
  and the executing instance.
- **RUN-027 — Run the same agent anywhere:** An operator runs an agent locally,
  on a server or in an ephemeral sandbox with the selected definition, runtime,
  model configuration, skills, tools and authority preserved.
- **RUN-028 — Authorize runtime instances:** An operator enrolls, renews and
  revokes an instance's access to an agent principal independently of other
  instances of that agent.
- **RUN-029 — Use portable capabilities:** An agent uses its authorized services
  from any supported execution location through consistent tool interfaces and
  centrally managed service credentials.
- **RUN-030 — Continue across interfaces:** An authorized participant discovers,
  inspects and continues the same durable conversation from web, CLI or messaging
  clients with consistent access, authorship and explicit reply destinations.
- **RUN-031 — Work concurrently as one agent:** Participants collaborate in shared
  conversations while the same agent principal handles independent conversations
  and tasks concurrently without mixing their context or ownership.
- **RUN-032 — Validate before rollout:** An operator exercises an agent release
  locally against an explicit target environment with the same capability
  contracts, then deploys that selected release.
- **RUN-033 — Build an independent agent application:** A developer composes an
  application from published, versioned Dispatch packages using its own agent
  definitions and interfaces without a Dispatch source checkout or the full
  browser application.
- **RUN-034 — Connect MCP tools from settings:** An operator configures authorized
  MCP servers once in the host; each agent selects named connections in Markdown.
  Discover server-defined tools and execute them through Pi Durable with retained
  results, cancellation and recovery, without an agent-specific protocol adapter.
  See [MCP connections](docs/mcp.md) for the supported transports and boundaries.

Remote persistence and connectivity belong to
[Remote's goals](../remote/USE_CASES.md#2-portable-service-additions);
provider placement and reusable infrastructure consumption belong to
[Fleet's goals](../fleet/USE_CASES.md#2-portable-deployment-additions).

## Availability

The extraction supports Node, SQLite and trusted company definitions.
Hosted Dispatch Web adoption, broad disposable-host qualification, npm
registry publication and broad installation qualification remain separate work.
Runner source snapshots can be installed from public GitHub release archives;
their exact tag, source revision and lockfile integrity identify the bytes.

## Explicitly retired

Automatic detached CLI owners, Backend-created writers, machine-wide runtime
selection/takeover, and the machine upgrade command are removed. Their conversation,
recovery and deployment goals use explicit hosts, clients and normal application
upgrades instead. No migration machinery is introduced.
