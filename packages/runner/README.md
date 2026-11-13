# Dispatch Runner

Define an agent in one Markdown file, start one host, and connect clients to its
saved conversations. Pi Durable owns execution, recovery and storage.

## Install and start

Use **Node 24.22.1 or newer**, with npm. Nix and a Dispatch
source checkout are optional. In a new application directory:

```sh
npm init -y --init-type=module
npm install https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.17.3/dispatch-runner-0.17.3.tgz
```

An existing npm application only needs the install command. Creating a local
`package.json` first prevents npm from installing into a parent project.

npm records Runner as `@dispatch/runner` in `package.json` and `package-lock.json`.
Keep both files. This installs a versioned GitHub package archive; no npm account
is needed. The packages are not published to the npm registry.

Create **`agent.md`**:

```markdown
---
description: A helpful assistant
model: { provider: anthropic, id: claude-sonnet-4-6 }
---
Answer clearly. Ask when you need more information.
```

With `ANTHROPIC_API_KEY` set in your shell, start the host:

```sh
npx dispatch serve
```

The host reads your definition and selects its built-in Pi provider. It saves
conversations in `.state/`; add that directory to `.gitignore`. Provider keys
stay in the host's environment. No host JSON, application code or generated
agent files are required. The root definition has the stable agent ID `agent`.

In a second terminal in the same directory:

```sh
npx dispatch chat
```

The terminal connects to the running host and returns to the `main` conversation.
Use `/new` for a new conversation, `/history` to read messages, `/stop` to cancel a
turn and `/quit` to disconnect. `--session NAME` selects another conversation.
Stopping the host with Ctrl-C preserves its history and unfinished work; start it
with the same command to recover. Clients never start replacement owners.

### Interactive terminal UI

The intro shows `/agents` (Ctrl+G), `/chats` (Ctrl+P) and `/help`.
Provider-supplied thinking summaries appear live and in saved history under
**Thinking**. A response without a provider summary has no thinking section.
Tool headings show actual calls; Ctrl+O expands their inputs and results.

Dispatch 0.16.0 uses Pi's terminal UI for interactive `dispatch chat` and
`dispatch-agent run`, including applications that expose either as `npm run chat`.

Retained history appears immediately above a multiline composer. Replies render
as streaming Markdown; tool activity shows native status, inputs, progress and
results. Use `/chats` or Ctrl+P for saved conversations and `/agents` or Ctrl+G for
agents. Pickers search titles, IDs and descriptions; switching preserves each
conversation's draft, scroll position and expanded tools.

Enter sends. Alt+Enter or Ctrl+J inserts a newline; Up/Down recalls input history.
PgUp/PgDn scroll, Ctrl+Home/End jump to the beginning/latest, and Ctrl+O toggles
tool details. `/help` or F1 lists commands and shortcuts. Ctrl+C clears the draft, then
exits when empty; Ctrl+D exits from an empty composer. Escape closes a menu.
Only `/stop` cancels host work.

`/history` refreshes and scrolls to the beginning. After a disconnect, `/reconnect`
observes the same host without resending input. `/retry` explicitly retries an
uncertain send with its original payload and request ID. Unresolved identities
and payloads print on exit so they remain available for deliberate recovery.
`--prompt`, `--history`, file submissions, redirected streams and `TERM=dumb`
keep the plain interface. See the [client guide](docs/service.md#interactive-terminal-ui).

## Try it without credentials

Use the same `agent.md` with an explicitly synthetic host:

```sh
npx dispatch serve --demo --state .demo
```

In another terminal:

```sh
npx dispatch chat --state .demo --prompt "Hello"
npx dispatch chat --state .demo --history
```

The response begins **Demo reply:** and repeats your message. It uses native
durable storage and no model account. Keep `.demo/` out of Git. Stop the host with
Ctrl-C; restart it to reopen the same history. Demo and live stores stay separate.
See the [first-conversation walkthrough](../../docs/quickstart.md).

## Application code and configuration

`--root DIRECTORY`, `--state DIRECTORY` and `--socket PATH` select explicit local
paths. The default socket is a stable, account-private temporary path derived
from the application state path, so deeply nested checkouts work too. The host
prints its socket for other clients. `dispatch catalog` reads definitions without
opening stores. For custom model providers, MCP servers, HTTPS, channel extensions
or host policy, use `dispatch serve --config HOST.json` and the
[host configuration guide](docs/service.md).

The library remains directly usable from application code:

```js
import { run } from "@dispatch/runner";
const host = await run({ models }); // Your configured Pi Models catalog.
// Use host.client, or expose it to your chosen clients.
// Close the host when your application shuts down.
await host.close();
```

## Definitions and optional capabilities

Your repository owns instructions, model selection, tools, skills and application
code. Select MCP connections in Markdown; add `agent.ts` beside it for custom
application code or other optional capabilities.
For several agents, use `agents/NAME/agent.md` and optional `agent.ts` beside each.
A root `agent.md` can coexist with named agents, but not with `agents/agent/agent.md`.

```ts
import { defineAgent } from "@dispatch/runner";
import { CodingTools } from "@earendil-works/pi-durable/tools";
export default defineAgent({ extensions: [CodingTools] });
```

`CodingTools` supplies Pi Durable's stock `read`, `write`, `edit` and `bash` tools.
Declare `@earendil-works/pi-durable` at the same version as Runner (currently
1.5.2) in the application that imports it. The host supplies their execution
environment; the CLI defaults its working directory to the application root.
`skills: true` enables repository skills. The separate `coding: true` adapter
adds repository selection and a restricted private checkout; it is not required
for the stock tools.

`defineAgent({})` is conversational by default. Tools are explicit grants;
trusted extensions can supply native Pi tools, documents and tasks. Markdown
requires a description, model provider/id and instructions. `model.thinking`
defaults to `off`; supported values are `off`, `minimal`, `low`, `medium`, `high`,
`xhigh` and `max`, subject to the model's capabilities.

Scheduling is optional. A non-manual `trigger` requires `input`. An optional
`factory.yaml` enables scheduled agents and may select `defaultAgent`; without it
all definitions are available for chat and no schedules start. A single agent is
automatically the default. See [schedules](docs/schedules.md).

## MCP connections

Add `mcp: [wiki]` to an agent's Markdown frontmatter and configure `wiki` under
the host's `mcpServers`. Dispatch discovers the server's tool descriptions and
schemas using Pi MCP and registers them with Pi Durable. No agent TypeScript or
server-specific tool adapter is needed.

Connections support stdio commands and Streamable HTTP URLs with configured
headers. The host owns credentials and connection lifetime; CLI, web and channel
clients use the same tools. An optional `tools` list selects exact server tool
names. See [MCP setup, lifecycle and current boundaries](docs/mcp.md), including
authentication prerequisites and the distinction between tools and other MCP
features.

## One host, one client contract

`run({root, stateRoot, models})` explicitly starts the owner and returns
`{service, client, close}`. `client` is an embedded `AgentClient`; it has the same
operations as clients connected over a Unix socket or authenticated HTTPS.
`service` exposes host-only extension and native-storage hooks. Ordinary clients
need only `@dispatch/runner/client` and never open a database or configure tools.

```js
import { connectClient } from "@dispatch/runner/client";
const client = await connectClient({ socket: "/srv/example/run/agent.sock" });
const agents = await client.agents();
const chat = await client.create(agents[0].id, "my-client", "stable-thread-key");
const watch = await client.watch(chat.id, snapshot => console.log(snapshot));
// Send with a stable request ID; keep it if a response is lost.
await client.submit(chat.id, "Hello", "request-1");
await watch.stop();
await client.close();
```

Closing a client disconnects observation. Only `client.stop(id)` cancels work.
Closing the host suspends unfinished native work for recovery on restart.
Start a supervised host with `dispatch-service HOST.json serve`, then connect:

```sh
dispatch-agent --socket /srv/example/run/agent.sock run --agent helper --session main
dispatch-agent --socket /srv/example/run/agent.sock run --session main --history
```

The client commands never start or replace a host. Web uses the same client through Backend.
Watch streams are driven by native changes; clients do not poll full histories.
See [host and client setup](docs/service.md) for configuration, HTTPS, receipts,
errors, streaming and explicit ownership.

Slack, Google Chat and email are optional packages. Their durable delivery tasks
run as host extensions so input admission and delivery receipts can share native
transactions. They use the host's shared input validation and conversation
operations. A new ordinary client does not need tasks or a native harness.
Transport names are open strings. Account routing remains each connector's job.

## Build, upgrade and deploy

Install only the packages your application uses. Channel adapters are prepared
alongside Runner by `npm run pack:packages`; install matching archives together.
Remote storage, PostgreSQL, Fleet and the browser application are optional.
Bump the Dispatch dependency, update the application lockfile, build/check your
application, stop its host, and restart with the new package. Existing clients
reconnect to the same owner identity and conversations. There is no machine-wide
version selector, detached-owner takeover, scaffold merge or migration command.

Keep one Pi dependency tree per application. Runtime upgrades do not rewrite
agent files. Changes to authored definitions remain explicit host configuration
(`updateDefinitions` while idle, or `"when-idle"` to defer while work recovers).
See [ordinary upgrades](docs/upgrade.md) and the optional
[Nix application builder](docs/nix-releases.md).

## Host extensions and inspection

`run({adapters})` prepares native channel extensions before recovering work.
For domain workflows, `open` may return `runner.ChatService.attach(...)` with
existing hosts; this transfers their lifetime to `run`. `initialize(tx,chat,host)`
binds application documents in the chat-creation transaction. Never open another
writer to a store already owned by a host.

A `storage(agent)` factory supplies optional Pi Storage implementations; local
SQLite is the default. [Remote](../remote/README.md), [Postgres](../postgres/README.md)
and [Fleet](../fleet/README.md) are explicit deployments of that ownership model.

`dispatch-watch --config HOST.json --session .` inspects saved native work without
starting it. The shared `@dispatch/runner/records` reader handles read-only SQLite
snapshots and document revisions for Runner, Observer and Eval. See
[watch](docs/watch.md), [artifacts](docs/artifacts.md),
[workflow progress](docs/workflow-progress.md), [request completion](docs/request-completion.md),
[use cases](USE_CASES.md) and [changes](CHANGELOG.md).

## Local provider credentials

`UserCredentials.open({ root, providers })` supplies optional host-owned API-key
sources for Pi models: native OS storage, an existing vault helper, session-only
input and explicit environment compatibility. `credentialCommand` supplies setup,
metadata-only status, resolution checking and removal. No plaintext fallback or
automatic `.env` loading is provided. See [credential handling](docs/credentials.md)
for configuration, public methods, failure recovery and trust boundaries.

## Company and agent skills

Set `skills: true` in `defineAgent` to enable a read-only skill catalog. Existing
definitions are unchanged unless they opt in. The loader discovers
`skills/<name>/SKILL.md` and `agents/<agent>/skills/<name>/SKILL.md`. Each skill
requires YAML `name` (matching its folder), `description` and a nonempty body.
Company and local IDs are distinct: `company/<name>` and `agent/<name>`.

Only names and descriptions enter the initial instructions. `read_skill({ id,
path? })` returns `SKILL.md` by default, its content revision and the available
resource paths. Supporting UTF-8 text is read through the same tool. Resources
are startup snapshots; symlinks, special files and non-UTF-8 content are rejected.
The reader grants no shell execution or arbitrary filesystem access. Skills are
trusted author guidance and do not add permissions.

All skill files contribute to the owning definition fingerprint; changed skills
require the same explicit idle-state update as changed instructions. Saved tool
results retain the exact read content and revision. `loadSkills(root, agent)` and
`LoadedAgent.skillCatalog` expose this catalog to host applications. Skill
contents are loaded into process memory at startup and disclosed to the model
on demand, rather than hot-reloaded under a saved definition.

## Repository instructions and delegation

`loadAgent` supplies every role with its own `agent.md` body and the applicable
root-to-agent-directory `AGENTS.md` chain. Those source revisions contribute to
the definition fingerprint, including delegated roles. Without Git, the company
root is the boundary. Missing instruction files are allowed.
Company source paths are relative to that root, so relocating unchanged
definitions does not change their fingerprint. Target-checkout paths stay
absolute. Stores using the earlier absolute company paths require one explicit
idle definition update.
Shared agent-behavior rules follow the agent across assignments; contributor
commands and paths stay scoped to their source repository. Role bodies are
explicitly labeled with their `agents/<name>/agent.md` source.

Pass `cwd` to `run`, `ChatService.open` or `openAgent` to select a trusted local
checkout. Every generation also loads that checkout's root-to-working-directory
`AGENTS.md` chain, including child conversations. Nested instructions outside that
chain must be read before entering their scope. Target guidance refreshes before
each model request; company/role guidance follows definition update rules.
The working directory is saved and must match when reopening the store.

An agent can declare `delegates: ["worker"]` to expose `list_agents` and `delegate`. Each
call creates a child conversation owned by a native background worker, using the
named agent's own instructions, model and tools. Parallel calls can run concurrently.
The call waits for a result or new coordinator input. New input releases the wait
without stopping the child; `steer_child`, `cancel_child` and `wait_for_child`
control that coordinator's children. Resume waiting after handling a follow-up
until every assignment is collected or cancelled; there is no automatic result
notification. Stable native identities preserve the worker, child and retained
result across restart. Older persisted calls retain their original foreground
ownership and blocking wait. Assign bounded work and disjoint files when
several children edit one checkout. There is no separate orchestrator or automatic
acceptance gate.

`list_agents({})` reads the configured roster and current host model catalog
without inference or credential probing. It returns descriptions, exact model
and thinking selections, declared tools, context/modalities and catalog rates
in USD per million tokens, including any price tiers. It also shows the
coordinator's model rates so the agent can account for its own work. Registration
does not prove live access; catalog prices can be stale or zero placeholders and
are not a statement of subscription billing. Declared tools remain subject to
inherited native filters and host authorization.

`delegate({ agent: "worker", task: "...", reason: "..." })` accepts an optional
short selection rationale. Named and cloned children return a recorded receipt
alongside their answer, or with a terminal unsuccessful result. Receipts contain
native identities, elapsed wall time (including waits/recovery), recorded token
counts and estimated cost from the child's native usage ledger and owned
descendants as of collection. Failed/retried model attempts recorded by Pi are
included; future background work and coordinator inference are not. The receipt
is model-visible and retained in tool details; it is deliberately not returned
as tool usage, which would double-count the existing native ledger. Aborting the
parent can prevent a tool receipt; the native usage records remain authoritative.

The catalog summarizes retained receipts for the exact worker definition in the
calling conversation, including earlier transcript entries after compaction.
Sample counts, returned answers, estimated spend and elapsed time are observations
across those assignments, not correctness scores or comparable-task benchmarks.
There is no global performance database or automatic quality grader. Company
instructions own task-fit guidance, escalation and the cost/latency tradeoff.

Declare `clones: true` to expose `clone_agent` for fresh, owned children with the
calling conversation's native configuration, including its tool filters. This
differs from named delegation and independent sibling messages. The
[parallel-child contract](docs/parallel-children.md) covers inherited rights,
history isolation, concurrent assignments, results, cancellation and recovery.

Agents must explicitly grant file/shell tools, for example `CodingTools` from
`@earendil-works/pi-durable/tools`. With `cwd`, those tools use the local account's
access. This is a working-directory choice, not a filesystem sandbox; the existing
`coding: true` adapter retains its own environment and restrictions.

## Persistence and boundaries

`createRunner({ namespace })` derives native document/task identities. Keep the
namespace stable for existing stores. Definition fingerprints hash the original
Markdown, TypeScript, opted-in skill resources and delegated definition bytes. An idle
`updateDefinitions` migration updates ownerless conversations and their private
handoff children; applications with pinned domain configurations use the
`updateConversation(tx, id, setup)` callback to preserve or migrate their profiles before changing those definitions. Imported tool
code is not transitively hashed.

Runner source builds now pin Pi 1.5.2, including the terminal UI dependency.
Remote, Observer, Web and the transport adapters also pin 1.5.2. Custom storage providers
must implement Pi 1.5 grouped commits before use
with this runner. Pi 1.5 writes newer native live-document and task versions that
Pi 1.4 cannot resume. Before upgrading, stop the owner and back up
its complete state directory. Opening SQLite automatically migrates it to schema
version 2; Pi 1.3.0 (including alpha.4) cannot reopen that migrated store. Use a
separate state directory to try the upgrade. To roll back, restore the closed
pre-upgrade backup, not the migrated database. No existing deployment is upgraded
by publishing this source change.

Runner documents keep their existing scopes, versions and delta-only policy
(`checkpointWhen: () => false`). Schedule and progress-monitor checkpoints keep
their shapes; future deadlines now use native durable sleeps, holding no running
invocation while waiting. The Harness owns wake-up and recovery.

Closing suspends unfinished native work; reopening with compatible definitions
and adapters resumes it. State directories hold private transcripts and tools'
results. Back up the complete store; do not copy a live SQLite file in isolation.
On POSIX systems, startup sets the state root and each agent directory to `0700`,
and the database, existing SQLite sidecars and status files to `0600` before
opening storage. SQLite creates new sidecars inside the private agent directory.
Existing history is retained. State paths must be owned by the launching account;
symlinked state directories/files, hard-linked files and special files are
rejected. Startup stops if private modes cannot be established. Keep ancestor
directories under trusted control and review any extra filesystem ACLs separately.
On Windows, startup automatically establishes and verifies a protected DACL
granting the current user full control, with private inheritance for newly
created files. Windows PowerShell supplies the built-in API bridge; no elevated
launch or extra SDK is needed. State must live on a local ACL-capable Windows
volume, normally NTFS. Junctions/reparse points, hard links, foreign ownership
and ambiguous trailing-dot/space components are rejected. These permissions do
not isolate trusted code running as the same account, privileged administrators
or earlier backups. See [Windows storage](docs/windows.md) for implementation
boundaries and qualification.

A directory lock enforces Pi SQLite's single-owner contract without limiting
independent native tasks. Status JSON is an observation, not durable authority.

Optional handoffs create a private child per parent conversation and publish
results/progress through a supplied reply sink. Progress distinguishes queued
requests from those placed in the child conversation; placement alone does not
verify that a requested change was applied. Cancellation suppresses progress
while native owned work drains; a cancelled request is not a claim that every
background job has stopped. The inherited local coding
adapter uses private Git worktrees, protects `USE_CASES.md` and the definition
repository, and supports shell execution only through macOS `sandbox-exec`.
It is not a portable sandbox or a multi-tenant security boundary. Domain-specific
read-only tools can run on Linux without the coding adapter.

## Installed service

Use [`dispatch-service`](docs/service.md) when a supervised local process should
load an independent definition repository and serve clients through one native
owner. The definition repository does not install the service.

Opt into [instance messages](docs/instance-messages.md) for reusable handoffs
between independent agents, without private child ownership or a notes store.

## Owned processes (POSIX)

`ProcessScope` forks a trusted Node entry point into its own process group;
`serveProcess` handles concurrent IPC requests so observations do not serialize
steering or Stop. Normal descendants inherit that group. `close("cancel")` sends
cooperative cancellation, then kills the group after one second. `close()`
suspends retained native work instead. The child also enforces termination when
its owner disconnects. Deliberately detached processes and remote effects need
the host's separate ownership/cancellation integration.

Before recovering a cancelled store, open it with `resume: false` and call
`cancelService`. It marks all tasks before enabling native abort cleanup; pending
tools must not replay merely to be cancelled. Persist the cancellation decision
outside the worker before terminating it, and finish cleanup before accepting new
input. It also reconciles unfinished [request records](docs/request-completion.md)
in the native store without model calls. This does not undo external effects.
`ThreadProcesses` performs this cancellation-only reopen before confirming Stop,
including when the previous worker already exited. Its executor must publish
`ready` only after `cancelPending` cleanup finishes; no input is sent during that
reopen. Recovery retains the cancellation flag until native and presentation
cleanup both succeed, and passes the retained Stop input to presentation cleanup
so its acknowledgement keeps the same identity.

### Conversation defaults and protected execution

Set `defaultAgent: jett` in the definition tree's `factory.yaml` to select the
agent for new `dispatch-agent run` sessions. `--agent` overrides that selection.
The owner retains the conversation and its agent under the terminal session key;
changing the default does not relabel it. This setting does not enable calendars.

`ChatService.open({ prepareAgent })` applies the trusted binding recursively to
primary definitions, named delegates and legacy handoff children. Hosts can
filter unavailable optional delegates before binding. `WorkspaceEnvironment`
accepts a `WorkspaceTransport` for a host-authenticated broker, with no local
filesystem or shell fallback. The host supplies it as an `env` factory.

`projectChatMessages(namespace, entries)` is the public native transcript projection
used by live ChatService and read-only backend consumers. It retains errors, public
commentary, timestamps and artifacts without exposing reasoning/provider diagnostics.

## Read-only retained navigation

The supported `@dispatch/runner/watch-reader` API accepts
`discoverWatchRuns({stateRoot, saved: true})` to include retained sessions with one
process census for the root. Default terminal watch discovery stays running-only.
`readWatchStates(run)` returns native task/submission status per conversation without transcript projection.
`readWatchCatalog(run)` returns lightweight identity/title/parent/date metadata,
not an execution-status claim. `readWatchRun(run, conversationKey)` reads activity
for one selected conversation; omitting the key preserves the full-run API.
`readWatchConversation` still pages complete authoritative history. These reads
never migrate stores, open providers or resume native work. Committed WAL remains
visible. Optional malformed chat-index metadata does not suppress readable child
history; schema, I/O and actual identity failures are reported.

## Chat content and tool projections

`ChatService.submit(id,text,requestId,mode,source,attachments?)` admits optional
`AttachmentFile {name,mimeType,data:base64}` bytes as native Pi input blocks and
retains their source metadata in the same input entry. `prepareContent` validates
UTF-8 documents and PNG/JPEG/WebP; `ContentError.status=409` is a definite rejection
of that attempt. Images require the authored model's native `input` capability.
Hosts using `ChatService.attach` pass its optional `models` catalog to enable
image-capability admission; absence is not permission to silently drop images.
Names never authorize a host path; PDF/Office/binary documents are unsupported.
No application count/size cap. Native/provider context limits still apply.

`projectChatMessages` preserves selected file metadata/download bytes and tool-only
assistant anchors. `projectChatTools(entries,live?,tasks?)` joins actual native
call/result IDs, diagnostics and task state; unknown payloads remain unavailable,
not fabricated success. Native parentCallId/taskId are reported only when present.
`ChatSnapshot.toolCalls` is additive; terminal/channel clients that only render
text remain compatible. `watch-reader.readWatchChatProjection(run,key)` supplies
the same retained projection without opening an owner/provider or resuming work.

Generic chat input/projection patterns retain the [Agent Chat MIT notice](AGENT-CHAT-LICENSE).
