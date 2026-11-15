# How Dispatch works

Dispatch turns application-owned definitions into agents running on Pi Durable.
One explicit host owns their saved work; terminal, browser and messaging clients
connect to that host. This reference describes the local host architecture in
Dispatch 0.20.0 with Pi Durable 1.5.2. Package guides linked below own the detailed
contracts; the [verification record](qualification.md) records observed coverage.

## Responsibilities

| Layer | Owns |
| --- | --- |
| [Pi Durable](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md) | Conversations, atomic storage commits, model/tool execution, durable tasks, submissions and recovery |
| Dispatch | Definition loading, store ownership, the shared client contract, MCP integration, agent messaging, schedules, channel adapters and optional execution environments |
| Your agents application | Roles, model choices, skills, domain code, environment recipes and host configuration |

These are ownership boundaries. Applications can use Pi's public extensions
directly: an `agent.ts` commonly imports `CodingTools` from Pi Durable. An
application can also contain domain-specific scripts. Shared runtime, connection
and lifecycle machinery belongs in Dispatch or its upstream owner.

## Pi's building blocks

A `Harness` runs conversations against a store. A store can contain many
conversations, including separate instances of the same agent.

| Term | Meaning |
| --- | --- |
| Conversation | A transcript with associated state and work |
| Entry | An immutable transcript record, such as user input, an assistant response or a tool result |
| Document | Typed JSON state committed alongside entries; Pi uses documents for agent configuration, live work, queued input and usage |
| Task | A durable state machine that checkpoints between phases; `pi.generation` runs model requests and `pi.tool` runs tool calls |
| Submission | An admitted input with its own completion state; a stable `requestId` deduplicates retried admission |
| Extension | A named bundle of tools, prompt sections, hooks or task definitions; the host supplies its implementation in memory |

Dispatch builds on these primitives. Its chat index is a document; agent-message,
schedule and channel-delivery operations are tasks. The local host needs no
separate message broker or second workflow database. Stored extension names do
not contain executable code: recovery needs compatible implementations loaded
in the host.

## From application files to an agent

A conversational agent needs an `agent.md`. A multi-agent application commonly
has this shape:

```text
my-agents/
  package.json                     Dispatch dependencies and application commands
  host.json                        Shared providers, MCP connections and adapters
  AGENTS.md                        Shared agent guidance
  agents/researcher/agent.md        Role, description and model
  agents/researcher/agent.ts        Optional tools and capabilities
  agents/developer/agent.md
  skills/                          Optional shared skills
```

Runner combines the role with applicable `AGENTS.md` guidance and optional
TypeScript capabilities, then configures a native Pi agent. MCP connections are
selected by name from the host configuration. Opting into `skills: true` exposes
a catalog of shared `skills/<name>/SKILL.md` and agent-local
`agents/<agent>/skills/<name>/SKILL.md`; `read_skill` retrieves their contents on
demand. Skills supply instructions and resources, not tool permissions.

A definition fingerprint detects authored changes. Updating a retained agent is
an explicit startup policy. `updateDefinitions: "when-idle"` skips a changed
definition if work is pending; it applies on a later startup that finds the
store idle. It is not a background file watcher. Working-directory guidance has
a separate per-request refresh path. See [instructions](../packages/runner/docs/instructions.md)
and [editing agents](../packages/runner/docs/create-agents.md#edit-or-add-an-agent).

## One host, shared clients

```text
Terminal ──────────────────────┐
Browser ── Dispatch Web ───────┤
MCP client ── Dispatch MCP ────┤  AgentClient commands and watch snapshots
                              ▼
                    dispatch serve
                    ├─ ChatService
                    ├─ researcher → Harness → .state/researcher/session.sqlite
                    ├─ developer  → Harness → .state/developer/session.sqlite
                    ├─ configured providers and MCP connections
                    └─ optional channel adapters (Slack, Google Chat, email)
```

The default local host opens one SQLite store and Harness per agent. An ownership
lock prevents a second writer. Many conversations share each agent's store;
clients use identities such as `researcher:<conversation-id>` instead of opening
the database. Artifact files and environment state can live outside SQLite.

Before resuming saved work, the host loads definitions, connects model providers
and MCP servers, registers extensions, opens stores and starts configured adapters.
The service binds its listener early so a configured Dispatch MCP child can
discover tools without a startup cycle; clients still wait for host readiness.

Embedded clients, Unix-socket clients and authenticated HTTPS clients share
`AgentClient`. The local service exposes `POST /v1/commands` and
`POST /v1/watch`; Web adapts these operations to browser HTTP routes and SSE.
Watch projects native changes into snapshots. Channel adapters also own durable
input/output tasks inside the host. See the [service guide](../packages/runner/docs/service.md)
and [interface inventory](interfaces.md).

Disconnecting a client stops observation. Stopping a conversation aborts its
owned work. Closing the host suspends unfinished work for recovery when it
reopens with compatible definitions and extensions.

## One request

1. The client creates or reuses a chat with a stable creation key. Runner records
   its conversation identity in the agent's native chat-index document.
2. The client submits input with a stable request ID. For an idle conversation,
   Pi admits the input, submission and generation work in a native commit.
3. `pi.generation` prepares a model request and streams its response. Tool calls
   become `pi.tool` tasks; their results return to the conversation for the next
   generation.
4. Pi settles the submission when its response is complete. Runner's watch
   projection supplies clients with the saved transcript and current work state.

Human input through ordinary chat clients steers an active run after its current
tool round. Agent messages normally use follow-up admission. Submission
completion describes that input's response, not proof that a larger assignment
or all independent work has finished.

Recovery resumes durable tasks at their saved phase rather than replaying an
event log. Important limits in Pi Durable 1.5.2 are:

- A model request cut off by a crash counts as a failed attempt and can be
  retried. Partial output is retained only to the extent that it was persisted.
- An interrupted tool execution reruns automatically only when its tool declares
  `replay: "safe"`. Otherwise the model receives an interrupted result. The stock
  coding tools do not declare safe replay; the model can still choose to call
  them again.
- Provider text can be visible before durable persistence. Pi batches response
  persistence with a default interval of about one second; tool output can also
  use deferred persistence. A crash can lose that latest unflushed output.
- Request IDs deduplicate native admission. They do not make external tool side
  effects exactly-once or undo effects when a conversation is stopped.

The [pinned Pi Durable reference](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md)
owns the precise commit, retry, tool-replay and shutdown guarantees.

## Agent messages and automatic replies

Independent agents keep separate conversations, tools and stores. A researcher
can ask a developer for help without acquiring the developer's tools:

1. The sender calls `message_agent` with a recipient, assignment and `reply: true`.
   Runner checks its permitted recipients and resolves a recipient conversation.
2. Runner records a `dispatch.instance-message` task in the sender's store. The
   send returns an admission receipt; the sender need not keep a model turn open.
3. The task's delivery phase submits the assignment to the recipient with a
   stable request ID and records the recipient submission identity.
4. Its answer phase waits for that submission, then submits the answer as a new
   input to the sender. This can wake a sender that has already finished its turn.

The automatic reply follows the addressed submission's answer. If that answer is
"I am waiting for research," later work is not automatically included in the
same reply. Follow-up messages and explicit work observation have their own
identities. No transaction spans the two agent stores; fixed request IDs make
retried delivery and reply admission safe.

Native messaging tools and the Dispatch MCP tools use the same delivery
machinery. Runner binds MCP calls to the actual calling conversation. Their
outer tool recovery differs: native messaging tools declare safe replay, while
generic MCP calls do not. Once admitted, the durable delivery task still has
its own recovery. Stopping the sender does not cancel independent recipient
work. See [instance messaging](../packages/runner/docs/instance-messages.md) and
[MCP messaging](../packages/mcp/README.md#native-messaging-and-automatic-replies).

## Optional execution environments

An environment is the computer or software environment an agent uses. In the
Cua path, that computer is separate from the host running the conversation. An
application selects a small, repository-relative Nix recipe; shared builders
and setup live in Runner.

`mkTools` builds a software closure, `mkContainer` builds a container image, and
`mkCuaDesktop` adds the Cua desktop, browser configuration and services. Agents can
compose a common application recipe with their own packages and settings. The
installed Runner supplies the pinned builders, so ordinary npm upgrades carry
shared implementation updates.

For a managed desktop, `dispatch environment setup --agent researcher` builds
through a pinned Nix builder in Docker, creates persistent instance volumes,
registers Cua and saves a private per-agent binding. Host startup supplies tools
bound to that Space. The application keeps its usual `npm start`, terminal and
Web commands; no host Nix installation or application flake is required.

An existing registered Space can instead be attached. Its current owner retains
provisioning and lifecycle, and attachment does not establish conformity to the
recipe. The bundled builder/driver supports Docker and a Linux ARM64 desktop;
VM disks and cloud provisioning remain with NixOS, Cua or the installation owner.

Credentials, signed-in browser profiles and instance bindings stay outside the
versioned software recipe. Rebuilds preserve managed home/control volumes, not
RAM or guaranteed website sign-ins. Host shutdown does not stop or delete the
desktop. Cua target binding does not relocate native coding tools or sandbox
their host-account access. See [execution environments](../packages/runner/docs/environments.md)
for prerequisites, setup, attachment and rebuild commands.

## Where to read next

| Question | Reference |
| --- | --- |
| How do I create and run an application? | [Build your own agents](../packages/runner/docs/create-agents.md) |
| How do I select providers and models? | [Provider setup](../packages/runner/docs/providers.md) |
| How do shared clients and channels connect? | [Service contract](../packages/runner/docs/service.md), [interfaces](interfaces.md) and the [package index](../README.md#packages-and-integrations) |
| How do I enable scheduled work? | [Schedules](../packages/runner/docs/schedules.md); the standard host uses optional `factory.yaml` to enable scheduled agents |
| How do I upgrade without replacing definitions? | [Ordinary upgrades](../packages/runner/docs/upgrade.md) |
| Where do I inspect saved execution? | [Read-only watch](../packages/runner/docs/watch.md) and [request completion](../packages/runner/docs/request-completion.md) |
| Where does the shared implementation start? | [`protocol.ts`](../packages/runner/src/protocol.ts), [`runtime.ts`](../packages/runner/src/runtime.ts), [`chat.ts`](../packages/runner/src/chat.ts), [`messages.ts`](../packages/runner/src/messages.ts) and [`run.ts`](../packages/runner/src/run.ts) |

Keep an application's concrete wiring and commands in its own README. Keep live
versions, machine bindings, verification receipts and operational gaps in that
installation's deployment records. Those observations change independently of
this framework reference.
