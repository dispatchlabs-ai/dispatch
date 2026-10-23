# Integrating remote SQLite

Use Node 24 on both machines. Build and install the runner and remote packages
from the same Dispatch source revision. Keep deployment credentials and live
state outside the source tree.

On the storage host:

```ts
import { SqliteStorageService, connectStorageHost } from "@dispatch/remote";

const service = new SqliteStorageService("/var/lib/example/storage", ["foreman"]);
const connection = connectStorageHost({
  relay: "https://relay.example.com",
  token: process.env.STORAGE_TOKEN!,
  service,
  onError: console.error,
});
// On shutdown: await connection.close().
```

In the authenticated relay, construct one `createStorageRelay(routes)` with
routes such as `{host: "runner-a", alias: "foreman", storage: "storage-a",
store: "foreman"}`. After authenticating a storage socket, call
`connected(storageIdentity, socket)`. Pass host/storage messages to
`message(role, authenticatedIdentity, socket, parsedMessage)` before the
application's other handlers; stop processing when it returns true. Call
`disconnected(socket)` on close. Only the application's current authenticated
runner socket may send storage requests. A storage identity must not be
accepted as a phone or runner.

On the runner, attach `storageRpc(sendOnExistingSocket)`. Feed received messages
to `receive(message)` before application handlers, and call `disconnected()`
when the socket closes. Do not open a second connection if doing so would
replace the existing runner registration.

```ts
import { RemoteStorage, storageRpc } from "@dispatch/remote";

const rpc = storageRpc(sendOnExistingSocket);
const service = await runner.ChatService.open({
  root: agentRoot, stateRoot: localStatusDirectory, cwd: checkout,
  names: ["foreman"], models, demo: false,
  storage: agent => RemoteStorage.open(request => rpc.call(agent.id, request)),
});
```

`run({storage})` and `openAgent({storage})` support the same factory. Return a
distinct authorized logical store for each agent. Local status files and
directory locks remain on the runner; no placeholder local SQLite file is
created in remote mode. Without the factory the existing local SQLite path
is unchanged.

For recovery, first stop the old runner and verify the process has exited,
including any external tool processes. Stop the storage connection before
offline administration so the local service lock is free. Open the service
locally, inspect `await service.owner("foreman")`, and call
`await service.retire("foreman", exactSession, reason)` only for that confirmed
owner, then close it. Restart the storage connection and runner. A stale socket
or unresponsive machine alone is insufficient evidence for retirement.

Back up SQLite with a consistent SQLite backup or while the storage service is
stopped; keep the ownership and receipt tables with native Pi data. Protect and
monitor the storage disk. There is no replica, automatic failover, periodic
backup scheduler, or PostgreSQL migration in this package.
