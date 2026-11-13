# Web

Agent Chat's generic React UI, integrated with reusable Dispatch backend
operations. Public name: **Web**. See [design](DESIGN_GUIDE.md),
[use cases](USE_CASES.md), [usage](docs/usage-guide.md),
[HTTP contract](openapi.yaml) and [component notices](THIRD_PARTY.md).

## Quickstart

From an existing Dispatch application's directory with Node 24.22.1 or newer, install the matching Web archive and add its npm command:

```sh
npm install https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.16.0/dispatch-web-0.16.0.tgz
npm pkg set 'scripts.web=dispatch-web --config host.json'
```

Keep the agent host running with `npx dispatch serve --config host.json`. In another terminal run `npm run web` and open the printed address (normally http://127.0.0.1:4319). Open an existing CLI conversation in the sidebar or choose an agent and start a chat. For another port, use `npm run web -- --port 4329`. The explicit port takes precedence over `DISPATCH_PORT`. Ctrl-C closes the browser client process. CLI and Web share the host's saved conversations.

For an agent started with plain `dispatch serve` or `dispatch serve --demo`, run `npx dispatch-web` in the same directory.

`--config` selects the same socket or authenticated service URL as `dispatch chat`. Keep gateway and MCP credentials on the host. Existing Web installations can still supply `DISPATCH_CONFIG` for named installations and historical sources, or `DISPATCH_CENTRAL_CONFIG` for the central backend.

## Build from source

The [synthetic local composition](../../examples/chat/README.md) includes a runnable demo.
`npm run build --workspace @dispatch/web` produces `dist/web` and
`dist/server`; `npm start` starts the built service. Dependency packages must
be built first. Current shadcn Chat/Prompt Input/Trace/Sidebar and Streamdown own presentation;
Runner/Pi own all execution and history. No AI SDK execution loop.

Selection/history/send/steering/streaming/activity/stop, native read-only histories,
uncertain request retention and reconnection are current scope. Retired workspace
screens, account management, projects and company settings are not hidden options.
Hosted authorization is a required installation binding, not a bundled identity UI.

MIT Agent Chat copyright and upstream component licenses are retained.
No private installation paths/configuration or operational data are included.

## Thinking, tools and input files

Provider-supplied thinking summaries appear in an expandable **Thinking** section
while streaming and in saved history. It starts open. No section is invented for
responses without summary text; redacted content and opaque replay signatures
are not displayed. CLI and Web read the same native summaries.

Actual tool inputs/results and native status are expandable in the corresponding
turn; parallel calls retain distinct identities. Missing result is never success.
Use Attach files for UTF-8 text/Markdown/CSV/JSON/source documents and PNG/JPEG/WebP
images; preview/remove files before Send. Images require an image-capable authored
model. Unsupported PDF/Office/binary files are explicitly rejected. Native input
entries retain the bytes and source metadata; saved history/downloads survive
service/worker reconnection without a host-local upload pathname.

Rejected sends retain editable text/files. Uncertain sends lock the original
request identity/content in a per-tab browser outbox across reload. An exclusive
browser Web Lock claims the outbox before access; copied/duplicated live tabs get
independent records preserving the original pending identity and files. Browsers
without Web Locks fail closed rather than risk shared-record overwrite; use Retry
message explicitly. Reconnect never automatically resends. Clear local browser
site data deliberately only when no uncertain delivery/draft needs recovery.
Search histories by title/agent/source/session/ID; visible labels stay compact.
Named installation bindings are documented in [Backend](../backend/README.md).

## Shared service replacement

Use Backend's [shared-owner configuration](../backend/README.md#several-installations-and-saved-histories)
to attach Web and CLI to one maintained owner while browsing native history.
Stop explicitly targets this conversation. Accepted Stop feedback is distinct from
native `unanswered/aborted` turn markers, which remain visible after reopening;
`Turn completed` means a native answered turn, not a claim that project work is done.
Tool completion is labeled separately.

Start the owner explicitly and point Web at its socket or HTTPS connection.
Web shutdown closes its client; it does not stop the host. Named installations use
qualified IDs; installation configuration never supplies definitions or starts owners.
