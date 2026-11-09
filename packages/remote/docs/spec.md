# Remote SQLite contract

The storage host owns its local SQLite databases. Each logical store contains
one native Pi session, its application documents, and remote ownership/receipt
tables. This implementation retains the runner's per-agent store layout;
individual chats are native conversations inside that store.

Each runner process generates a new random session identity. Opening a store
claims it durably. Only that owner can read or mutate it. A second process
cannot take over on timeout, socket replacement, machine sleep, or restart.
Clean close releases ownership. After a crash, an operator must verify the
old process has stopped and retire its exact session with a reason. There is
no automated runner handoff or provider termination mechanism in this package.

Mutations are strictly ordered by a client sequence. The service stores each
mutation's request hash and reply in the same SQLite transaction as the native
write or ID allocation. An identical retry of the latest acknowledged position
returns that receipt; changed content or an unexpected sequence conflicts.
Only the latest receipt is needed because the client does not advance before
receiving a reply. Opening and closing are idempotent within this protocol.
Retired identities remain recorded and cannot reopen a store.

The client retries transport failures for up to three minutes inside a storage
method. It never retries inference, tools or an entire user action. A fatal
storage failure latches the service's store until process recovery and leaves
uncertain ownership in place. Invalid native read requests can reject that
read without failing the session. Native Pi owns execution/recovery semantics;
receipt deduplication does not make external tool effects exactly once.

The service serializes operations per logical store. SQLite uses local WAL
files, FULL synchronization and a local service lock. SQLite files are never
mounted across the network or synchronized between writers. Multiple
independent stores have independent queues.

Applications authenticate each socket and pass only the authenticated runner
identity into the relay. Trusted configuration maps that identity and an alias
to one storage host/store. The protocol exposes only the native Storage
allowlist, never database paths or SQL. Applications own credential generation,
pairing, revocation, TLS, backups, retention, storage capacity and observability.

Files, tool execution environments and provider credentials remain on the
runner. Changing machines also requires compatible definitions, namespace,
workspace paths, tools and credentials. This first slice does not relax the
runner's saved working-directory check or copy its workspaces.

## Pi 1.5 compatibility

`commit` carries one array of nonempty write batches, not one flat write list.
One native transaction and its remote mutation receipt cover the whole group.
A successful reply contains `{ stored, seqs, refused? }`: one increasing sequence
per durable batch, with a message for the first refused batch when present.
Only Pi's own semantic checks can refuse a suffix; driver or transaction failure
is fatal, with no acknowledgement. The client validates the complete reply before
calling `receive(index, seq)` synchronously in order. Callbacks run after the
outer transaction, including its receipt, is durable. An identical retry returns
the stored prefix and refusal without repeating writes or allocating new IDs.

ID allocation persists its high-water mark with the receipt even before a native
commit uses the ID. Opening an earlier service store conservatively reserves any
latest numeric receipt before Pi loads its allocator. Existing owner/retirement
records and reply hashes are retained; an active owner is never silently replaced.
Old flat commits are rejected, not guessed or converted. Stop and back up both
ends before upgrading together. SQLite's schema remains 2; native Pi document and
task version upgrades are not backwards-resumable. Restore a closed pre-upgrade
backup to roll back. No new protocol behavior has live runtime qualification from
this source change alone.
