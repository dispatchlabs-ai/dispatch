# Durable conversation runtime

The service owns `DispatchRuntime` in `server/runtime.ts` and its collaboration extension in `server/collaboration/shared.ts`. Both use stock `@earendil-works/pi-durable` 1.1.0 public interfaces. Authentication supplies company/user scope; model credentials remain on the service.

## Storage and lifetime

Pi owns storage, tasks, submissions, generations, cancellation and recovery. The session-scoped catalog holds company agent definitions and conversation metadata; the separate session-scoped Projects document owns shared-project policy. Each shared conversation has a `dispatch.shared-conversation` document and an application-defined public log of `dispatch.public-message` entries. Dispatch copies public contributions into this log with their author and thread; it is distinct from each agent’s native working transcript, though both are stored by Pi in the same Session. The public log provides shared history without exposing private working context. There is no separate transcript database or application execution engine.

The service holds an exclusive SQLite transaction on `runtime-owner.sqlite` before opening Pi storage; a competing local-directory owner fails, and the operating system releases the lock after a crash. SQLite remains the default Pi backend (`pi.sqlite`). Local state directories use mode `0700` and SQLite databases `0600`. Frontend hot reload and browser disconnection do not close the runtime.

[Opt-in PostgreSQL development](usage-guide.md#postgresql-development-wp-042) uses the public Pi `Storage` implementation in `server/storage/postgres/`, with shared `dispatch_pi` tables keyed by logical store. The current service still runs one Session/store, including its catalog; it does not yet split conversations into workers. Native execution/recovery remains Pi-owned. Authentication, managed connections, encryption keys, manifests and attachment bytes remain local.

One dedicated non-reconnecting PostgreSQL connection holds the per-store advisory lock. All storage operations, including persistent ID reservations, run through its serialized queue. Each complete commit batch and its sequence update are one transaction; ancestry/document reads use repeatable-read snapshots. Records and opaque identities use JSON-encoded text, not `jsonb`. Unbounded identity text is filtered exactly but excluded from B-tree keys. Close drains admitted operations before closing the connection. An uncertain COMMIT or lost connection makes storage unusable; no implicit reconnect/retry occurs.

The advisory lock is a duplicate-owner guard, not tool-effect fencing. Automatic takeover is unsupported: loss of the connection releases the lock without necessarily stopping an existing shell process or remote request. Stop the old executor and its work before reopening. PostgreSQL conformance, recovery and backup/restore remain unqualified under the current check policy.

Startup installs all extensions, opens Pi storage, seeds missing company definitions, publishes a fresh runtime instance marker, migrates older conversations and calls `Harness.resume()`. Snapshot revisions use Pi’s native commit sequence. `close()` shuts down without converting interrupted work into an explicit user cancellation.

## Agent project-chat reads

**Published; local interactive acceptance passed.** `server/project-chat-context.ts` defines `project_chats` and `project_chat_read`; `server/project-chat-reader.ts` provides the shared public projection. Local mode authorizes and reads on the native commit line. Worker mode resolves the acting instance in its local transaction, releases that transaction, and calls the backend mediation interface. The backend authenticates the worker/attempt, resolves the current project and target through the directory, reads the existing store, then reauthorizes before disclosure. No human browser session or creator identity substitutes for the agent principal.

### Project-chat qualification

Local interactive checks on 2026-10-12 covered feature `e694cc7`, integrated/published in `065df1e`:

- Fresh project chat: discovery and public-history reads without target membership; list/history pagination and message detail also checked by reviewers through native tools.
- Missing, other-project and unbound target IDs: identical `Chat not found.` refusals. Fresh unbound caller: `{ projectId: null, chats: [], nextCursor: null }`.
- Private prepared attachment: explicit `attachmentId` read refused with `Public item not found.`, including for its uploader. Public image attachment: native image output verified separately by Developer.
- Explicit activity discovery/detail: stored-observation marker and private compaction-summary filtering checked through native tools.
- Expanded list/read output at 1440×900 and 390×844: wrapped, scroll-bounded output; document width matched viewport width. A cited `/?chat=<id>` link opened the correct existing chat.

The source chat still had its original participants/messages after the read, with no response in progress when opened. This is not independent monitoring of worker execution, notifications or human read-state changes; those guarantees remain source-reviewed. Distributed PostgreSQL snapshots, stopped/crashed-worker reads and Stop/recovery are not runtime-qualified by these local checks. Scope-change/move and agent-removal races were not exercised; moving chats between projects is not a supported operation. No automated tests were added or run. Developer reported TypeScript/build and Apple Silicon Nix checks passing; this does not qualify other platforms.

### Passive storage snapshot

**Local implementation; runtime qualification pending.** `PostgresStorage.readSnapshot(options, callback)` exposes Pi's existing `Storage` read APIs within one `REPEATABLE READ, READ ONLY` transaction. It validates the existing schema/store, but takes no executor advisory lock, performs no migration or metadata initialization, and starts no Harness or task recovery. `commit()` and `mintId()` reject. All reads must finish within the callback; its connection closes on success or failure. Missing/unsupported storage is an error, not an empty transcript.

This adapter is not authorization or public-content filtering. Callers must resolve the acting instance/current project and target store server-side, release local Pi transactions before cross-store access, and apply the public-history projection. Ordinary storage `open()`, provisioning `ensure()` and activating worker RPC paths are not substitutes for a passive history read. See [agent usage](usage-guide.md#agent-project-chat-context) for the list/read workflow.

## Membership and agent instances

A human creator becomes a member. In unbound chats, authenticated human members may invite active people and available agent definitions from the same company; project-bound human access is managed through project membership. An agent may invite company agents only. Native binding documents derive an agent’s room and author identity; model tool arguments cannot choose another author. Read, command and subscription access require current company and chat authority. Unbound chats use explicit membership; project-bound chats use shared-project policy, including observation-only grants.

[WP-050](handoff.md#wp-050--multiple-agent-instances-and-supplemental-instructions) permits explicit human creation of multiple active instances per definition in a conversation; ordinary invitations still ensure an existing instance rather than creating siblings. Removed instances remain historical. Creation copies its immutable revision, model, instructions, capabilities and thinking level. New coding-capable instances receive the absolute configured workspace directory, shared across participants. `DISPATCH_WORKSPACE_DIR` defaults to the repository root in root launchers and the process launch directory for a standalone service; it can select an existing checkout or Git worktree. Startup validates that the directory exists. An optional project working directory overrides the installation workspace for new instances only; existing paths are preserved. Pi’s `NodeExecutionEnv` and the Coding prompt’s environment-derived cwd use the saved native configuration.

Creation stores an optional name and separate `instanceInstructions`; later base upgrades replace only the base snapshot and recompose the native prompt. Native `configure()` composes the base and supplement at creation without submitting a model request. Actor-scoped receipts return the original participant ID on identical retries, including after removal; changed input conflicts. New creation conflicts during Stop or same-definition cleanup. Ambiguous definition mentions return 409; mention/removal targets remain immutable participant IDs. All active siblings consider later public messages; instructions do not grant isolation or permissions.

Before `Harness.resume()`, a native commit per room migrates idle coding participants whose stored `AgentDoc.cwd` exactly equals the old `<stateDir>/runtime/workspaces/<native agent conversation ID>` default. The commit updates `cwd` and the participant’s displayed path without rewriting instructions, history, other configuration, or files. Any unfinished task in the room defers the room; unfinished tasks or inbox items in the agent conversation defer that agent until a later idle startup. Custom paths are preserved. Changing the installation workspace later does not retarget already configured shared/custom paths. Old numbered folders and their contents remain available at their original paths.

Developer is the company default; startup preserves its saved configuration and archives the retired `default` definition without deleting revisions or changing existing instances. Basic edits preserve capability selections. Archived definitions cannot be newly instantiated or edited; existing instances retain their saved configuration. Developer cannot be archived. Definition edits apply through [safe idle base adoption](#in-place-base-upgrades).

Coding tools have the service account’s filesystem, process and network access. Their directories are not sandboxes. This remains trusted local development on M1 Air; shared deployment and remote isolation are separate work.

## In-place base upgrades

The runtime reconciles saved definition revisions with active member snapshots through `upgradeParticipant()`. Startup reconciles before native resume; commit notifications wake a serialized drain but are not durable truth. A pre-delivery callback reconciles only fresh submissions; recovery joins prior admitted submissions unchanged. Inside the native transaction, `LiveDoc.run`, inbox items and unfinished native tasks defer adoption. For legacy agents sharing the room stream, task scans exclude known delivery/presence/admission orchestration but retain native work and Stop/removal tasks. Native configuration, selected skill snapshots, collaboration hooks and member base revision commit together. IDs, instance names/supplements, histories and existing workspace paths are preserved. Removing/Removed members are excluded.

MCP assignment is separate: explicit human save selections and connection refreshes queue member-owned pending state and use the same idle guard. `boundConnections()` derives displayed assignments from actual binding keys, not definition selections. Base adoption retains current MCP tools/bindings; it does not attach newly selected credentials. Safe error persistence skips unchanged writes; failure does not advance the applied base revision. No new durable execution engine, general pinning feature or grant migration is introduced. Runtime/recovery qualification remains outstanding in [the work package](handoff.md#in-place-agent-upgrades--october-8-2026).

## Public messages and native delivery

A public post and its recipient delivery tasks are committed atomically. Other active agent members receive native `dispatch.shared-delivery` tasks, each waiting for that recipient’s preceding task. The task submits an idempotent native input and waits for its native settlement. Already-considered queued messages coalesce; an existing native receipt is joined before considering a delivery skippable. Pi owns execution and recovery; Dispatch adds no global numeric concurrency cap or in-memory work queue.

**Execution completion is not assignment completion.** The current delivery handler settles the native submission and records `idle` or `silent`; unfinished responsibilities described in conversation prose do not themselves schedule another execution. The generation's `onYield` continuation handles pending contribution review, not an assignment-completion check. Pi resumes admitted native work after interruption, but does not infer a standing work queue from discussion. Thus an idle participant can still own unfinished work; silence is a publication choice, not evidence that its assignment is complete. These boundaries are source-reviewed in `server/collaboration/shared.ts` (delivery settlement, `onYield`, and `append`); automatic assignment continuation remains unimplemented.

The shared system prompt, incoming-message notification and refreshed-history notice point agents to the current saved chat Definition of Done and latest human direction. Blank criteria fall back to the authorized conversation goal. Relevant repository guidance supports delivery and verification without adding chat goals. Agents compare evidence with unmet criteria, continue authorized work within their role, and finish once completion is evidenced and reported; routine updates do not reopen completed work. Criteria do not override ownership, access, Stop or approval boundaries. The saved value is refreshed before each model request, including for agents without criteria-editing permission. This prompt guidance does not add a scheduler or change native settlement; its effect on agent behavior remains unqualified.

Notifications contain attributed public data, incoming thread context and a bounded recent-history excerpt. The agent can read all earlier history with `conversation_history`, including before joining and across native reset/compaction. Pagination and long-message text offsets bound individual model results without deleting history. Images are delivered as native image content rather than base64 inside JSON history text.

The generation’s `onYield` hook is the sole publisher of ordinary successful final answers. Delivery completion records status and never republishes a successful final. Exactly `[[silent]]` without images creates no public message. `conversation_post` permits deliberate public posts to another thread or the main conversation; the agent should then finish silently to avoid another automatic post. Every new public message is considered by other active agent members. Mentions use participant IDs. A reply names a root public message and shares the conversation’s membership; automatic answers inherit the incoming thread.

Browser snapshots expose public messages, participant identity/saved configuration/usage, and author-scoped tool activity. Private delivery input, reasoning and collaboration control tools are excluded. Unadmitted assistant prose, including tool-call commentary and final drafts/partials, stays private. Public progress uses explicit `conversation_post`; only admitted contributions appear as messages. Tool calls/results retain their native representation. Reset/compaction markers expose only safe identity, head and reason metadata, including boundaries before the first human input; private summaries and handoffs remain excluded. Images remain available in the public log. Snapshots are assembled on Pi’s serialized commit boundary and copied before native document drafts expire.

`watchChat()` observes native commit publications across the participating streams and publishes replacement snapshots. Room/member stream changes and session catalog/project-access changes invalidate observations. Bounded caches reuse immutable committed entries and their message/activity grouping projections; live overlays remain fresh. Entry-array identity, detached alias keys and public-message projection identity invalidate affected projections. No transaction drafts enter caches, and delivery still checks authorization. Notifications can coalesce; there is no replay cursor promise. Closing a watcher stops observation only. Session expiry and revocation close protected subscriptions while admitted work continues.

## Native records versus execution traces

Source review against Pi 1.0.4: [`appendAssistant()`](https://github.com/earendil-works/pi/blob/v1.0.4/packages/durable/src/harness/generation.ts#L653-L660) persists the normalized assistant message, including provider-returned thinking, tool calls, usage and optional diagnostic metadata. Dispatch's [PostgreSQL entry writer](../server/storage/postgres/storage.ts) serializes the complete entry. The [public activity projection](../server/collaboration/shared.ts) filters assistant text/thinking and private inputs; absence from the browser is not absence from native storage. Provider-returned thinking is not necessarily full hidden reasoning, and reasoning-token counts do not guarantee readable thinking text. Native records remain private; shared agent definitions do not grant access to them.

Durable state is not a lossless execution trace. The collaboration `beforeRequest` hook appends refreshed history to the outgoing request without appending that update as a transcript entry, so native history alone is not an exact post-hook request record. This integration does not automatically archive raw provider traffic or every stream event; throttled partial commits and bounded event observation do not supply a permanent, lossless stream archive. Tool output can also be truncated. These are code-path boundaries, not verification that every optional field exists in a particular conversation, nor an implemented evaluation-export contract.

## Listening and speaking turns

`server/collaboration/turns.ts` defines the native `dispatch.conversation-turns` document, `dispatch.wait-for-turn` task and `dispatch.composing-expiry` task. The room document records waiting tickets, a speaker and ordered human composing signals. Private work never prequeues a speaking ticket. Only explicit public posts and non-silent final answers acquire one. Mention priority is carried from the triggering/considered messages into admission; otherwise ready contributions queue in acquisition order.

Generation hooks append fresh attributed bounded history before each provider request. Independent work does not wait; an explicitly bound final reviewer first waits for its preserved speaking turn and human-presence pause. The task-scoped `dispatch.listening-request` retains the actual preparation cursor; successful responses advance the member's consideration cursor. Ordinary tool-call prose stays private, while tool activity remains visible. Final publication, freshness checking, receipt creation and claim release share one transaction. Native gate tasks use Pi's cancellable clock and discard claims with aborted/terminal owners or requesters.

Contributions persist their draft, destination, cursor and stable identity before admission. Their conversation-owned background native task owns the reservation across final review; hooks join only its short admission gate. Human presence pauses it without regenerating solely for typing. Only actual intervening messages require a review, and unchanged history publishes immediately. Explicit posts return pending until `afterTools`, never holding a turn while sibling research runs. Proven native final/post-tools successors can review the same contribution; run inputs, originating assistant/results and committed continuation/reset boundaries prevent unrelated generations inheriting the claim. A single publication-only post can revise that same candidate; ordinary or mixed/multiple-tool rounds and retry/backoff release it. Coordination failures cancel the affected native generation rather than allowing publication to bypass admission.

The public log is the publication receipt, using a stable contribution ID across final revisions. A replay-stable generation association and final-generation aliases suppress duplicate publication and preserve activity linkage; historical explicit-post receipts are checked before preparing a new candidate. Existing historical progress/interrupted-output IDs remain readable, but Stop, failure and the legacy reporter no longer publish unadmitted prose. The reporter only drains already admitted work and records status. Old superseded IDs remain compatible stored data but are no longer needed or appended for projection privacy. A one-time contribution-owned migration drops obsolete request/delivery and generation/tool-owned etiquette reservations without cancelling native admitted work; later restarts preserve new claims.


A versioned startup migration handles the historical dual-publisher bug once per existing room. It aliases only final/delivery pairs whose native generation ownership, author, thread and content agree, removes obsolete publication lists, and records completion before native work resumes. New rooms start at the current version. Existing aliases remain a read/reference compatibility layer: raw native entries are retained, old history IDs and thread/draft targets still resolve, and request fingerprints stay unchanged. Normal publication does not repair or deduplicate messages by text.

Main and thread composers publish only `{ clientId, sequence, active }` to the member-protected composing endpoint. Client events pulse at most every 1.5 seconds; 3.5 seconds without input clears activity, as do blur, send, hidden tabs and unmount. Each server receipt expires after six seconds, and a native expiry task publishes its removal even without further browser traffic. Independent client IDs prevent one composer from clearing another; sequence tombstones reject older delayed signals. Presence has no draft text and is not message history. Listening, Responding and Working derive from the native queue, claim and agent activity.

## Stop and recovery

Stop increments a persisted admission epoch, clears speaking claims and creates a native `dispatch.shared-stop` task. The task explicitly closes contribution reservations, aborts and joins background contribution owners alongside admitted delivery tasks, then aborts the agent conversations. Admission gates belong to the same room conversation as their contribution owner. It preserves admitted public messages and committed tool activity, keeps unadmitted prose private, marks the instances stopped and clears the admission fence. Messages and invitations receive a retryable conflict while stopping. A later message can resume participation.

The Stop task and delivery chain recover through Pi. A failed Stop remains fenced and can be retried. Provider failure and cancellation remain distinct participant statuses. Recovery can retry a provider generation from its committed checkpoint, so token-exact continuation and exactly-once billing are not promised. Native coding-tool replay policies likewise do not promise exactly-once shell/file effects.

## Per-agent removal

[WP-049](handoff.md#wp-049--remove-conversation-agents) adds `dispatch.remove-participant`. An authenticated participating human targets an immutable agent participant ID. A native commit marks `membership` removing, closes that participant's contributions/speaking claims, and schedules room-owned cleanup with its delivery/contribution task IDs. Legacy records without membership default to active. Delivery, generation/publication, collaboration-tool and management-principal checks fence inactive members without changing the room Stop epoch.

Cleanup aborts and joins the selected room-owned tasks before aborting the agent conversation, then marks removed and records attributable membership history. Legacy agents use the room's native stream; their abort excludes background room work to avoid cancelling cleanup or other agents' deliveries. Pi resumes persisted cleanup on restart. A live removal retry joins its task; terminal incomplete cleanup exposes `removalError` and a retry creates replacement cleanup while retaining the fence. The HTTP request waits for settlement; failure returns 503, not successful removal.

Historical member records, tool activity and public messages remain. Only active agents receive deliveries or appear in active-work indicators. A human can explicitly invite a fresh current-definition instance after cleanup completes; a new invitation request ID is required, and agents cannot reinvite a removed definition. Definition invitation choices exclude active/removing instances; participant mention choices are active-only. Replaying removal for the historical ID never cancels its replacement. Removal does not release private prepared attachments, publish drafts or undo external effects. Source/build evidence is recorded in WP-049; cancellation, restart and concurrent Stop remain runtime-unqualified.

## Existing conversations

Migration keeps old visible conversation IDs, native entries, saved model/instructions/cwd, project preferences and admitted work. It binds the existing native agent as the first participant, imports attributed human/assistant content and queued human inputs into public entries, and augments its available collaboration tools. An in-flight native reporter waits for the existing work rather than resubmitting it. Missing historical accounts retain a former-member identity without authorizing a different person.

Older request fingerprints and native receipts remain authoritative for retries. A matching fingerprint-only reservation may proceed when no native admission happened. Unverifiable historical requests or changed payloads return a conflict; withdrawn inputs with a native receipt are not admitted again.

## Projects and personal preferences

Shared projects have stable UUIDs, current manager/member policy, default agents and optional host-local working directories in the session-scoped Projects document. Membership grants access to bound chats; operator read-all grants allow observation only. Managers edit project settings through revisioned native commits.

Pin/archive preferences remain personal and grant no access. Legacy personal-group records and original creation fingerprints remain persisted for history/retry compatibility, but listing, creation and move paths no longer expose them. Audience-changing moves are unsupported; no migration silently shares old chats. Creation retries preserve the original request rather than resolving changed project defaults.

## Project instructions

**Backend candidate; UI and runtime qualification incomplete.** The project owns one editable Markdown setting and its instructions revision. Each native agent conversation retains an adopted execution snapshot containing project identity, revision and Markdown; it is not another editable source.

The collaboration extension uses `ProjectInstructionsBindingDoc` and `projectInstructionsSection` from `server/collaboration/project-instructions.ts`. The conversation-scoped binding uses latest state and initial fork behavior, like participant bindings. Pi Durable 1.1.0's native `section("project-instructions", …)` reads only that committed binding. Pi renders the section before the individual instructions and owns effective system-entry history. Base instructions and instance supplements remain separately composed in `AgentDoc.instructions`. Do not inject project text as a public message, rewrite provider requests or manually append system entries. Prompt order is not authorization, and renderer errors must not serve as access gates.

Creation initializes the binding before the first submission. Existing project agents with no adopted revision initialize once at a safe idle boundary, including when the saved revision is 0; absence is not treated as an adopted empty revision. Existing-instance adoption uses the same safe idle guards as base upgrades, but is independent of base-definition eligibility. Project-only edits reconcile even when the definition is unchanged or archived. Adopt the latest revision directly; active/unfinished admitted work retains its snapshot across restart and authenticated worker synchronization. Stop/removal and access checks remain in force. Hosted instruction propagation filters acknowledgement to this project's chats and uses the non-revoking catalog path: a propagation failure is saved-but-pending/error state, not permission to stop or retire an active worker. An adopted empty snapshot removes the section on the next prepared request.

**Qualification:** backend stack `e07ba8c` plus refinements through `dd5497f` has reported TypeScript/build and diff-check passes. Deslop's source review is clear; Pi's revision-0 finding is closed by `ef3a921`. Developer reported integrated candidate `687f445` passing Nix npm check, flake check (one runnable check) and Apple Silicon Nix build. These checks do not qualify runtime behavior or other platforms.

Developer reported manual API acceptance in an isolated native-runtime fixture with synthetic principals and no model submissions: save/read/clear, no-op, original-result replay after newer edits, stale/reused-ID conflicts, member read and save refusal, and oversized-text refusal. Follow-up `86ca61a` fixes JSON-escaped valid 50,000-character request handling; its manual recheck passed. Developer's manual native-runtime fixture at integrated candidate `687f445` also confirmed new/later instances start with the latest saved revision, project-only edits reach idle unchanged-definition instances without messages/submissions, and clearing updates both idle bindings. Archived-definition idle adoption also passed, retaining base revision 1 while adopting project revision 7 without submissions; a pre-feature idle instance explicitly adopted revision 0 without messages or submissions. Pi Expert separately observed next-request removal on this backend using a manually driven isolated native runtime and Pi 1.1.0's faux provider: clearing did not submit work, and the next separately submitted message produced the native system delta `{ "project-instructions": null }`. The effective provider-facing prompt omitted project instructions while retaining collaboration and individual instructions. Historical transcript entries retain the old text. This qualifies local native prompt removal, not remote providers. Active restart retention and hosted propagation remain unqualified, and frontend implementation remains blocked.

The [user guide](usage-guide.md#project-wide-agent-instructions) explains saved versus adopted revisions and interruption limits. Runtime evidence must cover idle project-only adoption, active/restart snapshot retention, hosted synchronization, later invitees and clearing; source/build checks alone do not qualify those behaviors.

## Request identity

Public posts and invitations retain author-scoped request fingerprints in the native shared document. Matching retries reuse their original result; changed text, thread, mentions or invitation set returns `409`. Public append and native task creation share the same transaction. Native delivery request IDs derive from stable task IDs, so restarting an invocation reuses native admission. Agent tool request IDs derive from native task/call IDs.

Source/build evidence, explicitly scoped runtime observations and remaining qualification gaps belong in the [handoff](handoff.md); older [WP-024](handoff.md#wp-024--shared-conversations) evidence does not qualify later changes. Follow the canonical [testing policy](../../../CONTRIBUTING.md#testing-policy) before verification.

## Per-agent MCP connections

`server/mcp.ts` uses stock `@earendil-works/pi-mcp` 1.1.0 with Pi Durable's public
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
instances receive catalog changes at an eligible idle boundary; removal from the manifest queues binding
and MCP selection refresh on startup. This preserves other tools, instructions, model,
reasoning, working directories and native history. The applied base revision follows safe idle upgrades; actual connection
assignments remain separate from that label. Basic definition edits preserve connections.

Every remote call uses Pi's native tool task, propagates its cancellation signal,
and returns MCP text/images, error state and JSON details. All calls are declared
`replay: "unsafe"`: recovery reports interruption instead of repeating a possibly
committed external write. Inspect the provider's outcome and retry contract before
retrying. One adapter is shared per configured agent/connection; its identity
is not a per-human or per-Pi-conversation audit identity.

The service closes adapters after Pi stops its work. Adapter credentials and
renewal follow the configured provider's contract.


## Managed MCP connections

`server/mcp-connections.ts` owns generic remote Streamable HTTP credentials. `server/mcp-oauth.ts` uses the official MCP SDK's discovery, registration, PKCE, authorization-code and refresh primitives. The Pi MCP client continues to own transport and tool invocation. OAuth supports discovered authorization servers and provider-registered clients; bearer tokens, custom authentication headers and unauthenticated servers bypass OAuth. New connections have no provider-specific endpoint, scopes or identity lookup.

`connections.sqlite` and `connections.key` live in `DISPATCH_DATA_DIR`. The manager opens and migrates its database only after the runtime owns its exclusive installation lock. Existing generic connection records and operator manifests remain supported. The internal `oauth/<id>` binding and extension names remain stable even for newly supported auth methods.

Tokens, client secrets, header values, authorization URLs and PKCE verifiers are encrypted at rest. Retry fingerprints use a keyed digest, never cleartext credentials. Back up the database and key with authentication and Pi state. These protections do not isolate secrets from coding tools running as the service account. Stored credentials stay outside model context, browser responses and Pi documents; raw OAuth error bodies are not exposed or logged.

OAuth's no-store callback relay removes parameters from the address bar and sends them to an authenticated same-origin completion endpoint, preserving Strict session cookies. Expiring one-use state binds company, owner, session, endpoint, PKCE and expected issuer. A returned issuer is checked, and required when advertised. Reauthorization refuses an issuer change; use a new connection instead. Generic MCP does not establish an account/principal identity, so only provider metadata and known legacy identity are displayed.

`GET /api/connections` returns the caller's records plus company records reserved for a shared definition. Only the owner may authorize/disconnect or initially attach a connection. Native catalog `connectionOwners` permanently reserves its ID for one definition. Teammates can preserve/remove an existing shared binding but cannot appropriate unused credentials. The UI discloses conversation audiences.

Every managed fetch checks authorization state and exact destination, rejects redirects and adds its configured credentials. OAuth renewal is serialized per credential; an interrupted/uncertain exchange requires explicit reauthorization. Insufficient-scope responses never trigger silent expansion. Authorize/disconnect operations are ordered. Disconnect invalidates pending callbacks and disables local requests before revocation, waits for in-flight renewal, and retains encrypted credentials when advertised provider revocation fails. Missing revocation support and static credentials produce an explicit local-removal notice. No tool-call timeout or concurrency cap is added.

`SaveAgentInput.connectionIds` selects managed bindings; omitted values preserve older callers' choices. Public `source: "managed"` replaces `"oauth"`, with both accepted for stored definitions. `capabilities` selects installed coding tools. `applyConnectionsToExisting` queues matching active instances' MCP selections with the definition save; each applies through the native idle guard. Other instances retain actual bindings. Removal alone does not revoke credentials used by older instances. Actor-bound save request IDs deduplicate revision saves and remain outside public descriptors.

Cached tool schemas install before native recovery, including disconnected connections whose access checks reject use. Discovery reads advertised tools and server metadata without invoking a tool, revises public metadata, and does not interpret catalog completeness as an access grant. Resources and prompts are not added to the agent UI by this package. Each connection's provider authority is shared by its assigned definition's instances. Personal delegation, programmatic principal creation and protected execution isolation remain WP-029 future work.
