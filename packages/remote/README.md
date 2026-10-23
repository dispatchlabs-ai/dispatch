# Dispatch Remote

Optional remote SQLite storage for stock Pi Durable 1.4.0 and the standalone
Dispatch Runner. A runner executes models and tools on its host while an
outbound-connected storage service owns the SQLite files on another host.
An application supplies pairing, authenticated WebSockets and identity.

This is an initial integration package, not a hosted service or a cloud
sandbox provisioner. Dispatch Web's PostgreSQL implementation is unchanged.
The SQLite service currently supports POSIX hosts with Node 24.

Start with the [integration guide](docs/usage-guide.md), the
[storage contract](docs/spec.md), and the [use cases](USE_CASES.md).
Build from the repository's Nix shell with
`npm run build --workspace @dispatch/remote`.

```ts
import { RemoteStorage } from "@dispatch/remote";

// The application binds this transport to one authorized logical store.
const storage = await RemoteStorage.open(request => transport(request));
// Transfer storage ownership to Harness.open(), or return it from the
// standalone runner's `storage(agent)` factory.
```

The relay routes operations, never raw SQL. Its route table maps a runner
identity and alias to a storage identity and store. A phone grant alone
confers no storage-service access. TLS protects each hop; relay operators
can inspect traffic. End-to-end encryption is not implemented.
