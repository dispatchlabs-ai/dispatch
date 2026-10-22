# Observer use cases

Dispatch Observer is intended for a person operating Pi Durable agents who needs
to understand current work and inspect what happened afterward. Its desktop UI
works against the agents' existing stores, wherever those stores live.

**Implementation status, October 22, 2026:** the Electron app implements the
inspection, connection, and playback flows below. macOS has interactive evidence;
Windows/Linux desktop execution and Postgres over SSM remain unqualified. See
[dated qualification and limits](docs/usage-guide.md#compatibility-and-qualification)
for the evidence against these stable identifiers. A source implementation is not
proof of platform qualification.

## Connect to existing state

| ID | User goal | Required observable outcome |
| --- | --- | --- |
| OBS-001 | Open a local SQLite database. | A native file picker selects an existing supported Pi database. The app validates it without creating, migrating, or changing it, then lists available conversations/activity. Reading works beside its owner and when the owner is stopped. A missing file is reported, never created. |
| OBS-002 | Inspect agents using central Postgres. | Configure a database connection and select an authorized logical store. Conversations, tasks, entries, and documents stay scoped to that source/store. Numeric record IDs from different stores never collide in the UI. A read-only database identity and read-only transactions are supported. |
| OBS-003 | Reach Postgres through a tunnel. | Choose SSH or AWS SSM, validate transport and database access separately, and reach the same store without exposing a database port publicly. Closing or reconnecting the viewer only affects its own connection. A tunnel does not bypass database authentication or TLS identity verification. |
| OBS-004 | Read SQLite on a remote host. | Select a host, SSH or AWS SSM transport, and an existing remote database path. A compatible read-only helper queries SQLite on its own machine and returns snapshots/activity through the protected channel. The app explains a missing helper or unsupported host without pretending the database is empty. |
| OBS-005 | Reuse named connections. | Save a friendly name and non-secret connection settings, switch sources, and reopen the last selection. Secrets use the operating system's protected credential facility or an explicitly configured credential provider; an unavailable secure store is visible and never causes plaintext fallback. No account with a hosted Observer service is required. |

## Understand current work

| ID | User goal | Required observable outcome |
| --- | --- | --- |
| OBS-006 | Follow an active agent. | Show its current retained task/activity, recent tool calls, latest conversation content, and last successful observation time. New commits refresh the view. Pausing following preserves the selected event while the agent continues. Agent execution and database connectivity have separate status indicators. |
| OBS-007 | Follow delegation. | Expand recorded parent/child conversation and task relationships, select a child, and inspect its assignment, conversation, tools, and outcome. Waiting parents and working children remain distinguishable. Missing or cross-store links are labeled; similar names or timestamps do not establish a relationship. |
| OBS-008 | Inspect a tool call. | Show the retained tool name, arguments, result, duration, error, and native identity when available. Match calls to results by recorded identity. Distinguish an in-progress call, a recorded failure, truncated output, redacted content, and a result that was not retained. |
| OBS-009 | Inspect a workflow. | Show recorded deterministic steps as well as agent work, current/final phase, child activity, attempts, outcomes, and retained artifacts. Separate a failed attempt from a later successful workflow. Custom workflow documents can enrich the view without being required to inspect ordinary Pi records. |
| OBS-010 | Read the relevant conversation. | Move from an activity or child to its saved transcript, with formatted Markdown messages, expandable tool calls/results, readable multiline output, and retained fork/reset/compaction boundaries. Native records remain inspectable. The transcript is what was saved; it is not presented as the exact provider request or as a full record of private model reasoning. |

## Inspect retained history

| ID | User goal | Required observable outcome |
| --- | --- | --- |
| OBS-011 | Review finished or interrupted work. | Select retained activity by agent/conversation and time, then inspect its saved records even when the executing process is unavailable. Reading a pending task does not resume it. A stopped process is not required for inspection; the database or a consistent snapshot must remain available. |
| OBS-012 | Step through what happened. | Play, pause, step backward/forward, scrub, and change playback speed across recorded events. Event order is stable within the selected source and observation boundary. Playback never calls a provider, executes a tool, retries a workflow, or writes target state. Returning to live is explicit. |
| OBS-013 | Understand incomplete evidence. | Mark unavailable intermediate states, omitted/truncated tool output, retired temporary documents, and unknown timestamps. Display current/final workflow state separately from the selected historical event. Do not fabricate missing phase transitions, token streams, or task-state history. |
| OBS-014 | Investigate an apparent stall or disconnect. | Preserve the last readable state and its timestamp when the source is lost, show the connection error separately, and allow reconnecting without restarting work. A saved running task is labeled as last observed when runtime presence cannot be confirmed. Reconnection restores selection and does not silently leave recorded playback. |

## Operate the desktop app

| ID | User goal | Required observable outcome |
| --- | --- | --- |
| OBS-015 | Use the same model on macOS, Windows, and Linux. | Native file dialogs, platform-appropriate window controls and shortcuts, keyboard access, readable resizable panes, and secure credential handling work on each qualified platform. The macOS reference images establish visual direction, not Windows/Linux installer or runtime evidence. |
| OBS-016 | Open unfamiliar agent extensions safely. | Check Pi/storage compatibility before interpreting records. Supported unknown kinds have a redacted generic record view; unsupported schemas show an actionable compatibility message and never auto-migrate. Agent-specific labels enrich, rather than replace, native identities. |
| OBS-017 | Inspect sensitive or untrusted content deliberately. | Credential/provider state is excluded; tool output and transcript content are treated as data, never scripts or commands. Links require a deliberate external-open action. Source/store selection defines the accessible scope; opening a database does not recreate the target application's end-user permission model. |

## Scope boundaries

- Observation is read-only with respect to agent state. Saving local connection
  preferences or starting a transport/helper is distinct from running agent work.
- Play-by-play uses retained evidence. Exact historical frames, every token, every
  ephemeral task document, and historical re-execution are not promised.
- Creating agents, sending messages, editing definitions, pausing/stopping agents,
  approving tools, and retrying workflows are outside this observer's current scope.
- Existing stores remain canonical. A new telemetry database, agent migration,
  mandatory central server, and automatic agent instrumentation are not required.
- General-purpose SQL editing, cross-company data aggregation, shared hosted
  accounts, and exporting sensitive transcripts are not part of this design slice.
- Files/artifacts outside the Pi store require a separately authorized retrieval
  path. A recorded artifact reference alone does not make its bytes available.

See [DESIGN_GUIDE.md](DESIGN_GUIDE.md) for interaction rules, record fidelity,
connection lifecycle, visual tokens, and the implementation’s qualification requirements.
