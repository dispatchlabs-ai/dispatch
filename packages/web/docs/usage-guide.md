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
below. Also set `DISPATCH_SESSION_STATE_FILE` to a stable absolute state file, for
example `/var/lib/example/web-auth/sessions.json`, outside the deployment/Nix tree.
Create its canonical, owned parent directory with mode 0700; Web atomically creates
and maintains an owned regular 0600 file. Run only one hosted Web writer.
Anonymous page visits redirect to `/login`, a native HTML form; API/SSE
requests return 401 without a Basic challenge. Sign-in sets a host-only
`__Host-dispatch_session` cookie (Secure, HttpOnly, SameSite=Strict) for thirty
days. Authenticated requests renew durable expiry and the cookie at most once per
day; SSE observation alone does not renew. This gives roughly 29–30 days of
inactivity before another sign-in, not everlasting access. Sessions survive Web
restart/redeploy when the same state file, credential values and origin remain.
POST `/logout` durably revokes that session and closes its streams. Expired streams
close within a minute, using current durable expiry rather than an old timer.
Only SHA-256 token digests/expiry and a credential/origin binding are persisted,
never raw tokens. State is sensitive: keep it private and do not restore an old
backup (which can restore old sessions). Corrupt/insecure/missing-at-runtime or
unwritable state fails closed; repair deliberately before restarting. Credential
or origin changes discard saved sessions at startup. Rotate credentials and restart
to revoke all sessions. Deleting state deliberately while Web is stopped also
revokes all sessions. Existing pre-persistence in-memory sessions cannot migrate;
one next sign-in is needed after rollout. Visit `/login` while signed in to open
the sign-out control.
The server uses `Referrer-Policy: same-origin` so native form POSTs retain the
exact Origin required by the existing protections; proxies must preserve that
policy. Login requires the exact Origin and form encoding, with a small bounded
credential body, 15-second upload deadline and six attempts/minute across the single
participant. Upload/credential verification never holds the durable-state queue;
only fresh session reads/updates are serialized. Only an
app-shell conversation link is accepted as a return destination; arbitrary return
URLs are not accepted. Sessions do not transfer drafts or native state, and sign-out
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

## Messages during work

Messages always steer active work, like native Slack input. Send a correction
while the agent is busy; it reaches the model at the next native tool boundary,
not only after its final answer. In-flight tools are not interrupted. Pending
input may briefly have native status `queued` until that boundary. Idle messages
start normally. There is no queue/steer selector; Stop remains explicit.

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

## Open a conversation link

Use `https://chat.example.com/?installation=studio&chat=helper%3A42` with the
exact configured installation name and URL-encoded native chat ID. Sign-in with
the shipped session module retains these fields through success or a rejected
password. An unavailable installation/conversation shows an explicit error and
Retry link, never a replacement conversation. Links only observe: opening,
reloading or reconnecting never creates work or resends a message. Reply uses the
existing native conversation and request identity. Unsupported custom runtime
adapters report an explicit link error.

A pending uncertain outbox takes priority; resolve it before opening a different
linked conversation. Existing draft text/files are retained. Selecting a sidebar
conversation leaves the link and resumes ordinary selection behavior. A service
configured without creation hides New conversation and is excluded from the new
conversation agent picker; existing histories/replies and Stop remain available.

## Live navigation and presentation bindings

The sidebar subscribes to authenticated `/api/sidebar/events`. Initial and reconnect
frames contain the full agent/history/source catalog; later frames coalesce native
observations shared by all browser clients. Active work stays above saved history,
ordered by conversation creation (not streaming chunks). Working/Waiting come from
native tasks. Unavailable is not completed; Saved means retained history, not a
successful project outcome. Search also matches exact agent, source, session,
native title and conversation IDs. Source issues remain visible.

Drag the desktop divider to resize navigation; Left/Right, Home and End work when
it has keyboard focus. Width is remembered locally and constrained only to leave
a usable message pane. Small screens keep the focus-trapped drawer.

Optional trusted server bindings, never browser-supplied paths:

- `DISPATCH_AVATARS`: absolute JSON file with `agents` mapping **exact public agent
  IDs** to approved absolute PNG/JPEG/WebP paths, plus optional `user` artwork.
  For example `{"agents":{"studio~helper":"/opt/studio/art/helper.png"}}`.
  Explicit maps work with service-only installations. Files are loaded at startup,
  served same-origin under existing authorization, and never copied into public
  Dispatch packages. Missing/failed images use the same placeholder. A background
  author's role resolves in the conversation's installation, not the main agent.
- `DISPATCH_TITLES`: absolute private JSON file with `directory` (persistent private
  metadata directory), `host` (the supported Backend/Runner `HostModelsConfig`
  gateway or modelProviders binding), and `model: {provider,id}`. Select an existing
  authorized small inference model. Only the first retained request is sent for
  title inference, without tools or binary attachments. Generated short titles
  are persisted by exact public conversation ID, shared by browser/API clients and
  retained across Web restarts. They stay stable during later work. Original
  titles remain `nativeTitle` metadata/search input. Failure retains the native
  title and retries later; truncation is never presented as AI summarization.
  This binding is compatible with existing owners: it never rewrites native
  transcripts, opens a writer, resumes work or changes an agent's model. Keep the
  metadata directory when upgrading/rolling back Web. Absence leaves native titles
  unchanged. Inference is background presentation work and is cancelled on Web
  shutdown, independently of explicit native Stop.

### Keyed item links

An installation can explicitly enable keyed chat links while ordinary creation
remains disabled. For example, set its trusted service binding to
`"keyedCreation":{"agent":"helper","keyPrefix":"attention-item:"}` alongside
`"capabilities":{"create":false,"attachments":false,"artifacts":false}`.
Use `https://chat.example.com/?installation=studio&key=attention-item%3Aitem-42&title=Review+report&context=Choose+a+report+format`.
Build URLs with `URLSearchParams`; keep the exact stable item key on every open.
The item ID suffix is opaque and nonempty: punctuation, slashes, spaces and Unicode
are preserved exactly, without trimming or normalization. C0/C1 control characters
are rejected. Native `chat` and keyed `key` fields cannot be mixed.

After sign-in the explicit keyed link POSTs to `/api/chat-link`, opening the
configured agent's native conversation with that key/title. Native key replay
keeps reopen/reload/two tabs on one conversation; no browser or Backend deduplication
store is added. Ordinary page loads and GET APIs never create a conversation.
The native owner must support idempotent create by key and title. Unsupported or
disallowed installations/keys fail explicitly; New conversation stays disabled.

Until the first message, `context` is shown as the item's title, summary and source
at the top of the conversation (labelled `Title:`, `Summary:`, `Source:` and
`Source URL:` lines are displayed as content), retained in the URL through sign-in
and reload. On your first explicit send, if a fresh native snapshot has no user
message, Web prepends an “About this Attention item” block containing title/context
to your text in one normal message. The transcript shows that complete text.
Later messages are unchanged. Nothing is sent or modeled on open/reload/reconnect;
the composer starts empty unless this tab already has a retained draft.
Same-origin tabs serialize first-send observation/admission; external clients can
still race that observation. Uncertain retries use the exact retained composed
payload and request ID, never prepend context again. Existing drafts and
uncertain deliveries are preserved; resolve a pending message before opening a
keyed link. The context disappears on ordinary sidebar selection. Avoid secrets in
URLs: browser history and operator access logs may retain link fields.
