# Durable conversation runtime

The service owns `DispatchRuntime` in `server/runtime.ts` and its collaboration extension in `server/collaboration/shared.ts`. Both use stock `@earendil-works/pi-durable` 1.0.4 public interfaces. Authentication supplies company/user scope; model credentials remain on the service.

## Storage and lifetime

Pi owns storage, tasks, submissions, generations, cancellation and recovery. The session-scoped catalog holds company agent definitions, private projects and conversation metadata. Each shared conversation has a `dispatch.shared-conversation` document and an application-defined public log of `dispatch.public-message` entries. Dispatch copies public contributions into this log with their author and thread; it is distinct from each agent’s native working transcript, though both are stored by Pi in the same Session. The public log provides shared history without exposing private working context. There is no separate transcript database or application execution engine.

The service holds an exclusive SQLite transaction on `runtime-owner.sqlite` before opening `pi.sqlite`; a competing owner fails, and the operating system releases the lock after a crash. This does not limit conversations or model calls. State directories use mode `0700` and databases `0600`. Frontend hot reload and browser disconnection do not close the runtime.

Startup installs all extensions, opens Pi storage, seeds missing company definitions, publishes a fresh runtime instance marker, migrates older conversations and calls `Harness.resume()`. Snapshot revisions use Pi’s native commit sequence. `close()` shuts down without converting interrupted work into an explicit user cancellation.

## Membership and agent instances

A human creator becomes a member. Authenticated human members may invite active people and available agent definitions from the same company. An agent may invite company agents only. Native binding documents derive an agent’s room and author identity; model tool arguments cannot choose another author. Read, command and subscription access require company membership and conversation membership.

Each agent definition has one independent instance per conversation. Creation copies its immutable revision, model, instructions, capabilities and thinking level. Developer instances retain a distinct absolute cwd at `<stateDir>/runtime/workspaces/<native agent conversation ID>`. The native execution environment creates the directory when needed. Files survive archive and restart. Paths do not automatically move with the state directory.

The default and Developer definitions are seeded once and remain editable through revisioned company definitions. Basic edits preserve capability selections. An archived definition cannot be newly instantiated or edited; existing instances continue with their saved configuration. The default cannot be archived.

Coding tools have the service account’s filesystem, process and network access. Their directories are not sandboxes. This remains trusted local development on M1 Air; shared deployment and remote isolation are separate work.

## Public messages and native delivery

A public post and its recipient delivery tasks are committed atomically. Other agent members receive native `dispatch.shared-delivery` tasks, each waiting for that recipient’s preceding task. The task submits an idempotent native input and waits for its native settlement. Already-considered queued messages coalesce; an existing native receipt is joined before considering a delivery skippable. Pi owns execution and recovery; Dispatch adds no global numeric concurrency cap or in-memory work queue.

Notifications contain attributed public data, incoming thread context and a bounded recent-history excerpt. The agent can read all earlier history with `conversation_history`, including before joining and across native reset/compaction. Pagination and long-message text offsets bound individual model results without deleting history. Images are delivered as native image content rather than base64 inside JSON history text.

The generation’s `onYield` hook is the sole publisher of ordinary successful final answers. Delivery completion records status and never republishes a successful final. Exactly `[[silent]]` without images creates no public message. `conversation_post` permits deliberate public posts to another thread or the main conversation; the agent should then finish silently to avoid another automatic post. Every new public message is considered by other agent members. Mentions use participant IDs. A reply names a root public message and shares the conversation’s membership; automatic answers inherit the incoming thread.

Browser snapshots expose public messages, participant identity/saved configuration/usage, and author-scoped tool activity. Private delivery input, reasoning and collaboration control tools are excluded. Safe provisional assistant text streams within attributed activity and remains visible until the matching public answer replaces it. Silence markers and partial marker prefixes are hidden. Tool calls/results retain their native representation. Reset/compaction markers expose only safe identity, head and reason metadata, including boundaries before the first human input; private summaries and handoffs remain excluded. Images remain available in the public log. Snapshots are assembled on Pi’s serialized commit boundary and copied before native document drafts expire.

`watchChat()` observes native commit publications across the participating streams and publishes replacement snapshots. Notifications can coalesce; there is no replay cursor promise. Closing a watcher stops observation only. Session expiry and revocation close protected subscriptions while admitted work continues.

## Listening and speaking turns

`server/collaboration/turns.ts` defines the native `dispatch.conversation-turns` document, `dispatch.wait-for-turn` task and `dispatch.composing-expiry` task. The room document records waiting tickets, a speaker and ordered human composing signals. Public-message admission prequeues available agent participants together; mentions have priority, then older opportunities, then a stable message/participant hash rather than registration order. Actual generation or public-post tasks bind these tickets to their native lifetimes.

Generation hooks acquire a turn before a provider request and append a fresh, attributed, bounded public-history notice to that request. A task-scoped `dispatch.listening-request` document retains the preparation cursor; a successful provider response advances the participant's consideration cursor. Spoken updates that accompany ordinary tool calls become idempotent public messages before the turn is released, so peers can read them while the author works. Control-only commentary stays private. Tool rounds and provider errors release the turn. A final answer is published in the same transaction as its freshness check and turn release; native task IDs deduplicate that publication across recovery. Native gate tasks use Pi's cancellable clock to recheck claims and presence every 200 ms; they remove claims whose owner task is terminal or aborted. No detached host scheduler owns progress.

At a final-answer boundary, intervening messages or active human composing cause native continuation with refreshed context. Superseded generation IDs exclude the draft from public activity and Stop preservation, without changing its private native history. `conversation_post` also acquires a turn and rejects arguments made stale by another participant's message. Generation hooks normally treat errors as nonfatal in Pi; the application cancels the native generation if coordination fails, so a hook failure cannot bypass the gate.

The public log itself records publication: generation IDs identify final/progress contributions, and native entry IDs identify retained interrupted output. One identity lookup drives retry suppression, activity rendering and interruption recovery. There are no separate `reported` or `finalized` member lists to synchronize with the log. Superseded-generation IDs remain necessary to exclude private drafts that have no public entry. Stop and failed delivery share the same selection of committed output left by interrupted work, excluding anything already public or superseded. This preserves unpublished native output even from older admitted work. The legacy reporter still drains work admitted before shared-conversation migration; it uses the same identity checks.

A versioned startup migration handles the historical dual-publisher bug once per existing room. It aliases only final/delivery pairs whose native generation ownership, author, thread and content agree, removes obsolete publication lists, and records completion before native work resumes. New rooms start at the current version. Existing aliases remain a read/reference compatibility layer: raw native entries are retained, old history IDs and thread/draft targets still resolve, and request fingerprints stay unchanged. Normal publication does not repair or deduplicate messages by text.

Main and thread composers publish only `{ clientId, sequence, active }` to the member-protected composing endpoint. Client events pulse at most every 1.5 seconds; 3.5 seconds without input clears activity, as do blur, send, hidden tabs and unmount. Each server receipt expires after six seconds, and a native expiry task publishes its removal even without further browser traffic. Independent client IDs prevent one composer from clearing another; sequence tombstones reject older delayed signals. Presence has no draft text and is not message history. Listening, Responding and Working derive from the native queue, claim and agent activity.

## Stop and recovery

Stop increments a persisted admission epoch, clears speaking claims and creates a native `dispatch.shared-stop` task. The task aborts and joins admitted delivery tasks, then aborts the agent conversations and their owned gate tasks. It retains committed partial output without waking other agents, excludes superseded drafts, marks the instances stopped and clears the admission fence. Messages and invitations receive a retryable conflict while stopping. A later message can resume participation.

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

`server/mcp.ts` uses stock `@earendil-works/pi-mcp` 1.0.4 with Pi Durable's public
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


## Managed MCP connections

`server/mcp-connections.ts` owns generic remote Streamable HTTP credentials. `server/mcp-oauth.ts` uses the official MCP SDK's discovery, registration, PKCE, authorization-code and refresh primitives. The Pi MCP client continues to own transport and tool invocation. OAuth supports discovered authorization servers and provider-registered clients; bearer tokens, custom authentication headers and unauthenticated servers bypass OAuth. New connections have no Wiki-specific endpoint, scopes or identity lookup.

`connections.sqlite` and `connections.key` live in `DISPATCH_DATA_DIR`. The manager opens and migrates its database only after the runtime owns its exclusive installation lock. Existing Wiki tables become generic connection tables atomically; IDs, encrypted credentials, pending callbacks, ownership and native binding keys survive. `legacy-wiki-connection.ts` retains the prior identity guard for migrated credentials and existing operator manifests. The internal `oauth/<id>` binding and extension names remain stable even for newly supported auth methods.

Tokens, client secrets, header values, authorization URLs and PKCE verifiers are encrypted at rest. Retry fingerprints use a keyed digest, never cleartext credentials. Back up the database and key with authentication and Pi state. These protections do not isolate secrets from coding tools running as the service account. Stored credentials stay outside model context, browser responses and Pi documents; raw OAuth error bodies are not exposed or logged.

OAuth's no-store callback relay removes parameters from the address bar and sends them to an authenticated same-origin completion endpoint, preserving Strict session cookies. Expiring one-use state binds company, owner, session, endpoint, PKCE and expected issuer. A returned issuer is checked, and required when advertised. Reauthorization refuses an issuer change; use a new connection instead. Generic MCP does not establish an account/principal identity, so only provider metadata and known legacy identity are displayed.

`GET /api/connections` returns the caller's records plus company records reserved for a shared definition. Only the owner may authorize/disconnect or initially attach a connection. Native catalog `connectionOwners` permanently reserves its ID for one definition. Teammates can preserve/remove an existing shared binding but cannot appropriate unused credentials. The UI discloses conversation audiences.

Every managed fetch checks authorization state and exact destination, rejects redirects and adds its configured credentials. OAuth renewal is serialized per credential; an interrupted/uncertain exchange requires explicit reauthorization. Insufficient-scope responses never trigger silent expansion. Authorize/disconnect operations are ordered. Disconnect invalidates pending callbacks and disables local requests before revocation, waits for in-flight renewal, and retains encrypted credentials when advertised provider revocation fails. Missing revocation support and static credentials produce an explicit local-removal notice. No tool-call timeout or concurrency cap is added.

`SaveAgentInput.connectionIds` selects managed bindings; omitted values preserve older callers' choices. Public `source: "managed"` replaces `"oauth"`, with both accepted for stored definitions. `capabilities` selects installed coding tools. `applyConnectionsToExisting` updates matching instances' MCP selections in the same native commit as the definition revision. Other instances retain actual bindings. Removal alone does not revoke credentials used by older instances. Actor-bound save request IDs deduplicate revision saves and remain outside public descriptors.

Cached tool schemas install before native recovery, including disconnected connections whose access checks reject use. Discovery reads advertised tools and server metadata without invoking a tool, revises public metadata, and does not interpret catalog completeness as an access grant. Resources and prompts are not added to the agent UI by this package. Each connection's provider authority is shared by its assigned definition's instances. Personal delegation, programmatic principal creation and protected execution isolation remain WP-029 future work.
