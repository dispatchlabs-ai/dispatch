# Backend

Reusable application operations for Web, CLI and channel adapters. `openRuntime()`
reads consumer `DISPATCH_CONFIG`; `openCentralRuntime(config)` owns PostgreSQL and
accepts outbound worker connections. Both return `{service,presentation,close}`.
See the [runnable composition](../../examples/chat/README.md).

## Operations

`service.agents` (initial catalog), optional `catalog()` (fresh), `sources()`, `list()`, `has(id)`, `create(agent, source, key, sourceId?)`,
`submit(id,text,requestId,"followUp",source,attachments?)`, `stop(id)` and `artifact(id,id)`.
`presentation.snapshot(id)` and `watch(id,listener)` are read-only observations;
watch returns `{closed,stop}`. API projections/types are exported at
`@dispatch/backend/contracts`; worker provenance and central read helpers have
explicit exported subpaths. `AdmissionError.status=409` is a definite rejection
of **this attempt only**; a previous uncertain attempt keeps its original identity.
Native receipts, not Web, determine admission/replay.

## Central configuration

`CentralConfig`: private `databaseUrlFile`, optional verified `databaseCaFile`,
`workerHost` (loopback default), `workerPort`, `runs` containing unique native
work-scope `id`, private `tokenFile` and authorized `agents` (`id`, `description`).
Each run is an authored native messaging closure, not an agent principal or queue.
A run's token authorizes only its configured stores. Workers never receive SQL
credentials. Keep tokens at least 32 random characters and separate from user auth.
Production worker endpoints require TLS termination and restricted network access.
Configuration is trusted installation code/data, never agent/browser arguments.

Outbound `/workers?run=…` WebSocket uses Bearer run token. `storage` frames
carry `{id,agent,request}` using Remote's public StorageRequest; replies carry
`{type:"storage-reply",id,reply}`. Native commands carry
`{type:"command",id,method,args}`, results `{type:"result",id,result}` or error.
Only bound connections answer matching calls; socket loss/timeout is uncertain.
No automatic application-command resend. `observe` never opens an owner.

Only central storage holds native PG writer connections. Its reservation and
mutation receipt share native transactions; process/socket disappearance never
reassigns a store. Confirm old executor termination before deliberate offline
retirement. No second Fleet engine/launcher or TTL handover.

Local native adapter additionally discovers configured read-only SQLite sources,
including CLI/workflow children and WAL, with canonical-path deduplication.
Native locks, compatibility and paused-work admission checks are retained from
the generic Agent Chat adapter. No private host launcher is shipped.

Hosted authorization is supplied by Web's trusted consumer adapter and must cover
all configured runs; future participant/principal grants are not implemented here.
No principal-wide concurrency limit, and no shadow transcript. Pi owns scheduling,
execution, task ownership, retries and recovery. Fleet remains the existing option
for replaceable EC2 placements; the fixed worker composition does not replicate it.

## Packaging and limits

Node 24.22.1+, Pi 1.5.0; build dependencies first, then `npm run build --workspace
@dispatch/backend`. Public exports reference emitted declarations and shipped JS.
Local synthetic-provider interaction qualifies native/transport/storage behavior,
not production models, real host tools, hosted identity or cloud installation.
MIT generic adapter notice: [Agent Chat](AGENT-CHAT-LICENSE).

Saved PostgreSQL observations share Runner `projectChatMessages` with live chat,
including assistant error-only messages, safe public commentary and native timestamps.
No provider reasoning/raw diagnostics are projected or owner resumed for this read.

## Package distribution

The reusable runtime closure is prepared for public npm publication; this source
change is not a registry release. For dependency-order builds, reviewed archives,
external consumers and separately authorized publishing, follow the
[package release path](https://github.com/dispatchlabs-ai/dispatch/blob/main/scripts/README.md).

## Local installation bindings

Existing single-installation `{definitionsRoot, host, sources, defaultSource}`
configuration remains supported. For separate trusted installations, provide
`installations` and bind **every** source with `installation`:

```json
{
  "installations": [
    {"id":"studio", "label":"Studio", "definitionsRoot":"/opt/studio/definitions", "host":{"cwd":"/srv/studio", "modelProviders":[{"module":"/opt/studio/provider.mjs", "export":"provider"}]}},
    {"id":"research", "label":"Research", "definitionsRoot":"/opt/research/definitions", "host":{"cwd":"/srv/research", "modelProviders":[{"module":"/opt/research/provider.mjs", "export":"provider"}]}}
  ],
  "sources": [
    {"id":"studio", "label":"Studio", "path":"/var/lib/studio/instances", "installation":"studio"},
    {"id":"research", "label":"Research", "path":"/var/lib/research/instances", "installation":"research"}
  ],
  "defaultSource":"studio"
}
```

Paths/modules are consumer-owned trusted bindings, not browser input. No default
installation's definitions, host or provider is inherited by another installation.
Each owner or trusted-adapter worker receives its own configuration, isolating
process environment from other installations. Runtime dependencies resolve
through supported package imports in the consumer's installation, never by
searching another checkout's emitted files or switching a global runtime/profile.
Agent and conversation IDs are qualified as `installation~localId`; callers must
keep returned IDs intact. Creation rejects a source bound to another installation.
Legacy single-installation IDs are unchanged. Named installation mode requires
qualified IDs, rather than guessing an installation for an ambiguous old ID.

A trusted installation may instead declare
`adapter: {module: "/opt/example/adapter.mjs", configFile: "/etc/example/native.json"}`.
Its exported `openRuntime({sources, defaultSource, configFile})` returns the supported
Backend `Runtime` service/presentation/close seam. The adapter owns its native
host and authority; configuration is never sent to the browser. It must retain
native request replay, read-only observation, selected-conversation ownership and
all authorization boundaries. This is not a domain workflow shipped by Backend.
Adapters implement targeted `has(id)` so a request never enumerates all histories
just to locate its installation. No adapter release/executable lookup is performed
by Backend; the consumer owns any distinct-process runtime binding.

Retained catalogs use public Runner saved discovery/catalog APIs, with one process
census per configured root, not per saved session. Optional chat-index metadata
cannot hide readable native histories. Actual file/schema/identity errors stay
visible. Selected history reads target its store and conversation, retaining native
uncapped paging; listing does not open owners/providers or construct tool activity.

## Native content and projection

Attachments `{name,mimeType,data:base64}` are actual bytes, not paths. Runner's
`prepareContent` validates supported UTF-8 documents and PNG/JPEG/WebP, then native
submission retains blocks and input metadata in the same request identity. Backend
and central workers preserve the optional files argument end-to-end. No separate
blob/transcript database or reconnect resend; old clients' plain-text calls remain
compatible. Model capability rejection is409, not an uncertain ignored image.

Runner `projectChatMessages`/`projectChatTools` are shared by live and saved local
and PostgreSQL history. Read-only SQLite projection uses supported
`readWatchChatProjection`; Backend does not reproduce another native SQL reader.
Returned toolCalls retain actual turn/call/assistant-entry identity, inputs/results
and native live/task state. No fake pending-question or subagent result. Native
nested-call parent IDs are exposed only when recorded; missing retired payloads
remain explicitly unavailable.

## Shared local owners and retained history

`openServiceRuntime({socket, sourceId?, label?, expectedStateRoot?, expectedIdentity?})`
connects to Runner's owner-only Unix service API. `close()` detaches observations,
never stops the owner. Native IDs, request IDs and file bytes pass unchanged.
Every command carries its expected native root/installation identity; a service
must support atomic expectation validation (older owners fail closed). A service-only
`DISPATCH_CONFIG` may contain `{"service":{"socket":"/srv/agents/run/service.sock"}}`.
No local owner or automatic mutation retry is used on connection loss.

For native SQLite installations, combine that owner with saved discovery:

```json
{
  "installations": [{"id":"studio", "label":"Studio", "service":{
    "socket":"/srv/agents/run/service.sock", "sourceId":"studio",
    "stateRoot":"/srv/agents/instances/main"
  }}],
  "sources":[{"id":"studio", "label":"Studio", "installation":"studio", "path":"/srv/agents/instances"}],
  "defaultSource":"studio"
}
```

`stateRoot` is the canonical native session directory inside that source.
Live/saved IDs deduplicate by native file and conversation. Offline histories stay
viewable; create/send/stop never claim a replacement writer. Catalog refresh uses
the owner's current agents. Child/foreign histories remain observation-only.
One named installation may explicitly set `unqualifiedChats:true` to retain an
existing client's unqualified conversation IDs; agents remain qualified. Default
named-installation behavior remains fully qualified.

Opaque/custom-store services use a trusted adapter, not the SQLite composition.
An adapter may select `export` (default `openRuntime`) and trusted `options` for
its factory; Backend supplies `configFile`, `sources` and `defaultSource`. The
factory must return the same Runtime contract. This supports consumer-owned
workflow composition without a Web-specific domain adapter or installed-file search.
The optional `catalog()` Runtime method refreshes live agents; `service.agents`
remains the initial catalog for existing consumers.
