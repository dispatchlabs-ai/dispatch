# Stopped-backend recovery

Backend PostgreSQL provider, MCP and routing stores retain owner latches after an unclean exit. Ordinary restart refuses those latches. An advisory lock becoming available, a disconnected database session, or possession of an owner UUID does not prove the old backend stopped.

Before recovery, independently confirm termination of the old backend and prevent its supervisor/host from restarting it. Record that evidence. Worker retirement is separate: surviving workers may still need authenticated backend callbacks to complete drain. Do not infer worker retirement from backend termination.

For ECS recovery, hold the backend service at zero throughout the one-off invocation. Keep the normal launcher reachable; if it also stopped, independently confirm its termination before bringing it back first. The recovery backend needs that launcher for its subsequent drain and graceful shutdown. Confirm the one-off backend STOPPED before starting the normal flag-free backend service.

Read the retained owner IDs using existing scoped backend credentials for the respective databases, not the RDS master role. Do not delete or update latches with SQL. Supply only IDs for retained latches, using the normal backend executable/configuration plus these one-invocation arguments:

```text
--confirm-retired-backend
--recover-routing-owner <retained-routing-owner-uuid>
--recover-provider-owner <retained-provider-owner-uuid>
--recover-mcp-owner <retained-mcp-owner-uuid>
```

Each supplied ID requires its corresponding PostgreSQL store configuration. Wrong IDs, live owners, missing confirmation and unknown arguments are refused. The confirmation flag is an operator assertion, not an automated fencing mechanism. Never put recovery arguments in a retained Compose command, service definition or automatic restart policy.

Recovery persists public admission closed before opening provider/MCP stores. It does not automatically refresh models, discover MCP connections or undrain. If matching launcher evidence does not confirm retirement, authenticated worker support remains available; this is not backup readiness. Use the authenticated drain operation and require matching launcher identity, complete retirement and backend quiescence before capture. Explicit authenticated undrain is a separate decision.

If startup fails after only some owners recover, inspect the remaining retained IDs again: successful cleanup clears only owners acquired by that invocation. Never blindly replay obsolete recovery IDs. After a successful graceful stop, restart using the normal command without recovery arguments.

This is backend-owner recovery only. Launcher ownership, Pi endpoint markers, worker stores, encrypted backup/key pairing and retired executor denial retain their separate runbook requirements. No existing-installation migration or activation is authorized by these instructions. At introduction, only source/build checks were established.

## Controller rendezvous recovery (source procedure)

The source-published rolling controller introduces a separate retained installation/role
owner record. Its recovery does **not** clear provider, MCP, routing, launcher or
Pi ownership latches; recover those through their existing supported procedures.
Before any rendezvous recovery, hold the affected service stopped, prevent
supervisor restart and independently confirm termination of both the retained
owner and any named successor. Inspect the complete owner/phase/successor snapshot
with scoped credentials. Recovery must match that exact snapshot and refuse live
connected identities; changed or uncertain state requires fresh reconciliation,
not forced takeover. Never retain recovery assertions in normal deployment
configuration. Source `8fb001f` includes the `controller-recovery.ts` CLI for inspection and
recovery without SQL edits; use a matching built artifact only after source review.
Its recovery behavior remains runtime-unqualified.

From `packages/web`, supply an absolute restricted controller database config
using the existing routing-config shape:

```json
{
  "installationId": "INSTALLATION_ID",
  "databaseUrlFile": "/absolute/controller-db-url",
  "databaseCaFile": "/absolute/database-ca.pem"
}
```

The URL file contains that role's scoped database credentials; the CA establishes
verified PostgreSQL TLS. Use the selected controller's database, not an unrelated
store or the RDS master role. Config, URL, CA and snapshot files must meet the
restricted-file reader's ownership/permissions policy. Keep the snapshot private;
it includes internal controller identities/endpoints, even though it contains no
credential values. Create its parent directory privately before inspection:

```sh
umask 077
node build/service/server/workers/controller-recovery.js inspect \
  --config /absolute/controller-db.json --role backend \
  > /absolute/private/retained-controller.json
```

Use `--role launcher` for the launcher row. Inspect exit status and the complete
snapshot; `null` means no retained row and is not a recoverable snapshot. Reconfirm
actual termination of the owner and any named successor and prevent restarts before
running the separate recovery operation:

```sh
node build/service/server/workers/controller-recovery.js recover \
  --config /absolute/controller-db.json --role backend \
  --expected /absolute/private/retained-controller.json \
  --confirm-controllers-stopped
```

For a one-off ECS/operator container using the existing restricted-file bootstrap,
replace `node build/service/server/workers/controller-recovery.js` above with
`dispatch-bootstrap controller-recovery`. Supply the role's existing
`DISPATCH_BOOTSTRAP_FILES` manifest and scoped secret references, with `--config`
pointing to the materialized controller database config. The bootstrap only writes
restricted files and executes this CLI; it does not start a controller or open its
application stores. Run inspection and recovery as separate operator invocations,
never as a retained service command. Transfer the inspected snapshot through an
operator-owned restricted file/bootstrap entry, not an unverified chat copy.

The confirmation is an operator assertion, not proof supplied by the CLI. Recovery
refuses still-connected instance locks and deletes only an exact matching
installation/role/owner/phase/successor record. Those locks add a guard; their
availability does not replace task-termination evidence. A changed snapshot,
connection failure or uncertain result requires fresh inspection, not blind replay.
Reconcile underlying store latches separately. Confirm the one-off operator task
STOPPED before reactivating normal flag-free controllers.

Clean planned shutdown without a successor uses the same joined-operation and
closed-store proof as handover before deleting its own rendezvous record. Mere
connection closure or a startup failure cannot publish vacancy. These are published
source contracts, not observed recovery acceptance. The [rolling work
package](../../docs/handoff.md#workers-and-deployment)
tracks source and runtime evidence separately.

## Observed scope

An October 2026 zero-worker ECS recovery observation confirmed a stopped
one-off backend with exit 0, recovered retained owners, admission still closed,
no unresolved attempts and graceful shutdown with the launcher reachable.
This does not qualify interrupted-workload recovery, encrypted restore,
retired-authority denial or a fresh installation. Installation-specific task and
plan receipts belong in the operator's infrastructure repository.
