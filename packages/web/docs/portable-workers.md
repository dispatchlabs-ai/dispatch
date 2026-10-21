# Portable conversation workers

The `remote-v1` protocol moves the entire conversation runtime—stock Pi Durable, agent execution
and workspace tools—onto an installation-selected execution provider. The main Dispatch backend
owns every conversation-store PostgreSQL connection; launcher journal persistence remains in the
main control plane. A worker receives a store identity and an attempt-bound bearer
token, never a database URL, database password, launcher credential or provider control key.

This is an explicit rollout option. Existing configurations retain `legacy` storage and transport.
Implementation, provider qualification and a particular installation's deployment are separate;
the qualification record at the end identifies observed coverage.

## Storage and recovery

The adapter implements Pi's public `Storage` interface. Each commit remains one PostgreSQL
transaction containing the complete native write batch. Backend connections still use the
existing store-bound PostgreSQL roles and RLS. Pi continues to own execution, transactions,
scheduling and recovery; the API does not expose SQL or accept a caller-selected store.

Every process generates a session UUID. The backend binds it to the current immutable launch
attempt in `dispatch_worker.storage_sessions`. Another process cannot reopen that attempt.
A confirmed replacement gets a new attempt and session while keeping the same durable store.

The client orders storage operations. A mutation's sequence, request hash and result are saved
in the same transaction as its writes or ID allocation. A lost reply can retry that exact mutation;
the persisted receipt returns the original result. Only the last receipt is needed because the
client cannot advance until it acknowledges it. A native `StorageRejected` is returned only after
confirmed rollback; it does not consume a sequence. Conflicting sessions, closed sessions and
changed or out-of-order requests fail closed. Exhausted storage recovery retires the worker
process; it cannot silently reopen its Pi Session.

Backend handover releases its database connections without closing the worker's logical storage
session. The same process can reconnect to the new owner and resolve a lost mutation reply.
Read calls and receipted storage mutations use a three-minute transport retry budget, in addition
to any request already in flight.
This does not retry model calls, tools or other external effects, and is not a promise of
uninterrupted execution or exactly-once external actions.

## Outbound commands and authorization

Workers call `https://<backend>/api/worker/v1/<conversation>/<attempt>/...` for bootstrap,
storage, existing backend services and a long-poll command channel. Route identity, current
attempt and the attempt-derived token authorize every request. Browser Origin headers are
rejected. Do not put tokens in URLs or proxy access logs. Keep the backend's ordinary private
`/internal/*` routes private.

The same authenticated worker Hono handlers process readiness, conversation RPCs, catalog and
membership updates, and idle retirement. The portable process opens no inbound listener.
Commands have request IDs, and the same worker process retains in-flight work/results until
acknowledged. A disconnected poll cannot execute the same command twice in that process.
The command queue is deliberately ephemeral: losing the backend does not replay an uncertain
application RPC. Existing application receipts and a subsequent read resolve uncertain outcomes.

A transport timeout never establishes worker retirement. Replacement still waits for the
launcher/provider to confirm irreversible termination. The launcher persists its provider location;
changing it requires a completed drain recorded by the original provider. Older journals with
active attempts bind only after their actual containers are observed on the configured provider.

Workspace files remain disposable. Publish attachments through Dispatch and commit/push completed
repository work before normal retirement. A replacement recovers durable conversation state;
it does not recover unpushed files, installed packages or an uncommitted working copy.

## Configuration and rollout

Set both ends together, with a new operator configuration revision:

- Backend configuration: `"workerProtocol": "remote-v1"`.
- Worker environment supplied by its launcher: `DISPATCH_WORKER_PROTOCOL=remote-v1` and
  `DISPATCH_BACKEND_INTERNAL_URL=https://<reachable-backend-origin>`.
- Use a publicly trusted certificate, or retain the existing launcher-supplied private CA and
  verified hostname contract. Do not disable TLS verification.
- Allow outbound HTTPS from workers to the backend and their authorized model/tool services.
  Remove worker-to-PostgreSQL ingress/egress and inbound port 8831 in the portable deployment.
  The main service still needs its database and provider control access.

Drain and confirm retirement of the old installation's workers before changing protocol or
provider, then restart the controllers with the matching configuration and reopen admission.
Preserve the installation key, routing journals, stores, credential records and artifacts.
The new session table is additive; it does not rewrite Pi history. Ordinary later backend
handovers in the same protocol preserve workers. Do not downgrade a launcher journal containing
the new provider binding with an older strict-schema binary.

### ECS

Keep the existing `driverType: "ecs"`, immutable task definition, network configuration and
journal. Supply the portable environment above. `warmSpare` must be false: the existing warm-spare
assignment endpoint requires inbound networking and is not part of this protocol's first slice.
Fargate On-Demand and the existing explicit Spot choice retain their provider lifecycle rules.

### exe.dev

Use one operator-provisioned VM with Docker for this installation. Every conversation is an
isolated, non-root container with a private bridge, a disposable writable layer, no restart
policy, no host mounts and no published ports. This first driver uses VM capacity as a pool;
it does not create one VM per chat, resize the pool or move active chats between providers.
Agents in the same conversation share its container, as on ECS.

On the VM, create an operator-owned Docker bridge and pull the exact digest-pinned worker image
before enabling the launcher. Record `sudo docker info --format '{{.ID}}'` as `engineId`.
Both the VM name and daemon ID are pinned, so a renamed/replaced host cannot supply false
retirement evidence. Loss of that host blocks replacement until its original execution is
reconciled; an unreachable VM is never an empty inventory.

Create an expiring exe API key scoped to `ssh <vm-name>`, following the provider's
[command API](https://exe.dev/docs/https-api-run-on-vm). Store only its token in a restricted
launcher-owned file. Never put this provider key in a worker environment. The launcher uses
HTTPS to execute narrowly formed Docker Engine requests on that VM. The default 25-second
request deadline and 10-second stop grace fit the provider's 30-second API window. Retained
Docker container IDs, not VM names, identify create/start/retire operations.

Example launcher driver selection (replace image and identity placeholders):

```json
{
  "driverType": "exe",
  "driver": {
    "vm": "dispatch-workers",
    "engineId": "00000000-0000-4000-8000-000000000000",
    "apiKeyFile": "/run/secrets/exe-api-token",
    "image": "registry.example/dispatch-workers@sha256:<64-hex-digest>",
    "network": "dispatch-workers",
    "user": "65532:65532",
    "command": ["/bin/dispatch-worker"],
    "workingDirectory": "/workspace",
    "memoryBytes": 4294967296,
    "nanoCpus": 2000000000,
    "pidsLimit": 2048,
    "environment": {
      "HOME": "/workspace/home",
      "DISPATCH_DATA_DIR": "/workspace/state",
      "DISPATCH_WORKSPACE_DIR": "/workspace",
      "DISPATCH_WORKER_PROTOCOL": "remote-v1",
      "DISPATCH_BACKEND_INTERNAL_URL": "https://dispatch.example"
    }
  }
}
```

The example uses the Nix `workers-oci` image with its non-root writable workspace. The existing
Ubuntu development image runs as root and is not qualified by this exe driver configuration.
Retain the launcher configuration's installation ID, token/key files and durable journal selection;
the snippet only replaces `driverType` and `driver`. Change the VM/image/resources deliberately,
inspect effective limits, and record shared-pool versus per-task cost when comparing providers.

## Qualification record

The [October 21, 2026 qualification](portable-worker-qualification.md) exercised the same native
Linux image on exe.dev and ECS, real model/tool execution, remote storage, attachment persistence,
confirmed worker replacement and backend crash recovery. It records single-run timings, cost
assumptions and unverified boundaries. The protocol remains opt-in; this experiment did not
migrate an existing installation or establish a general reliability or cost advantage.
Installation-specific resource identities and cleanup receipts belong to the operator's
infrastructure repository.

The separate [shared-pool capacity experiment](exe-worker-capacity.md) measures resident-worker
memory, real model/tool concurrency, fixed CPU workloads and memory pressure on a 2-vCPU/4-GiB
exe.dev pool. Its observed counts depend on the workload and exclude backend/database hosting
inside that pool; they are not application concurrency limits.
