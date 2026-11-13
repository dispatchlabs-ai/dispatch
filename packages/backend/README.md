# Backend

Presentation and routing for clients of an existing Dispatch host. Ordinary
agent clients use `@dispatch/runner/client` directly. Backend adds Web's source
labels, named installations, retained-history browsing and optional titles.
It never starts a local execution owner or loads agent definitions.

## Connect

```js
import { openServiceRuntime } from "@dispatch/backend";
const runtime = await openServiceRuntime({socket: "/srv/example/run/agent.sock"});
```

Or set `DISPATCH_CONFIG` to an absolute JSON file and call `openRuntime()`:

```json
{"service":{"socket":"/srv/example/run/agent.sock","sourceId":"example","label":"Example"}}
```

A service binding accepts Runner's `{socket}` or `{url,headers}` connection,
plus optional source labels, `expectedStateRoot`/`expectedIdentity` and capabilities.
Every operation is bound to that host's stable identity. Closing Backend disconnects
its clients; only Stop cancels work. Network connections use authenticated HTTPS.
See the [host/client contract](../runner/docs/service.md).

`runtime.service` supplies `agents`, `sources`, `list`, `has`, `create`, `submit`,
`stop` and `artifact`. `runtime.presentation` supplies `snapshot` and `watch`;
watch returns `{closed,stop}` and follows the host's live stream without full-history
polling. `catalog()` refreshes agents; `summary()` batches sidebar activity without
loading every transcript. Exported contracts live at `@dispatch/backend/contracts`.

Human sends steer active work, and retain their caller's request ID. Uncertain
transport failures never cause automatic resubmission or owner replacement.
Native receipts determine admission and completion. Input files are bytes, never
host paths; Runner owns validation and model capability checks.

## Several installations and saved histories

```json
{
  "installations":[{"id":"studio","label":"Studio","service":{
    "socket":"/srv/example/run/agent.sock","sourceId":"studio",
    "stateRoot":"/srv/example/state"
  }}],
  "sources":[{"id":"studio","label":"Studio","installation":"studio",
    "path":"/srv/example/state"}]
}
```

Each installation requires an explicit service connection. Public IDs are qualified
as `installation~id`. Optional `sources` discover retained SQLite history at or
around that service's canonical stateRoot. Live/saved records deduplicate by native
file and conversation identity. Offline histories remain readable; no operation
claims a replacement writer. Unindexed children and foreign histories remain
read-only. The shared Runner reader owns SQLite schema/revision handling; Backend
has no second SQL decoder. Saved-history watches use filesystem notifications.

Use exact source roots to avoid unrelated histories. `exclude` removes existing
canonical subdirectories from discovery. These are installation-owned paths and
configuration, never browser-supplied authority. A service-only installation needs
no filesystem access to its owner's state.

A service can set `capabilities:{create:false,attachments:false,artifacts:false}`
for restricted Web surfaces. Omitted capabilities are supported. Optional
`keyedCreation:{agent:"helper",keyPrefix:"item:"}` permits stable item links;
`openKeyedChat(key,title,installation)` creates/reuses without submitting input.
`resolveChat(nativeId,installation)` observes an existing exact native ID.
Keyed creation is a separate explicit grant from general creation.

## Optional central PostgreSQL deployment

Install matching `@dispatch/remote` and `@dispatch/postgres` packages, then import
`openCentralRuntime` from `@dispatch/backend/central`. These are optional peers;
ordinary Backend imports and clients do not require them. Workers remain a
separate optional package. See the [central example](../../examples/chat/README.md).

Central configuration supplies a private `databaseUrlFile`, optional verified CA,
worker listener and authorized run IDs, tokens and agent catalog. The central
process owns PostgreSQL and accepts authenticated outbound workers. Workers retain
execution ownership; browsing never launches one. Native storage reservations and
mutation receipts persist across socket loss. Confirm executor termination before
explicit offline retirement; there is no TTL takeover. Hosted Web authorization
must cover all configured runs. Per-user principal grants remain future work.

## Presentation and limits

`withConversationTitles(runtime,{directory,host,model})` is an optional title-only
wrapper. It uses host-supplied inference and private metadata keyed to conversation
ID; native history, requests and ownership stay in Pi. Runner's message/tool/turn
projections are shared by live and retained views, including genuine failed or
cancelled outcomes and unavailable retired content.

Node 24.22.1, Pi 1.5.2. Build dependencies before this package. Public exports use
shipped JavaScript and declarations. Synthetic local checks do not establish
production-model, cloud, real-channel or multi-user qualification. See
[use cases](USE_CASES.md), [changes](CHANGELOG.md) and [Agent Chat notice](AGENT-CHAT-LICENSE).
