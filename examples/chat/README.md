# Local composition

Node 24.22.1+, PostgreSQL 15+ for central mode; no provider credentials needed.
The synthetic provider exercises the **real Runner/Pi/transport/storage and UI**, not
external inference or tools. Configuration creation is exclusive: choose a fresh directory.
Inside `nix develop`, from the repository root:

```sh
npm ci
npm run build
node examples/chat/configure.mjs
DISPATCH_CONFIG="$PWD/.local/chat-example/native.json" npm start
```

Open http://127.0.0.1:4319. Choose helper, type Hello, press Enter. A slowly
streaming synthetic reply appears; send a follow-up or Stop all work, then reload
and reopen its native history. No service/provider/owner starts merely by browsing.

For central PostgreSQL + outbound worker, stop Web, provision a **new disposable**
local database using your PostgreSQL tools, and write its URL into the private
`.local/chat-example/database-url` file (mode 0600). Never use an existing database
for a demonstration. Start the service and worker in separate terminals:

```sh
DISPATCH_CENTRAL_CONFIG="$PWD/.local/chat-example/central.json" npm start
DISPATCH_WORKER_CONFIG="$PWD/.local/chat-example/worker.json" node packages/workers/dist/main.js
```

Web uses the same operations; only the central process reads the database URL.
Worker reconnects observe the retained native owner; no browser or transport
reconnection resends a message. Ctrl-C gracefully suspends/closes owned work.
A killed worker may retain a storage reservation; do not automatically replace it.
Confirm the exact old process is stopped before offline `retireRemoteSession`.
The retained definition and host must match on recovery. There is no TTL takeover.

This is loopback-only synthetic configuration. Hosted mode requires HTTPS,
real authorization, verified database TLS, authenticated worker TLS, persistent
worker workspace/artifacts, and caller-owned process/release supervision.
See the [backend contract](../../packages/backend/README.md).
