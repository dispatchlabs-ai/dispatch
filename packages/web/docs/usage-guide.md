# Usage

## Start development

Use [the local composition](../../../examples/chat/README.md), which includes a
synthetic provider and instructions for both native local and PostgreSQL/worker
modes. `npm ci`, `npm run build`, `npm start` run inside `nix develop`.
Open http://127.0.0.1:4319, not localhost. Override `DISPATCH_PORT` if occupied.
Do not stop another installation to free a port.

## Configuration

`DISPATCH_CONFIG` selects an absolute consumer-owned native JSON file with
`definitionsRoot`, `host.cwd`, trusted gateway/model-provider bindings, `sources`
(`id`, `label`, absolute existing `path`) and `defaultSource`.
No personal paths, host wrappers, release manifests or platform defaults.
`DISPATCH_CENTRAL_CONFIG` instead selects the [central contract](../../backend/README.md).
Only the service reads PostgreSQL secrets; workers initiate authenticated connections.

Hosted use additionally sets HTTPS `DISPATCH_ORIGIN` and absolute
`DISPATCH_AUTH_MODULE`. The ESM module exports async `authorize(request)` and
must validate credentials/session and authorize every configured run. Return true
only for authorized participants. There is no per-user grant product in this UI.
The adapter receives Node's IncomingMessage (cookie/authorization headers) before
any API request or shell is served. Do not send API credentials in URL query strings.
TLS termination/proxy must preserve exact Host/Origin; backend binds loopback by
default, or explicit `DISPATCH_HOST` in hosted mode. `/health` reveals readiness
only and is unauthenticated. Browser SSE uses the same cookie authorization.

## Native ownership and recovery

Browsing includes configured CLI/workflow-child SQLite histories and committed
WAL without acquiring native locks, opening Harness, connecting models, migrating
or resuming work. Canonical file identity deduplicates overlapping sources.
Send/Stop require a native Chats entry. Child work is controlled through its parent.
Definitions, namespace, execution mode, cwd, host adapters and schema must match.
Workspace/custom artifact host bindings require their original configured CLI.

Admission checks paused native work under acquired locks before submit **or abort**
can enable scheduling. Unrelated suspended conversations, recipient work and
loop/calendar tasks are rejected, not silently resumed. Stop affects the selected
ownership tree, not independent recipient work. No principal-wide concurrency cap.

The browser stores selection in localStorage and uncertain request identity/text
in sessionStorage. It never stores a transcript. A transport failure/500 retains
the original request ID, even after later ownership rejection or reload. Reconnect
observes only; **Retry message** explicitly reconciles the original identity.
First-attempt definite rejection restores an editable draft. Closing the tab loses
that tab's pending identity; reconcile with native history before sending anew.

## Operation and limits

Stop service owners before closed-state backup; retain state, definitions,
workspaces/artifacts and credentials together. Never remove live locks. Uncertain
remote storage reservation/effects require confirmed old-executor termination and
offline retirement, not a lease timeout. No automatic migration or takeover.

Local observed qualification uses a synthetic provider, not external inference,
real tools, hosted identity or live infrastructure. Those are consumer-specific
qualification requirements, not promises made by type/build checks.

## Dependency updates and later deployment

Use the measured dependency-hash procedure in [CONTRIBUTING](../../../CONTRIBUTING.md).
Build immutable artifacts once per relevant input set. Source publication, npm
packing and local archive creation do not deploy anything.

### Current source qualification gaps

Native local and central PostgreSQL/outbound-worker paths were exercised with a
synthetic provider on Apple Silicon. Matching Linux OCI build/install, real hosted
authorization adapters and external provider/tool execution require separate
consumer qualification. Existing dependency audit findings remain in the private
task report; a passing build is not a security review.
