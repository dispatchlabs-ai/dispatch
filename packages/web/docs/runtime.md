# Durable conversation runtime

The service owns `DispatchRuntime` in `server/runtime.ts` and its collaboration extension in `server/collaboration/shared.ts`. Both use stock `@earendil-works/pi-durable` 1.0.1 public interfaces. Authentication supplies company/user scope; model credentials remain on the service.

## Storage and lifetime

Pi owns all native entries, documents, tasks, submissions, generations, cancellation and recovery. The session-scoped catalog holds company agent definitions, private projects and conversation metadata. Each shared conversation has a native `dispatch.shared-conversation` document and `dispatch.public-message` entries. Its independent agent instances have native working conversations in the same Session. There is no separate transcript database or application execution engine.

The service holds an exclusive SQLite transaction on `runtime-owner.sqlite` before opening `pi.sqlite`; a competing owner fails, and the operating system releases the lock after a crash. This does not limit conversations or model calls. State directories use mode `0700` and databases `0600`. Frontend hot reload and browser disconnection do not close the runtime.

Startup installs all extensions, opens Pi storage, seeds missing company definitions, publishes a fresh runtime instance marker, migrates older conversations and calls `Harness.resume()`. Snapshot revisions use Pi’s native commit sequence. `close()` shuts down without converting interrupted work into an explicit user cancellation.

## Membership and agent instances

A human creator becomes a member. Authenticated human members may invite active people and available agent definitions from the same company. An agent may invite company agents only. Native binding documents derive an agent’s room and author identity; model tool arguments cannot choose another author. Read, command and subscription access require company membership and conversation membership.

Each agent definition has one independent instance per conversation. Creation copies its immutable revision, model, instructions, capabilities and thinking level. Developer instances retain a distinct absolute cwd at `<stateDir>/runtime/workspaces/<native agent conversation ID>`. The native execution environment creates the directory when needed. Files survive archive and restart. Paths do not automatically move with the state directory.

The default and Developer definitions are seeded once and remain editable through revisioned company definitions. Basic edits preserve capability selections. An archived definition cannot be newly instantiated or edited; existing instances continue with their saved configuration. The default cannot be archived.

Coding tools have the service account’s filesystem, process and network access. Their directories are not sandboxes. This remains trusted local development on M1 Air; shared deployment and remote isolation are separate work.

## Public messages and native delivery

A public post and its recipient delivery tasks are committed atomically. Other agent members receive native `dispatch.shared-delivery` tasks, each waiting for that recipient’s preceding task. The task submits an idempotent native input and waits for its native settlement. Pi owns execution and recovery; Dispatch adds no numeric concurrency cap, polling coordinator or in-memory work queue.

Notifications contain attributed public data, incoming thread context and a bounded recent-history excerpt. The agent can read all earlier history with `conversation_history`, including before joining and across native reset/compaction. Pagination and long-message text offsets bound individual model results without deleting history. Images are delivered as native image content rather than base64 inside JSON history text.

Final answers become public posts. Exactly `[[silent]]` without images creates no public message. `conversation_post` permits deliberate public posts to another thread or the main conversation; the agent should then finish silently to avoid another automatic post. Every new public message is considered by other agent members. Mentions use participant IDs. A reply names a root public message and shares the conversation’s membership; automatic answers inherit the incoming thread.

Browser snapshots expose public messages, participant identity/saved configuration/usage, and author-scoped tool activity. Private delivery input, reasoning and collaboration control tools are excluded. Safe provisional assistant text streams within attributed activity and remains visible until the matching public answer replaces it. Silence markers and partial marker prefixes are hidden. Tool calls/results retain their native representation. Reset/compaction markers expose only safe identity, head and reason metadata, including boundaries before the first human input; private summaries and handoffs remain excluded. Images remain available in the public log. Snapshots are assembled on Pi’s serialized commit boundary and copied before native document drafts expire.

`watchChat()` observes native commit publications across the participating streams and publishes replacement snapshots. Notifications can coalesce; there is no replay cursor promise. Closing a watcher stops observation only. Session expiry and revocation close protected subscriptions while admitted work continues.

## Stop and recovery

Stop increments a persisted admission epoch and creates a native `dispatch.shared-stop` task. The task aborts and joins admitted delivery tasks, then aborts the agent conversations. It retains committed partial output without waking other agents, marks the instances stopped and clears the admission fence. Messages and invitations receive a retryable conflict while stopping. A later message can resume participation.

The Stop task and delivery chain recover through Pi. A failed Stop remains fenced and can be retried. Provider failure and cancellation remain distinct participant statuses. Recovery can retry a provider generation from its committed checkpoint, so token-exact continuation and exactly-once billing are not promised. Native coding-tool replay policies likewise do not promise exactly-once shell/file effects.

## Existing conversations

Migration keeps old visible conversation IDs, native entries, saved model/instructions/cwd, project preferences and admitted work. It binds the existing native agent as the first participant, imports attributed human/assistant content and queued human inputs into public entries, and augments its available collaboration tools. An in-flight native reporter waits for the existing work rather than resubmitting it. Missing historical accounts retain a former-member identity without authorizing a different person.

Older request fingerprints and native receipts remain authoritative for retries. A matching fingerprint-only reservation may proceed when no native admission happened. Unverifiable historical requests or changed payloads return a conflict; withdrawn inputs with a native receipt are not admitted again.

## Projects and personal preferences

Projects remain private company/user-scoped catalog records with stable UUIDs and names. Project assignment, pin and archive state now live in each human member’s shared-conversation preferences. Moving or archiving a shared conversation affects only that member’s organization. A project grants no access to conversations or model context.

Project creation and assignments use Pi transactions. Creation retries preserve the original `creationProjectId` and agent-definition set, even after later moves. Existing records normalize missing project IDs to null. No project rename/delete API is introduced.

## Request identity

Public posts and invitations retain author-scoped request fingerprints in the native shared document. Matching retries reuse their original result; changed text, thread, mentions or invitation set returns `409`. Public append and native task creation share the same transaction. Native delivery request IDs derive from stable task IDs, so restarting an invocation reuses native admission. Agent tool request IDs derive from native task/call IDs.

All runtime/API behavior remains functionally unqualified under the zero-tests policy. Source review, TypeScript and build evidence are recorded in [WP-024](handoff.md#wp-024--shared-conversations).

## Per-agent MCP connections

`server/mcp.ts` uses stock `@earendil-works/pi-mcp` 1.0.1 with Pi Durable's public
extension, tool and document APIs. The operator file is
`DISPATCH_AGENT_CONNECTIONS_FILE`, defaulting to
`<DISPATCH_DATA_DIR>/agent-connections.json`. Entries belong to an `agentId`; they
are not company-wide defaults. Only public descriptors enter the agent catalog.
Commands, adapter arguments and credential file references stay in the operator
manifest. Secrets must stay in the adapter's credential store, never its arguments.

At startup the runtime restores the last discovered schemas from
`dispatch.mcp-catalog`, connects each configured adapter, and installs its extension
before `resume()`. Failed discovery retains the catalog and exposes an unavailable
status. The authenticated connection view reads process state without making model
calls. Reconnect retries initialization/discovery. Tool-list notifications refresh
the catalog and selected tools. `dispatch-mcp-` extension names and `mcp_` tool names
are reserved for this integration; tool IDs include a stable digest to avoid name
collisions and respect provider name limits.

Each conversation's `dispatch.mcp-bindings` grants only its definition's connections.
The tool wrapper checks that binding before making an MCP call. Forks retain the
binding at their fork point; a newly created task-owned conversation does not gain
credentials merely by inheriting an extension selection. Application-created agent
participants are bound explicitly. The company-scoped catalog controls which
definition can be instantiated. These controls do not isolate the local shell from
files accessible to the service account.

Definition capability changes create a new revision. `applyToExisting: true` is an
operator authorization to add that connection to existing instances. Already-bound
instances receive catalog changes; removal from the manifest removes the binding
and MCP selections on restart. This preserves other tools, instructions, model,
reasoning, working directories and native history. An instance retains its original
definition revision label; its tool list reflects the explicitly updated connection
access. Basic definition edits preserve connections.

Every remote call uses Pi's native tool task, propagates its cancellation signal,
and returns MCP text/images, error state and JSON details. All calls are declared
`replay: "unsafe"`: recovery reports interruption instead of repeating a possibly
committed external write. Wiki's `operation_id` contract remains available for an
informed retry. One adapter is shared per configured agent/connection; its identity
and Wiki run are not per-human or per-Pi-conversation audit identities.

The service closes adapters after Pi stops its work. Wiki's maintained adapter owns
short-lived access tokens, renewal and run closure. The published third-party
Durable adapter was not selected because it binds a runtime to one workspace,
whereas Developer uses separate persistent directories per instance.
