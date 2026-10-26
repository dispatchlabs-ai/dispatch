# Installed agent service

`dispatch-service CONFIG serve` runs one native Runner owner for an independently
installed definition repository. Model access, state, adapter modules and the
process supervisor belong to the installation. Agent instructions, model
defaults, skills and domain tools belong to the definition repository.

The installation contains one locked dependency tree and an independent
definition checkout below it. Follow [definition workspaces](definition-workspaces.md).
The service discovers runnable definitions unless `names` selects a subset.
`factory.yaml` still controls autonomous schedules; use `agents: []` for a
conversation-only installation.

```json
{
  "root": "/srv/agents/definitions/company-agents",
  "stateRoot": "/srv/agents/state",
  "cwd": "/srv/work",
  "socket": "/srv/agents/run/service.sock",
  "namespace": "company",
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

Paths are absolute. The socket's parent must be owned by the process user and
mode `0700`; the socket itself is `0600`. This API serves the local account over
a Unix socket. Remote clients use separately authenticated adapters; the service
does not expose a public TCP listener.

Each optional adapter entry has an absolute `module` and `optionsFile`.
The module exports `createAdapter(options, context)` returning Runner's existing
`Adapter` interface. The context supplies `cwd` and `connectModels`. Adapters
attach to the same `ChatService`; they must not open another writer for its
agents. Their `prepare` phase declares extensions, `start` receives the service,
and `close` releases transport resources before the service closes native stores.
An optional `busy()` reports unfinished adapter-owned compatibility work.

The optional [Gmail adapter](gmail.md) receives alias-addressed email and sends
threaded final replies through this same owner.

Local clients use the running owner:

```sh
dispatch-service /srv/agents/config.json agents
dispatch-service /srv/agents/config.json create helper "Release notes"
dispatch-service /srv/agents/config.json send helper:2 "Draft notes for these changes."
dispatch-service /srv/agents/config.json snapshot helper:2
dispatch-service /srv/agents/config.json receipt helper:2 7
dispatch-service /srv/agents/config.json idle
```

`send` returns native admission, not model completion. Read the receipt and
snapshot to follow execution. `stop CHAT` aborts its work. `chats` lists saved
conversations. `status` reports unfinished native and adapter work; `idle`
returns a failure exit status when work remains.

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
node packages/runner/scripts/pack-service.mjs installation.tar.gz dispatch-runner-0.6.0.tgz adapter.tgz
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
