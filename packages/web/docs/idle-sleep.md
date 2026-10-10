# Operator idle sleep and cold wake

This is an explicit operator path for the distributed PostgreSQL/conversation-worker
installation, not an automatic inactivity timer or browser-triggered wake service.
Source/type/build acceptance does not qualify live sleep, Aurora pause, billing or
cold-start latency. The standalone Terraform module owns IAM-authorized orchestration,
task networking and Aurora settings. Do not overlap sleep, wake or deployment operations.

## Application contract

Send `POST /internal/sleep` with `{}` and the existing operator bearer credential to
the private backend control endpoint. Browser Origin requests are rejected. This
maintenance route remains reachable through the rolling controller while public
admission is closed; it is not exposed through the public API listener.

An initialized owner enters process-local **planned quiescence** before sealing public
admission. During this explicit operator operation, both owner and rolling-wrapper
health probes can remain healthy without admitting new application work, avoiding
ECS replacement solely because the installation is intentionally quiesced. Actual
store/rendezvous failure or shutdown still fails readiness. This state is never
inferred from persisted drain on startup and is cleared by successful undrain.
Health is not evidence of idleness or a successful sleep operation.

- **200 `{quiesced:true}`**: idle workers have closed their native runtimes and the
  launcher has confirmed their retirement. Public admission, worker support and
  credential writers are quiesced. Controllers still own database connections;
  this response alone does not mean Aurora can pause.
- **409 `{quiesced:false,reason:"busy"}`**: a worker has live native tasks (including
  background, waiting and blocked work), queued/placed submissions, or pending local
  reconciliation/reporting. That worker's ordinary RPC admission is restored before
  the refusal returns. Authenticated backend support callbacks remain available, so
  existing work can finish. Public backend admission remains closed; use the existing
  explicit `/internal/undrain` operation to reopen it. Earlier idle workers may already
  have retired and will be recreated on subsequent authorized use.
- **503 or lost response**: inventory, ownership, transport or closure is unresolved.
  Never treat this as permission to stop controllers. Inspect existing operation and
  launcher state before further operator action; do not automatically replay the
  request, clear recovery latches or reopen an uncertain worker owner. `/internal/undrain`
  is not recovery for an uncertain worker close or stop.

The backend persists its admission barrier and joins admitted application/background
requests. It rejects unresolved launch attempts and orphan inventory rather than
cancelling them. Each current ready worker receives an attempt-authenticated
`POST /idle-retire` with `{}`. The worker seals and joins its own RPC/summary admission,
then uses stock Pi Durable **1.0.4** `harness.inspect()` to check all live tasks and
unsettled submissions. `waitForIdle()` excludes background tasks; UI summaries and
browser absence are not shutdown authority. Local upgrade and participant-report
activity also blocks idle retirement.

A qualifying worker closes the harness, connections and durable store through its
existing clean close path, then releases cached provider sessions. Its ordinary RPCs
remain closed. Its authenticated control listener stays up to return the result until
the launcher retires the immutable executor. Existing ECS `STOPPED` confirmation (or
Docker stop/removal) remains mandatory before the backend marks that route retiring.
No replacement is launched by sleep. Native work is neither cancelled to manufacture
idleness nor replayed to wake a replacement; scratch workspace files remain disposable.

Only after fresh launcher inventory confirms every attempt stopped and no remaining
containers does the backend run the existing final drain. Worker support is not sealed
before that confirmation. The existing `/internal/drain` operation remains a **cancelling
maintenance drain**, not a substitute for this eligibility gate.

## Release every database owner

After a successful sleep response, orchestration must verify current drained/quiesced
status, gracefully stop the backend and confirm its termination, then stop the launcher
and confirm termination. This releases directory/routing/auth/provider/MCP stores,
launcher journal and controller-rendezvous connections. Operator/initializer/recovery
sessions and external SQL clients must also finish and disconnect. A zero-ACU minimum
cannot pause Aurora while any application owner keeps its connection open.

Wake starts the launcher before the backend, waits for their owner-aware maintenance
availability, explicitly undrains, then checks application readiness. The existing
admission state survives a stopped installation. Conversations start on demand using
their retained durable store and a fresh attempt only after confirmed prior retirement.
Failed clean closure, interrupted work or a crash still requires the existing explicit
recovery procedure; ordinary wake does not turn into recovery authority.

Initial PostgreSQL connection deadlines are **60 seconds** across application owners,
controller rendezvous/recovery and the database initializer, allowing more time for
Aurora resume than the former 10 seconds. This does not retry transactions, alter SQL
operation deadlines, reconnect a lost owner or guarantee cold-resume success. AWS reports
[typical resume around 15 seconds, longer after extended pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html);
task scheduling, image pulls, application opening and readiness add latency.

## Task networking

The typed ECS driver accepts `assignPublicIp: boolean`, default **false** for standalone
application callers. The module supplies it according to its selected task-egress mode;
it is included in the existing immutable RunTask fingerprint. Enabling it neither makes
the database/ALB public nor opens security-group ingress. Public task IPv4 is an outbound
networking/cost choice; callbacks and worker RPCs continue to use private addresses.

## Verification boundary

The implementation is reviewed against the installed Pi Durable public types and source.
TypeScript/application builds, Apple Silicon Nix build, flake evaluation (zero runnable
checks; Linux omitted) and whitespace/source review passed for this slice. No new runtime tests or AWS operations are
part of this slice. Busy/background refusal, concurrent admission, lost responses,
partial retirement, clean reopen, actual Aurora pause/resume and total wake latency
remain live qualification gaps. Automatic retirement between turns is not implemented.
