# Backend

Reusable application operations for Web, CLI and channel adapters. `openRuntime()`
reads consumer `DISPATCH_CONFIG`; `openCentralRuntime(config)` owns PostgreSQL and
accepts outbound worker connections. Both return `{service,presentation,close}`.
See the [runnable composition](../../examples/chat/README.md).

## Operations

`service.agents`, `sources()`, `list()`, `create(agent, source, key, sourceId?)`,
`submit(id,text,requestId,"followUp",source)`, `stop(id)` and `artifact(id,id)`.
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

## Connect to an existing local service

`openServiceRuntime({socket, sourceId?, label?})` connects to Runner's maintained
owner-only Unix API. It returns the same `{service,presentation,stateRoot,close}`
contract without opening a provider, worker or SQLite owner. `close()` stops client
watches only; explicit `service.stop(id)` cancels work. Native chat IDs match the
CLI. `submit` additionally accepts native `AttachmentFile[]` as its sixth argument.
Live snapshot/watch includes native tool calls/results, attachments and partial
output; no shadow transcript or automatic command retry is introduced. Watch
transport failure closes the watch; reconnect explicitly using the same request
identity for an uncertain send.

`openRuntime()` also accepts a service-only `DISPATCH_CONFIG`:

```json
{"service":{"socket":"/srv/agents/run/service.sock","sourceId":"native","label":"Native agents"}}
```

This selects only that service's catalog. Historical read-only SQLite sources
remain a separate local/consumer composition; never claim another live owner's
store. Trusted multi-installation adapters can return `openServiceRuntime` and
qualify native IDs at their existing installation boundary. Use the public
[Runner startup/client contract](../runner/docs/service.md#shared-clients-and-company-compositions)
for supervision, retries, attachments, permissions and deliberate old-owner
migration. The socket is same-account authority, not hosted multi-user auth.
