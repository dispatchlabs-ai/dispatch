# Web

Agent Chat's generic React UI, integrated with reusable Dispatch backend
operations. Public name: **Web**. See [design](DESIGN_GUIDE.md),
[use cases](USE_CASES.md), [usage](docs/usage-guide.md),
[HTTP contract](openapi.yaml) and [component notices](THIRD_PARTY.md).

First useful result: [synthetic local composition](../../examples/chat/README.md).
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

## Tools and input files

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

Use Backend's [shared-owner configuration](../backend/README.md#shared-local-owners-and-retained-history)
to attach Web and CLI to one maintained owner while browsing native history.
Stop explicitly targets this conversation. Accepted Stop feedback is distinct from
native `unanswered/aborted` turn markers, which remain visible after reopening;
`Turn completed` means a native answered turn, not a claim that project work is done.
Tool completion is labeled separately.

At the same browser origin Web adopts Agent Chat's selected conversation and
per-tab IndexedDB draft/uncertain outbox once, preserving original IDs and bytes.
The legacy record is retained, not deleted. Keep the primary installation's
conversation IDs unchanged with `unqualifiedChats:true` when needed. Do not clear
site storage or change origin before resolving pending delivery. Do not run both
frontends concurrently against the same tab's legacy draft during cutover.
