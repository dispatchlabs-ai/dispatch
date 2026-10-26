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
