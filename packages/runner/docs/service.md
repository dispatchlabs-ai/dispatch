# Installed agent service

`dispatch-service CONFIG serve` runs one native Runner owner for an independently
installed definition repository. Model access, state, adapter modules and the
process supervisor belong to the installation. Agent instructions, model
defaults, skills and domain tools belong to the definition repository.

The host uses one locked dependency tree, either in the application itself or
above separate definition checkouts. See [definition workspaces](definition-workspaces.md).
The service discovers runnable definitions unless `names` selects a subset.
`factory.yaml` controls autonomous schedules by default. Set `schedules: false`
in the service configuration for a conversation-only installation: admitted native
work still recovers, but factory calendars/loops are not enabled. Select a new
state root or deliberately retire saved schedules before changing this policy.

```json
{
  "root": "/srv/agents/definitions/company-agents",
  "stateRoot": "/srv/agents/state",
  "cwd": "/srv/work",
  "socket": "/srv/agents/run/service.sock",
  "namespace": "company",
  "schedules": false,
  "definitionResources": true,
  "gateway": {
    "origin": "https://models.example.com",
    "credentialFile": "/srv/agents/private/gateway.json",
    "aliases": { "openai": "provider:openai-codex" }
  },
  "adapters": []
}
```

The gateway implements the Pi Messages catalog and streaming endpoints and its
provider-group Responses endpoint, used by the exported `refreshGatewayModels`
connector. Its private credential file
contains a `key`. Provider aliases let definitions name a provider independently
of one installation's connection ID. A connection ID selects that connection;
`provider:PROVIDER` selects the gateway's authorized account pool through its
Responses API. Pool failover remains server-owned. The installation must supply all providers
required by its agents. This connector is not an arbitrary OpenAI-compatible
endpoint adapter.

Custom hosts can import `refreshGatewayModels` and `GatewayAuthorization` from
`@dispatch/runner/gateway`. Its third argument accepts the existing static key or
an async authorization callback:

```ts
await refreshGatewayModels(origin, models, async ({ forceRefresh, signal } = {}) => {
  return broker.authorize({ forceRefresh, signal });
}, { openai: 'provider:openai-codex' }, { signal: startupSignal });
```

The callback runs for each catalog or inference request; the host owns token
caching and renewal. A gateway HTTP 401 triggers one retry with `forceRefresh`
set to `true`, before request admission. Other HTTP failures and accepted streams
are not retried by this connector. Cancellation reaches the callback and request.
Credentials are sent only to the configured origin's `/v1/` paths; redirects are
rejected. Static-key and native-keychain callers retain their existing auth flow.

### Local model providers

Both the service and on-demand CLI accept optional `modelProviders`. Each trusted
host module exports a factory returning a native Pi `Provider`. Its optional
`args` array is passed to that factory. An optional `closeSessionExport` names an
async cleanup function in the same module. Runner calls it with each provider
session ID used by that connection, after native work has stopped or suspended,
and awaits it before exit. An optional `id` binds the provider to an existing
authored provider name. These bindings replace the matching gateway provider;
an error does not fall back to API billing. Modules run with the host's privileges.
Keep secrets in the provider's credential store, not factory arguments.

An installation that holds one provider API key binds Runner's own
`environmentProvider`. Its argument names one of Pi's built-in providers, and
that provider authenticates from the environment variable it defines, such as
`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`:

```json
{
  "modelProviders": [{
    "module": "@dispatch/runner/environment-provider",
    "export": "environmentProvider",
    "args": ["openai"]
  }]
}
```

`module` is an absolute path, or one of Runner's own exports named this way.
Only the named provider reads the environment; no other provider gains ambient
credentials. A detached session owner keeps the environment it was started
with until it exits. Raw provider errors are withheld as described in
[credentials](credentials.md#provider-error-privacy). This suits a first
conversation or one person's machine; a shared installation uses the gateway or
a provider module with its own credential store.

For the experimental [Earendil Claude Code provider](https://github.com/earendil-works/pi-claude-code),
build the pinned module with `nix build .#claude-code-provider` and retain its
store path in a Nix profile. The package applies one source patch that restores
signed thinking from earlier assistant turns in each replayed request. Set `module` to its `lib/pi-claude-code/index.js`:

```json
{
  "modelProviders": [{
    "module": "/absolute/provider-installation/lib/pi-claude-code/index.js",
    "export": "createClaudeCodeProvider",
    "closeSessionExport": "closeClaudeProcesses",
    "id": "anthropic"
  }]
}
```

Install the official Claude Code CLI on that host and sign into the intended
subscription with `claude auth login`. The provider uses that login; Runner
does not collect subscription tokens. Pi Durable still executes tools and owns
history, cancellation and recovery. The upstream provider's billing guard is
preserved: usage-credit responses fail unless its explicit opt-in is configured.
Its token costs are list-price estimates, not proof of an API charge. Inspect
the saved `claude-code.rate-limit` diagnostic for subscription/overage attribution.
CLI availability, plan capacity and future provider billing changes still apply.

The Nix output compiles the pinned upstream source without changing its behavior,
retains its license and source revision, and shares Runner's Pi dependency tree.
It does not install Claude Code, sign in, select a host route or start an agent.

Paths are absolute. The socket's parent must be owned by the process user and
mode `0700`; the socket itself is `0600`. Keep the complete socket path short
enough for the platform Unix-socket limit (about 104 bytes on macOS). This API serves the local account over
a Unix socket. Remote clients use separately authenticated adapters; the service
does not expose a public TCP listener.

Each optional adapter entry has an absolute `module` and `optionsFile`.
The module exports `createAdapter(options, context)` returning Runner's existing
`Adapter` interface. The context supplies `cwd` and `connectModels`. Adapters
attach to the same `ChatService`; they must not open another writer for its
agents. Their `prepare` phase declares extensions, `start` receives the service,
and `close` releases transport resources before the service closes native stores.
An optional `busy()` reports unfinished adapter-owned compatibility work.
Prepared adapters declare `transport` (for example `slack`, `google-chat`, `email`).
Background reply destinations can carry that explicit `transport`; Runner selects
exactly one matching adapter, never broadcasts. Untagged saved destinations work
only with one adapter. A company composition can supply `run({replySink})` to
resolve its own retained routes. Multiple accounts of one transport also need
that explicit company routing; no channel/user is guessed.

The optional [Gmail adapter](gmail.md) receives alias-addressed email and sends
threaded final replies through this same owner.

Local clients use the running owner:

```sh
dispatch-service /srv/agents/config.json agents
dispatch-service /srv/agents/config.json schedules
dispatch-service /srv/agents/config.json create helper "Release notes"
dispatch-service /srv/agents/config.json send helper:2 "Draft notes for these changes."
dispatch-service /srv/agents/config.json snapshot helper:2
dispatch-service /srv/agents/config.json receipt helper:2 7
dispatch-service /srv/agents/config.json idle
```

`send` returns native admission, not model completion. Read the receipt and
snapshot to follow execution. `stop CHAT` aborts its work and cancels existing
unfinished [request records](request-completion.md) in its owned scope. Sends
admitted after Stop wait until its cancellation bookkeeping finishes. `chats` lists saved
conversations. `schedules` exposes [agent-local deadlines and admissions](schedules.md).
`status` reports unfinished native and adapter work, excluding future sleeping calendar tasks; `idle`
returns a failure exit status when work remains.
Status also lists native task states and queued counts by conversation. `held`
means pending input has no unfinished task, not that inference is running.
Snapshots expose native compaction progress/failure, including a failure after
its parent generation has ended.

[Instance messaging](instance-messages.md) lets opted-in definitions create or
address independent conversations in this service. Include every permitted
recipient in `names` when selecting a subset. Native message tracking contributes
to busy status; stopping the sender does not cancel admitted recipient work.
Use Dispatch Observer for complete saved tool calls/results and message tasks;
`snapshot` is a text projection, not a full trace.

The versioned local API is `POST /v1/commands` with the exported `ServiceCommand`
JSON union; success is `{result}`, failure is `{error}`. A caller supplies a
stable `key` for idempotent `create` and a stable `requestId` for message retries.
The CLI generates fresh identities for explicit new commands. A transport that
retries automatically must retain its original identities.

Existing conversations retain their native configuration. New conversations
inherit their agent's model and thinking level. Definition changes require
`updateDefinitions: true` at a deliberate idle deployment; normal startup
detects incompatible definition changes rather than silently rewriting a store.
Keep the durable namespace fixed. Graceful SIGINT/SIGTERM closes adapters and
releases each native storage owner; storage crash recovery remains governed by
Pi Durable's ownership contract.

The runtime package contains no machine installer or personal definitions.
Deployment tooling selects exact runtime artifacts and definition revisions,
checks idle state, supervises the process and preserves state. Source/build
checks alone do not qualify a particular host or adapter installation.

After building and packing Runner, prepare an installation artifact with the
selected adapter archives:

```sh
node packages/runner/scripts/pack-service.mjs installation.tar.gz dispatch-runner-0.11.1.tgz adapter.tgz
```

Build on the target platform with its pinned Node toolchain. The archive retains
the installed dependency tree, generated dependency lock and each input archive's
SHA-256. Keep the resulting artifact and its reported digest in the installation's
artifact store. Definitions, credentials and session state are not bundled.

## Sustained provider recovery

The optional installation `retry` policy feeds stock Pi Durable settings; it
does not resubmit input or rerun a workflow. For long transient outages:

```json
{
  "retry": {
    "maxRetries": "persistent",
    "baseDelayMs": 2000,
    "maxAgentDelayMs": 900000,
    "jitter": 0.2
  }
}
```

Pi classifies retryable model failures, exponentially backs off, and commits each
retry deadline in its native task. This example waits 80–100% of the exponential
delay, capped at 12–15 minutes. Reopening preserves the saved deadline and same
submission. `persistent` maps to the largest exact integer retry count, making
exhaustion operationally unreachable; it is not a guarantee of eventual success.
There is no elapsed-time abandonment. Successful model responses reset the native
generation retry sequence. Stop explicitly with `stop CHAT` to cancel pending work.

Omitting `retry` preserves Pi's defaults (three retries, 2-second base, 60-second
cap). Numeric `maxRetries` selects a finite count, `enabled: false` disables retries,
and `jitter: 0` keeps exact delays. Invalid policy values fail before service
startup. Retry policy is host-owned, not part of the definition fingerprint.
Library callers can pass native `settings` (including a callback) to `run`; custom
`open` callbacks receive it and must forward it to the host they create.

Snapshots/watches expose `retry: { attempt, at, error }` while waiting; `at` is
epoch milliseconds. The service remains busy during this wait. This supplies
observability for clients, not an automatic notification service. Non-retryable
authentication/billing errors and approval or tool failures are not converted
into retries. Inspect native receipts before repeating any uncertain external
effect. Already-terminal submissions remain terminal; a deliberate continuation
is still needed for work exhausted under the old policy.

A policy change requires a controlled owner restart. Preserve unfinished native
state and the installation's idle/deployment rules. The policy does not repair
gateway startup/catalog failures before a Harness exists, nor change adapter
retry policies. No provider, credentials, model or financial logic is replaced.

Manual source qualification on macOS/Node 24 verified five simulated transient
failures followed by success on the same native submission, with an unchanged
retry deadline across graceful close/reopen. A permanent 401 settled unanswered;
stopping during a pending retry settled aborted and left the conversation idle.
These isolated observations do not establish recovery of a production provider
outage or abrupt process-loss recovery.

## Compaction and queued-input recovery

Service configuration accepts Pi's native `compaction` settings and
`afterFailedRun` (`keep`, `continue`, or `withdraw`). Omission preserves Pi's
trigger and inbox defaults. `continue` advances inputs already queued behind a
failed run; it does not replay the failed input or its tools. `keep` retains them
for explicit continuation. `withdraw` settles them unanswered.

Runner supplies summaries through stock Pi Durable's `beforeCompact` hook.
The summary keeps the selected model and thinking level. Its output allowance is
the model's advertised maximum output, reduced when necessary to fit the
estimated summary request inside the model's configured context window.
`reserveTokens` controls when compaction starts; it does not cap this allowance.
The configured working context remains unchanged.

Summary requests run as native tasks owned by Pi's compaction task. Transient
provider errors use the configured native retry policy and durable deadlines.
An output-limit or context-overflow response splits the source into smaller
chronological sections, summarizes them independently, then merges the complete
results into one current checkpoint. Merging requires a smaller source, so
recursive recovery keeps reducing the workload. Attempts, completed sections and
usage survive reopening in the same native store; stopping the compaction
cancels its owned work. The original history stays intact until Pi places a
complete, smaller summary at its selected boundary.

If the model cannot complete even the smallest section, a section fails for
another reason, or the result does not reduce the source, Runner falls through
to Pi's built-in summarizer. Pi's hook API has no failure decision; native
compaction remains responsible for reporting its terminal outcome. Neither path
places incomplete text. Service status exposes summary tasks and their native
states; a busy compaction is not necessarily an active provider request.

Older Runner installations used Pi Durable 1.4's built-in allowance of 80% of
`reserveTokens`, capped by the model's output limit. The default reserve of
16,384 allowed 13,107 output tokens, including shared reasoning tokens. A larger
reserve was a workaround that also moved compaction earlier. With Runner's
summary extension, select the reserve for trigger headroom alone:

```json
{
  "afterFailedRun": "continue",
  "compaction": {
    "modelOverrides": {
      "provider/long-context-model": { "reserveTokens": 16384 }
    }
  }
}
```

`keepRecentTokens`, `backgroundTokens`, and `enabled` retain Pi's meanings.
The summary extension is added to existing Runner conversations before native
scheduling resumes, preserving their other configuration. An already-selected
built-in summary request retains its saved policy; the hook applies when Pi next
selects a compaction range. Reopening with an older Runner while custom summary
tasks remain unfinished is unsupported; preserve the matching runtime until
those tasks settle.

After correcting policy and gracefully reopening the same owner, recover a
held conversation with `compact CHAT [INSTRUCTIONS]`. This invokes native
`Conversation.compact`, returns its task ID, and preserves entries, task outcomes
and submission IDs. A successful summary write admits retained queued input at
the native boundary. Inspect `status`, `snapshot` and the original receipt; no
second submission is needed. Inspect an existing compaction task before retrying
an uncertain request. Failure or a no-op compaction is not recovery success.
The command also works during an active run; Pi controls when the resulting
summary is placed. Never edit SQLite or reset the
conversation to bypass a failed summary.

Manual macOS/Node 24 qualification on October 30, 2026 exercised a long-transcript
replay through a live model route: input-budget splitting, complete section
summaries, a final merge and native summary placement succeeded. Graceful
close/reopen retained task identities and budgets; original transcript entries
remained unchanged and usage appeared in the native ledger. Type/build checks
passed. No automated tests were added or run. Direct provider-length responses,
terminal cancellation, abrupt process loss and other platforms were not exercised
by this replay.

## Shared clients and company compositions

Start one supervised native Node owner:

```sh
dispatch-service /srv/agents/config.json serve
```

From other terminals, `dispatch-service CONFIG connect CHAT` opens the exact
native conversation (for example `helper:2`); omit CHAT to create one using the
definitions' default agent. `/history`, `/stop` and `/quit` are explicit commands.
EOF, `/quit` and Ctrl-C disconnect **only the client**; Ctrl-C exits 130. Interactive
messages return admission immediately while observation continues, so Stop and
steering messages remain available during work. No client enables schedules or providers.

A configured `dispatch-agent --root DEFINITIONS run --config HOST.json --session
KEY --prompt TEXT` also connects when HOST contains `socket`. Named keys use the
existing `terminal:KEY` native creation key. A retained agent is preserved when
no `--agent` override is given; `--request-id ID` permits explicit retry after
uncertain admission. Prompt mode waits for that native receipt and exits nonzero
on an unanswered turn. Legacy configurations without `socket` retain direct-owned
terminal/workspace behavior. They cannot be hot-attached or silently migrated:
finish/suspend old owners and deliberately deploy compatible bindings. Never
remove a live store lock. No historical store is copied into a client database.

For a consumer application:

```ts
import { openServiceRuntime } from "@dispatch/backend";
const client = await openServiceRuntime({ socket: "/srv/agents/run/service.sock" });
const chat = await client.service.create("helper", "web", "example-discussion");
await client.service.submit(chat.id, "Hello", "example-request-1", "steer", "web");
console.log(await client.presentation.snapshot(chat.id));
await client.close(); // disconnect, not Stop or owner shutdown
```

Runner connection IDs are native `agent:conversationId`, not read-only SQLite
catalog hashes. Company facades may use opaque IDs: clients must return them
unchanged rather than parse them. Clients can poll/watch live snapshots, including partial text, native tool
calls/results and attachment projections, and explicitly stop the same chat.
Independent conversations remain independent Pi conversations in the owner's
store. Watch loss ends that observation; reconnect explicitly. Reads do not open
another Harness. This owner-only local socket grants the local account the service's
configured authority, not a multi-tenant principal/participant permission system.
Use separately authenticated and authorized adapters for remote clients.

The public `@dispatch/runner/service` exports `serveService(service, socket)` for
company applications that already compose `run({open})` or `ChatService.attach`.
It accepts the structural `ServiceOperations` interface and binds that exact
native service, including custom workflows; it opens no stores
or model connections. Close the returned listener and then the company runtime
on supervisor shutdown. Its optional third argument is the prepared adapters for
busy status. An optional fourth `ServiceMetadata` argument supplies `stateRoot`
and `defaultAgent` for custom compositions. `info` exposes this trusted metadata;
`startService` supplies its native state directory and optional authored default.
A socket-only CLI configuration can create using the owner's default without a
local definition checkout. Backend returns metadata `stateRoot` when available,
otherwise the socket display path. Do not install two owners against the same
native state.

`serviceRequest(socket, command)` is typed by `ServiceCommand`/`ServiceResults`.
Create accepts `source`; send accepts `source`, legacy `mode` and
`files: [{name,mimeType,data}]` with base64 bytes. Native validation admits UTF-8
text documents and PNG/JPEG/WebP images only for image-capable authored models.
There is no application request-byte ceiling; hosts must provision memory/disk
for JSON/base64 requests. Ordinary user sends always steer active work using native
`whenBusy: "steer"`,
including when a legacy caller supplies `mode: "followUp"`. Idle input starts
normally. Internal `agent`/`schedule` sources retain explicit mode semantics;
peer messages and schedules are not changed. Native steering waits for the next
tool/final boundary, does not abort an in-flight tool, and can briefly report
`queued` before placement. `ChatService.submit` applies the same user policy.
Custom `serveService` facades must honor the supplied steering mode in native
admission rather than replacing it with follow-up behavior.
No filename is interpreted as a host path. `find` looks
up a stable native creation key (optionally scoped by agent). Artifact downloads
return retained verified bytes as base64. Receipts remain Pi submission records.

Use `dispatch-service CONFIG command COMMAND.json` to send a precise command,
including files, stable create key or stable requestId. Preserve the original
identity and payload after an uncertain transport failure. The client never
resends automatically. `ServiceError.status` preserves a definite native 409
rejection; transport failure is not proof of rejection. Restart the compatible
owner with the same state, namespace, definitions, provider and adapter bindings
to recover admitted work; native Pi determines safe replay and cancellation.
Keep complete closed-state backups before upgrades. Publication is not activation.

Runner Nix outputs include Backend/Remote/Postgres and their exact dependencies
in `lib/agent-node_modules` by default (`withBackend: false` is an optional small
legacy closure). Consumers import the public `@dispatch/backend` entry using that
explicit package context, never discover installed private dist filenames.

### Binding a socket to an installation

A Unix pathname can be reused by another owner. `info` metadata includes the
actual `stateRoot`, or a company facade's explicit stable `identity`. Trusted
custom `serveService` compositions must provide one in the fourth argument.
Choose a stable installation identity for a multi-store facade, not a PID or a
conversation ID; different authorized installations must not share it.

`serviceRequest(socket, command, {expected:{stateRoot?,identity?},signal?})` sends
an expectation envelope. The same server handler validates it before dispatching
ANY command, including reads. Mismatch is409 with no operation; an info preflight
alone would leave a socket replacement race. Legacy direct commands still work,
but clients holding cached/projected identities must bind their expectation.
Compatible restart retains the expected root/identity. Backend accepts explicit
`expectedStateRoot`/`expectedIdentity`, or binds to the first info result; it fails
startup if neither identity field exists. Terminal connections bind identically.
This is installation selection safety, not a new authorization registry.

Snapshots additionally expose optional `turns`: native submission IDs, input entry
IDs, lifecycle status and unanswered reason. `done` means an answered turn, not
completed project work; `unanswered/aborted` means stopped, never success inferred
from a tool result. This projection also applies to saved read-only history.

## Ordinary session owners

The installed `dispatch-agent ... run --config HOST.json --agent helper
--session KEY --prompt "..."` path without `config.socket` now starts or connects
to a detached native owner in exactly `HOST.stateRoot/KEY`. It retains the native
`terminal:KEY` creation key, conversation, submissions, tools and history. A CLI
exit never sends Stop. Prompt mode waits for its native receipt and drains peer
work; the owner stays listening after completion. Native watches/history remain
read-only. No factory calendars are reconciled and no autonomous loop is started;
previously admitted tasks recover only through Pi. The embedded `chatInTerminal`
API retains its caller-owned lifecycle and continuous-loop options.

The public `discoverSessionService(sessionDirectory)` export in
`@dispatch/runner/service` returns `undefined` or a `SessionEndpoint` observation:
`{version:1,socket,stateRoot,identity,pid}`. `stateRoot` is canonical; the private
`service-endpoint.json` resides in the actual session directory. The socket is a
short hashed pathname below owner-only `/tmp/dispatch-UID` (canonicalized on
macOS). `service.log` is private owner diagnostics, not a transcript export.
The endpoint is not a writer lease, queue or second ownership database. Native
locks remain authoritative. Consumers must bind both `stateRoot` and `identity`
as `serviceRequest` expectations on every operation, not trust a PID or pathname.
Backend local sources perform this discovery automatically and retain their
canonical database/conversation-based public IDs. A retained but unavailable
endpoint never permits Backend to fall back to opening another writer.

The selected Node/runtime module, canonical definition root, authored messaging
closure fingerprints and host JSON determine an owner's installation identity.
Clients bind every command to that identity, so a command never reaches an owner
other than the one it discovered. POSIX process detachment and Unix sockets are
required. The startup lock only serializes concurrent launch attempts; it never
substitutes for native ownership. There is no restart daemon: a later ordinary
run, or `--resume-only`, starts the owner again. External supervisors may keep
using `dispatch-service`/`serveService`.

### One Pi Durable per state root

`stateRoot/.runtime.json` records the Pi Durable version that owns the
installation's stores. Every decision about it is made under one lock
(`.runtime.lock`), by the CLI before it creates or joins a session and by
`ChatService.open`/`run` when given `runtimeRoot` (`ServiceConfig.runtimeRoot`
for a supervised service or Web backend that shares the root):

- A runtime carrying an **older** Pi Durable refuses and opens no store. Roll
  forward, or restore the state root with the older release.
- Any other runtime first finds every live process of another version that owns
  stores under the root: processes registered in `.runtime-holders/` and session
  owners started before holders were recorded. It asks all of them to close with
  their normal shutdown (SIGTERM: native work stays pending, nothing is
  cancelled) and waits until **all** are gone. Only then does it record its
  version and open. If one does not close within a minute, nothing is selected
  or opened.
- Session owners that had unfinished work are listed in
  `.runtime-interrupted.json` and resumed on the selected runtime by the next
  CLI run, after the takeover has finished.

Two guarded versions therefore never own stores under one root at the same
time, including when they start concurrently. Closing an owner cannot undo
external effects: Pi reruns only replay-safe tools and reports an interrupted
unsafe call as interrupted. Releases built before this record existed do not
check it; do not keep them installed or selected. A current run still closes
their session owners. Workspace sessions pin their release's runtime; finish or
suspend them before installing a release with a newer Pi Durable, because the
pinned runtime will refuse to open.

### A session follows the selected release

An ordinary session is not tied to the release that created it:

- Its owner exits after `ownerIdleMinutes` (host JSON, default 60, `0` keeps
  it) without unfinished native work, a waiting client or an admitted command.
  Reads such as a watching Web client do not keep it alive.
- A run that finds a live owner with a different identity replaces it when it
  has no unfinished work. If it has unfinished work and differs only in
  definitions, the run attaches to it. If its host configuration differs, the
  run is refused: that owner is never joined or replaced while it has work.
- Changed definitions apply when the saved work is idle. While work is
  unfinished the store opens with its stored conversation configuration, the
  work finishes, and the owner exits as soon as it is idle so the next start
  applies the update. Working directory, execution mode and host-extension
  checks are unchanged and still refuse an incompatible host.

`--resume-only` starts the owner and resumes existing native work without
admitting a prompt; it needs the existing store and its agent.
`--update-definitions` and `--replace-owner` are accepted for compatibility and
no longer required. Installed consumer and hosted browser qualification are
separate from source compatibility.

`connectInTerminal` accepts optional `expected: {stateRoot,identity}` for an
already-discovered owner and `drain: true` to wait for native idle after the
submission receipt. The `drain` service command is optional for custom facades;
an unsupported owner rejects it rather than claiming completion. Closing a
waiting client only cancels its observation, not the admitted work.
