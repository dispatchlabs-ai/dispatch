# Web

Agent Chat's generic React UI, integrated with reusable Dispatch backend
operations. Public name: **Web**. See [design](DESIGN_GUIDE.md),
[use cases](USE_CASES.md), [usage](docs/usage-guide.md),
[HTTP contract](openapi.yaml) and [component notices](THIRD_PARTY.md).

First useful result: [synthetic local composition](../../examples/chat/README.md).
`npm run build --workspace @dispatch/web` produces `dist/web` and
`dist/server`; `npm start` starts the built service. Dependency packages must
be built first. React/shadcn Button and AI Elements/Streamdown own presentation;
Runner/Pi own all execution and history. No AI SDK execution loop.

Selection/history/send/follow-up/streaming/activity/stop, native read-only histories,
uncertain request retention and reconnection are current scope. Retired workspace
screens, account management, projects and company settings are not hidden options.
Hosted authorization is a required installation binding, not a bundled identity UI.

MIT Agent Chat copyright and upstream component licenses are retained.
No private installation paths/configuration or operational data are included.
