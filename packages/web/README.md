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

Selection/history/send/follow-up/streaming/activity/stop, native read-only histories,
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
request identity/content in a per-tab browser outbox across reload; use Retry
message explicitly. Reconnect never automatically resends. Clear local browser
site data deliberately only when no uncertain delivery/draft needs recovery.
Search histories by title/agent/source/session/ID; visible labels stay compact.
Named installation bindings are documented in [Backend](../backend/README.md).
