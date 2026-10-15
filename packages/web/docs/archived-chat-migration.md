# Copy archived native chats into a worker deployment

The operator tooling copies an idle project from a schema-v1 native Pi snapshot into an existing directory/worker deployment. Each selected chat gets a separate worker store and a pending route with no executor. Directory publication archives every copied chat for all accounts present in the destination company. Existing chats, project settings, authentication and grants remain unchanged.

This is an offline administration procedure, not a browser import or a whole-installation replacement. The backend must be stopped cleanly during publication. Opening an imported chat later follows normal worker startup behavior; archive preferences hide chats but do not prohibit explicit reads or future work.

## Prepare

Capture a consistent, settled native store as `source.sqlite`, with attachment bytes under `attachments/<uuid>`. Preserve the original installation and retain the snapshot privately. The source must have no active tasks or queued/placed submissions. The current extractor accepts flat native conversation ownership; forks or nested ownership require separate qualification.

Capture destination company, users, configuration and current native directory documents as `TransferInspection`. Supply explicit source/destination project IDs, a UUID batch identity, source-to-destination human account mapping, and the stable worker workspace path as `TransferConfig`. These shapes are defined in `server/storage/native-chat-transfer.ts`; installation values and snapshots must stay out of Git.

From the repository root in the Nix development shell:

```sh
npx tsx scripts/prepare-archived-chats.ts SOURCE_DIRECTORY TARGET_INSPECTION.json CONFIG.json NEW_OUTPUT_DIRECTORY
```

The output includes one SQLite file per chat, attachment bytes and a plan with SHA-256 receipts. Native conversation, entry, task and submission identities stay intact inside each isolated store. Public author/account references and attachment download URLs are mapped to the destination. Current configuration uses the destination workspace and project instructions; historical task and document state remains available. Source agent/skill revisions receive a batch namespace; imported agent templates are archived so they do not replace active destination definitions. Source account databases, provider credentials, MCP connections and management grants are not copied.

Inspect the plan, source counts, current account mapping and project selection before publication. The preparation command creates a new output directory and does not contact the destination.

## Publish and verify

Stage the prepared output in the destination's private S3 artifact bucket under a unique batch prefix. Run `publishNativeChatTransfer` from `server/storage/publish-native-chat-transfer.ts` in an operator process with the deployment's verified database CA, backend database credentials, installation identity and worker provisioning key. Keep credentials in the existing secret delivery mechanism. An operator wrapper supplies the function's options and progress callback; it must not start the application Harness.

1. Serialize with other maintenance, record the current backend definition and worker inventory, stop the backend and confirm its clean exit.
2. The publisher takes native directory ownership, verifies company/account/project identities and rejects numeric or template namespace collisions. It saves private directory and route snapshots in the batch prefix.
3. Provision each new restricted worker role, import the matching snapshot, and compare every native table and allocator against readback. Existing stores are accepted only when they exactly match the snapshot. Verify each S3 attachment by reading it back.
4. Insert pending routes using `configurationRevision` from the current deployment, then atomically append directory metadata, participant journals and the batch receipt. A never-launched import must not use `sleeping`, which assumes a retired launcher attempt exists. Verify changed documents and that unrelated directory documents remain identical.
5. Confirm the operator has exited, restore the backend, check health and archive visibility for destination users, and inspect representative histories and attachments through the normal application.

Publication does not launch workers or submit jobs. Cross-database publication is intentionally ordered: prepared stores and routes may exist before their chats become visible. If interrupted, retain the same batch and retry after confirmed operator retirement. The same plan verifies existing stores without replacing them; a changed plan or conflicting data is rejected. A committed directory receipt marks completed publication. Preserve receipts and snapshots for recovery; do not delete native records or reset owner latches to bypass a failure.

The original `importSqlite` mode still requires an empty dedicated database. Its worker mode requires provisioned credentials restricted by PostgreSQL row-level security to exactly the named store, and supports verification of an already imported store.
