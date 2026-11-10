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
`DISPATCH_AUTH_MODULE`. The ESM module exports async `authorize(request, response)`
and must validate credentials/session and authorize every configured run. Return
true only for authorized participants. Existing request-only modules remain
compatible. To challenge a browser, end the response (for example with 401 and
`WWW-Authenticate`) and return false; otherwise false produces 403. There is no
per-user grant product in this UI. The adapter receives Node's IncomingMessage
(cookie/authorization headers) and ServerResponse before any API request or shell
is served. Do not send API credentials in URL query strings.

For normal browser sign-in, select shipped `session-auth.js` beside `main.js`
and set `DISPATCH_SESSION_AUTH_FILE` to the same credential format described
below. Anonymous page visits redirect to `/login`, a native HTML form; API/SSE
requests return 401 without a Basic challenge. Sign-in sets a host-only
`__Host-dispatch_session` cookie (Secure, HttpOnly, SameSite=Strict) for twelve
hours. Sessions are memory-only, revoked on Web restart; POST `/logout` revokes
that session. Visit `/login` while signed in to open the sign-out control.
The server uses `Referrer-Policy: same-origin` so native form POSTs retain the
exact Origin required by the existing protections; proxies must preserve that
policy. Login requires the exact Origin and form encoding, with a small bounded
credential body and six attempts/minute across the single participant. No return
URL is accepted. Sessions do not transfer drafts or native state, and sign-out
does not clear browser drafts or stop agent work.

For non-browser clients that explicitly support HTTP Basic, the optional
`basic-auth.js` module beside `main.js` remains available. Some embedded browsers
do not expose its challenge dialog; prefer session authentication for browser use.
Set `DISPATCH_BASIC_AUTH_FILE` to a private absolute JSON file with `username`,
`salt` (16 random bytes, lowercase hex) and `hash` (64-byte Node scrypt result,
lowercase hex). Generate the hash using `scrypt(password, Buffer.from(salt, "hex"),
64, callback)` with Node defaults; keep the original password in your private
credential manager. Every protected request, including SSE, validates it. All
configured runs share that participant's authority. The proxy must pass
Authorization unchanged and must not log it. Basic auth has no app logout button;
close the browser session to forget cached credentials, or rotate the credential
file and restart Web to revoke access. Never reuse a provider/service credential.
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
