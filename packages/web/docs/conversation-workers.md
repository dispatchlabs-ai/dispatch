# Single-server conversation workers

**Portable worker protocol, October 21, 2026:** [Portable conversation workers](portable-workers.md)
describes the opt-in backend-owned storage API, outbound command channel and ECS/exe.dev
drivers. The direct PostgreSQL and inbound HTTP topology described below remains the legacy
configuration. Historical qualification below does not qualify the portable protocol.

Historical isolated single-server checks covered selected Linux browser, membership, MCP, replacement and restore-read flows. This is not overall acceptance. Host operations and private deployment receipts belong in the installation's infrastructure repository.

## Ownership and boundaries

The backend owns authenticated HTTP/SSE, company/project directories, definitions, skills, grants and connection administration. Each conversation worker owns exactly one logical Pi PostgreSQL store containing its collaborating agents, private context and execution. Pi retains scheduling and durable recovery ownership. The launcher manages containers, not Pi tasks.

The existing runtime combines catalog and conversation mutations in Pi transactions. Splitting those transactions requires explicit durable command receipts and revisioned catalog propagation; copying a whole catalog into workers without update/revocation semantics is not sufficient. Preserve membership checks, connection revocation, management grants and apply-to-existing behavior. Native single-runtime mode stays supported.

**Rolling-deployment scope change, October 9, 2026; deployed, native replacements observed:**
The maintainer authorized safe controller overlap. The original single-owner rehearsal and
ordered installation-drain procedure below are historical rehearsal evidence.
Instance retirement must be separate from explicit installation-wide drain and
must not retire conversation workers. Readiness must represent the ability to serve
through functioning ownership; merely listening or passing liveness is insufficient.
See the [current work package](handoff.md#workers-and-deployment)
for handover and rollout acceptance. Preserve one executor per conversation;
broader failover/HA qualification below is not added to this package.

## Launcher lifecycle contract

Private authenticated control API; no public ingress. Only launcher has Docker access. Neither backend requests nor workers can choose arbitrary images, mounts, capabilities or commands. Operator configuration pins the worker image and allowed network/resources. Worker credentials are scoped separately from launcher control credentials.

- Ensure an attempt: backend persists conversation identity, immutable attempt ID and desired configuration revision before requesting launch. Repeating the same attempt reconciles its labeled container; changed inputs conflict. Timeouts never allocate a new attempt. Container identity includes installation and attempt; enumeration is scoped to the installation.
- Inspect an attempt: returns observed created/running/stopped/unknown state and container identity, not merely desired state. Unknown and unreachable block replacement.
- Stop an attempt: persist stop intent before acting; disable automatic restart, stop/kill as required and confirm termination before reporting stopped. Late ensure retries must not revive a stopped attempt; retain a terminal tombstone.
- Drain installation: persist admission-disabled state, reject new launches, stop all known attempts and reconcile installation-labeled containers. Return complete only when none can execute; launcher restart preserves drain state. Unreachable Docker is not successful drain.
- Status: installation identity, admission/drain state, active workers, outstanding attempts and unresolved operations, available through authenticated local access. Explicit maintenance drain requires authenticated undrain after verification; ordinary rolling updates use controller handover without installation-wide drain.
- Backup additionally requires backend write quiescence: reject new mutations and drain admitted auth/catalog/connection writes before capturing their state. Launcher drain alone cannot establish a consistent application backup.

Application drain ordering is:

1. Persist closure of public admission and settle admitted public/background writes.
2. Drain and confirm retirement of workers while model-auth, artifact and management support callbacks remain available.
3. Quiesce remaining backend support requests before reporting backup readiness.

Blocking support callbacks before worker close can turn unfinished work into service errors. Before a consistent backup, verify fresh quiescence: persisted admission closure alone is insufficient. Status must include `drained: true`, `drainComplete: true`, `backendQuiesced: true`, zero active workers/unresolved attempts and matching installation identity. Full live external-OAuth writer quiescence remains unverified.

Deployment shutdown calls `Harness.close()` through runtime close, not the user-facing Stop operation (which deliberately cancels work). This preserves unfinished durable work for recovery; the scoped deployed Docker SIGKILL recovery check below passed, while host failure and broader recovery qualification remain open. Container termination must still be confirmed separately before replacement. Launcher `close()` closes the controller only; it does not retire workers.

Archive changes a person's chat visibility and preserves history and ongoing work. Use Stop for cancellation.

This rehearsal is ECS-shaped, not evidence of scalable ECS operation. Routing journals and exclusive ownership locks are currently local to a single backend/launcher; replicated control planes require shared coordination and fencing, not merely substituting ECS API calls for Docker. AWS networking/IAM, task failover and load qualification remain separate follow-up work.

A single launcher serializes installation lifecycle mutations. Its own exclusive ownership and durable journal must survive restart. Docker restart policies for dynamic workers must not compete with this state machine. Database advisory locks supplement, not replace, process termination. Container termination cannot cancel an external request already accepted elsewhere; exactly-once external effects are not promised.

## Optional ECS warm spare — October 14, 2026

The ECS driver accepts `warmSpare: true` (default false). Its single launcher owner
maintains one unassigned task at the pinned configuration revision, reconciling
every five seconds. The process loads the application modules and listens privately
on port 8831 without opening a conversation store. A scoped credential permits
only readiness and one-time assignment; no store credentials or launcher signing
key are delivered to the spare.

On ensure, a ready spare is transferred to the immutable conversation attempt in
the existing durable launcher journal **before** assignment is sent. Its physical
ECS task ARN and original tags stay unchanged; `warmOrigin` in the journal maps
that identity to the assigned attempt. Matching assignment retries are safe;
different assignments conflict. Once assigned, the process follows ordinary
conversation bootstrap and never becomes a spare again. The pool replenishes on
the next reconciliation tick. Chats arriving while capacity is starting take the
ordinary cold-launch path; one ready spare is a target, not a burst guarantee.

Launcher status includes `warmSpare.enabled`, `suspended`, `ready` and the spare
attempt ID when present. A running ECS task is not sufficient: `ready` probes the
authenticated unassigned listener. Lost launch outcomes retain the existing
no-blind-RunTask-retry rule. Assignment uncertainty reconciles the same task; it
never allocates a second executor. Existing attempts retain their ordinary stop,
tombstone and confirmed-termination requirements.

Controller retirement leaves the spare alive for the successor owner. A changed
configuration revision, immutable launch fingerprint (including task definition),
or disabled option retires unassigned capacity; assigned
workers remain intact. Installation drain suppresses replenishment and retires
all tasks. Explicit activation resumes admission and replenishment, including
clearing suspension recorded by older installation-sleep implementations. Retain
compatible launcher images while warm records exist; do not delete journals to downgrade.

The AWS module owns the option, private launcher-to-worker TCP 8831 rules and
worker sizing. The caller owns its additional running cost and deployment
evidence. Source/type/build checks do not establish live claim, replenishment,
restart recovery or latency acceptance; record those observations in the
installation's deployment receipt.

## Mention invitations — October 15, 2026

Human sends containing agent-definition mentions now validate the worker's message
input and prior receipt before the backend admits the corresponding invitation.
The invitation uses a stable, message-scoped request ID. The subsequent worker RPC
reconciles backend membership before posting with the original message fingerprint.
A completed message retry skips invitation admission, including after its mentioned
agent has been removed. Invalid threads, attachments, participant mentions and
currently ambiguous definitions are rejected before adding participants.

Workers resolve those mentions against admitted participants and never create an
unregistered local instance. Native single-runtime mode retains its transactional
invite-on-send path. Directory admission and worker publication remain separate
commits: an admitted invitation survives a failed send and its unchanged retry
reuses the receipt. This is not a cross-store transaction or automatic resend.

The controller and worker must both include this change; older workers reject the
new validation RPC. Existing unregistered participants require a separately
reviewed identity-preserving repair; the code does not infer backend authority from
worker-local identities. Source/type/build checks are recorded with the change.
The new distributed send path has not yet been qualified in a deployed browser.

## Automatic conversation-worker retirement — October 14, 2026

The backend checks assigned workers every 30 seconds. Its `workerIdleTimeoutMs`
setting defaults to **3600000** (sixty minutes); **0** disables new automatic
retirements while still reconciling previously recorded ones. The Terraform module's
optional `worker_idle_timeout_seconds` supplies this setting in seconds. The
unassigned warm spare, backend, launcher and database remain running. This changes
conversation compute cost, not the installation's fixed or idle database costs.

The initial ten-minute default was superseded by the maintainer's sixty-minute requirement
on October 14, 2026. Existing installations with an explicit timeout retain that
configured value until their deployment inputs are updated.

The worker measures time since native state changed using a process-local monotonic
clock; a process restart starts a fresh grace period. Read-only chat polling and
summary heartbeats do not reset it. Before retiring, it seals and joins RPC/summary
admission, checks every native task and unsettled submission plus pending local
reconciliation/reporting, and closes only after the full idle interval. Active,
waiting, blocked, background and queued work cannot be cancelled to create idleness.

Retirement is ordered with that conversation's RPCs, while other conversations and
worker support callbacks stay available. The backend records the exact attempt and
idle decision before requesting closure. A busy refusal removes that intent; an
uncertain response retains it for reconciliation by the next sweep or explicit
conversation action. The launcher must confirm irreversible termination before
the route becomes sleeping or a fresh attempt opens the retained store. A timeout
alone never authorizes a replacement, and uncertain user mutations are not replayed.

An already-open chat keeps its last public snapshot and authenticated stream while
sleeping; background polling does not restart compute. Explicitly opening/reloading
the chat, reading additional history or taking a conversation action can start a
fresh worker. Authorization is rechecked while the stream sleeps and before every
new action. Sleeping list entries retain their final observed status instead of
reporting a missing heartbeat as an execution failure.

Workspace files remain disposable under the existing cloud workspace policy.
Agents must commit and push useful work and publish required artifacts before
finishing. Database history and S3 attachments survive retirement; local-only files,
installed packages and unpushed commits do not. This adds no workspace snapshot or
forced Git publication mechanism.

Deploy compatible backend and worker images together. Existing older workers do
not advertise timed-retirement support and are left running; replace them through
the existing safe lifecycle after their work is preserved. Newly launched compatible
workers use the timer. Retain a compatible backend after its routing journal records
the new idle-retirement/sleeping fields; do not remove journal entries to downgrade.
Type/build and runtime acceptance are recorded separately in the task's delivery
record; this contract alone is not evidence of an AWS rollout or measured savings.

Interactive qualification on October 14 used the Nix-built AMD64 image
`sha256:7d2aa0dfa80a82387911a17a0e834e1bf559824c55ec78c68f8149a70b9ea0a4`
in an isolated Docker stack on the operator Mac, with PostgreSQL 17.6 and a shortened
15-second timeout. An open human-only chat reached a persisted sleeping route and
zero running conversation containers; its next message used a different attempt
and retained both messages. A real Claude Haiku tool call running `sleep 90` stayed
on the same running worker beyond the threshold and returned successfully. This
qualifies ordinary idle/resume and active-tool refusal in that environment. Lost
responses, owner handover during retirement, queued/background-task variants and
AWS retirement remain separate acceptance cases; no automated application tests
were added or run.

## Installation lifecycle

Whole-installation sleep was retired on October 16, 2026. The former sleep gate
and its sleep/wake runbook are removed; ordinary releases do not depend on that
gate. Automatic conversation-worker retirement leaves controllers and warm
capacity available. Normal activation, controller handover, drain and graceful
shutdown retain their existing contracts. `/internal/drain` cancels native work;
it is not an idle-only replacement for the removed feature.

## ECS follow-up plan (proposed, not deployed)

The accepted AWS target preserves these application contracts. The following is an implementation sequence, not a qualified AWS design or authorization to apply it:

1. **Stable services:** ALB/ACM HTTPS to an ECS backend service; private RDS PostgreSQL for Pi stores and ordinary S3 for artifacts; digest-pinned ECR images with separately qualified ARM64/AMD64 runtimes. Keep provider/OAuth administration backend-only. Existing backend authentication, connection and directory persistence must first gain supported shared storage/ownership; placing local SQLite files on several replicas is not a scaling strategy.
2. **Shared control plane:** move routing/attempt receipts, terminal tombstones, installation admission state and mutation ownership into transactional shared storage (proposed: PostgreSQL). Use compare-and-swap ownership generations for every route mutation/callback, durable operation IDs and recovery reconciliation. Expiring a lease does not prove the old executor is dead; uncertain ownership blocks replacement. Backend replicas need consistent authorization and streamed-result routing without assuming local process memory.
3. **ECS launcher adapter:** run private control service replicas against that shared coordination. Map immutable attempts to standalone Fargate `RunTask` calls, persist task ARN and attempt tags, and reconcile ambiguous launches through observed ECS state. `StopTask` must be followed by confirmed task termination before replacement; event notifications are hints, not sole authority. Workers are not per-conversation Terraform resources or desired-count services that independently restart executors. Preserve Pi store advisory locks as an additional guard, not proof of task termination.
4. **Network and identity:** private task ENIs, narrowly scoped security groups, no public worker/control endpoints, and authenticated attempt-bound RPC/callbacks. Launcher IAM permits only the approved cluster/task definitions and exact execution/task roles; workers receive no ECS control permissions or shared database-owner credentials. Backend provisions scoped store credentials. Select and qualify one-time bootstrap/scoped secret delivery without exposing keys in task tags, logs or published definitions. Keep artifact access backend-mediated unless a separately reviewed scoped capability replaces it. Include model/MCP egress controls and NAT/VPC-endpoint costs in the plan.
5. **Capacity and recovery:** scale backend/control replicas only after shared ownership is implemented; admit on-demand workers under explicit conversation/resource quotas, launch backpressure and RDS connection budgets. Choose idle retirement policy separately from interrupted-work recovery. Reconnect streams through durable conversation state, not sticky ownership assumptions. Observe launch latency, unresolved attempts, drain latency, DB saturation and stale summaries; summary expiry must never trigger replacement by itself.

Before production AWS rollout, obtain authorization for the actual infrastructure/cost plan, then qualify simultaneous ensures/stops, controller loss during launch/stop, backend/task restart, network partitions, RDS failover, stale callbacks/revocation, multi-AZ recovery, full paired restore and sustained load. Demonstrate no overlapping executors and preserve unsafe-tool recovery boundaries under those faults. ARM64 packaging alone is insufficient. Source implementation and isolated trial observations do not establish that these AWS checks passed.

### AWS module and fresh-install acceptance

The customer-neutral [AWS module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch)
owns infrastructure, generated configuration, operator access, installation and
update instructions. Dispatch owns the runtime/bootstrap contracts. Installation
accounts, domains, secrets, task identities and receipts belong exclusively in
caller repositories. The module's extraction does not establish public image
availability or a fresh-account installation.

Fresh-install acceptance requires an independent caller using released artifacts
and the module guide to initialize and activate the installation, enroll/sign in,
create a chat, execute a model/tool turn, reload retained history and exercise
replacement after confirmed old-executor termination. Controller liveness alone
is insufficient. Preserve exact module/image versions and scoped outcomes in
sanitized qualification records; private account material stays outside source.

## Host-independent control plane

The reusable controller contracts below supersede earlier installation-specific
staging discussions. Shared PostgreSQL ownership, fenced controller handover,
verified TLS and scoped worker bootstrap remain separate boundaries. Provider
and MCP credentials stay in the backend; code publication does not qualify a
caller's secret delivery, network policy or restore procedure.

See [backend recovery](../server/workers/backend-recovery.md),
[database initialization](../server/workers/database-init.md) and
[bootstrap](../server/workers/bootstrap.md) for the maintained application
interfaces. Retain installation receipts and private configuration in the
operator's infrastructure repository.

## Integration deliverables

The application repository owns routing, RPC, authorization, packaging and recovery interfaces. Installation repositories own infrastructure, credential delivery and deployment evidence. Verify the integrated configuration rather than treating a component handoff as deployment acceptance.

### Entrypoints and private configuration

These entrypoints exist in source; their presence does not establish a running stack. Paths below are relative to `packages/web/` after build.

| Nix wrapper | Node entrypoint | Configuration |
| --- | --- | --- |
| `dispatch-backend` | `build/service/server/workers/backend-main.js` | Normal Dispatch configuration plus `DISPATCH_BACKEND_WORKERS_CONFIG_FILE` |
| `dispatch-launcher` | `build/service/server/workers/control-main.js` | `DISPATCH_LAUNCHER_CONFIG_FILE` |
| `dispatch-worker` | `build/service/server/workers/worker-main.js` | Trusted driver-generated environment; internal port 8831 |

**Rolling-controller configuration (source-published in `8fb001f`; not rollout acceptance).**
Backend and launcher entrypoints opt into planned handover when
`DISPATCH_CONTROLLER_CONFIG_FILE` names a restricted JSON file. Their existing
owner configuration remains required; omitting this variable retains the legacy
entrypoint path. The additional file has these fields:

- Required `databaseConfigFile`, `tokenFile` and integer `port` (1–65535).
  The database file uses `{installationId, databaseUrlFile, databaseCaFile}` and
  selects the role's scoped PostgreSQL database with verified TLS. Provision a
  separate controller peer token; the trimmed secret must contain 43–256
  URL-safe alphanumeric, underscore or hyphen characters. Do not reuse worker
  derivation keys or publish token values.
- Optional `host` defaults to `0.0.0.0`. Optional `endpoint` identifies this exact
  listener, not an ALB or shared discovery name, and must match its port. When
  omitted, startup reads `ECS_CONTAINER_METADATA_URI_V4`, requires exactly one
  `awsvpc` IPv4 address, and derives the direct URL using `port` and listener TLS.
- Optional listener `tls: {keyFile, certFile}` requires
  `peerTls: {caFile, serverName}`. Peer HTTPS verifies the supplied CA and expected
  certificate DNS identity while connecting to the selected task address;
  listener and peer transport must agree. File fields above use absolute paths.
  Deliver private files through the existing [bootstrap contract](../server/workers/bootstrap.md),
  with separate backend/launcher secret maps; workers receive neither bundle.

The private `/internal/ready` returns only 200/503. A successor stays unready until
fresh ownership activation; liveness is not readiness. Managed backend/launcher
withdrawal and drain budgets, caller URL migration, and separate accounting for
ALB-bypassing peer/worker connections remain deployment prerequisites. Existing
workers keep their pinned backend URL; do not retire them merely to replace a
controller. See the [handover work package](handoff.md#workers-and-deployment)
and [explicit recovery procedure](../server/workers/backend-recovery.md) before activation.

Backend JSON contains `{installationId, workerKeyFile, launcherTokenFile, operatorTokenFile, launcherUrl, configurationRevision, artifacts, postgresStores: {adminUrlFile}}`. Optional backend `launcherTimeoutMs` defaults to `300000` (integer range `1000`–`3600000`). Set it above the full launcher lifecycle window, including multi-worker drain; ordinary worker RPCs retain a 60-second deadline. Timeout is ambiguous, not permission to retry a mutation or start a competing owner: reconcile the same attempt with fresh retirement evidence. Launcher JSON contains `{installationId, stateDir, tokenFile, workerKeyFile, host, port, driver}`. Keep configuration and secrets in restricted files; do not publish real values or pass tokens in argv. Backend/launcher share the private installation HMAC key; each worker receives only a derived token bound to its immutable launch identity. Backend validates the current route/attempt before returning company-scoped bootstrap state. Provider OAuth resolution belongs to the backend, not copied worker auth files; refresh/revocation behavior remains an integration requirement.

**ECS POC configuration contract.** The standalone AWS module owns generated deployment configuration; fresh-install acceptance is recorded separately above. Launcher `driverType` defaults to `"docker"`; select `"ecs"` explicitly and use PostgreSQL journal configuration, not `stateDir`. ECS `driver` requires `region`, worker-only `cluster` ARN, revision-pinned `taskDefinition` ARN, `containerName`, private `subnets`, `securityGroups`, `configurationRevision`, and an `environment` map containing `DISPATCH_BACKEND_INTERNAL_URL`. Optional `platformVersion` defaults to `"1.4.0"`, `requestTimeoutMs` to `30000`, and `retirementTimeoutMs` to `180000`. The driver uses the launcher task's IAM credentials; no static AWS key is required in configuration. Backend/launcher services use a separate cluster: unexpected/untagged tasks in the dedicated worker cluster fail inventory closed. Worker task definitions run `dispatch-worker`, expose internal port 8831 and provide writable disposable `/workspace`. The generic module and caller root own task-role policies, security groups, task definitions, bootstrap maps and immutable image pins.

Launcher bearer-authenticated routes are `/v1/status`, `/v1/ensure`, `/v1/reconcile`, `/v1/stop`, `/v1/drain`, `/v1/undrain`. Backend operator bearer-authenticated routes are `GET /internal/status` and `POST /internal/drain`, `/internal/undrain`, `/internal/replace`. Source `3a90b6d` adds private unauthenticated `GET /internal/health`: `200 ok` is process liveness only, independent of admission and retaining the internal Origin guard. It neither opens admission nor establishes operational readiness. Replacement accepts `{conversationId, attemptId}` and requires fresh confirmation that the old attempt is stopped and its container absent before allocating another. HTTP 200 with `phase: "pending"` acknowledges the new route intent, not worker or application readiness; ordinary activation launches/reconciles that immutable attempt. Since source `2af774a`, backend-local `runWorkerTransition()` joins earlier activation/RPC reads and blocks later reads through the distributed policy writer before entering the MCP gate once. Keep operator-transition/admission outside this writer and fresh route matching inside it; nesting another MCP writer would deadlock. This adds no public operator API and relaxes neither retirement fencing nor stale-attempt errors. A generic HTTP 503 is not proof of no effect or rollback: failures can occur after retirement or route mutation. Correlate the retained route's attempt/phase, authenticated launcher state and actual ECS termination before further mutation; do not blindly replay the old request. Ordinary route activation can also allocate a replacement after confirmed stopped/absent evidence, so later continuity does not retroactively establish a successful operator acknowledgement. Do not expose `/internal/*` through public ingress. Host helpers, DNS/HTTPS, concrete installation values and cold-maintenance/storage-restore evidence belong in the installation's runbook (private installation record).

The `workers-oci` Nix image variant preserves the existing default `oci` image and declares no anonymous volumes. Configure worker driver `user: "65532:65532"` and `workingDirectory: "/workspace"`; worker disks are disposable. Only the launcher has the Docker socket.

### Catalog and artifact ownership

Backend directory-only runtime must neither construct conversation agents nor resume Pi scheduling. `openConversation(options, bootstrap)` seeds a company-scoped revisioned catalog before resume and durably binds the external conversation/store to one native room ID. Backend routing maps external chat IDs to that room. Bootstrap must project catalog, membership and initial revision pins from one directory transaction. Authenticated route-bound initialization must survive original-creator revocation without regranting that creator access; immutable creation identity is not current authorization. Runtime slice `eee78ee` implements this atomic projection and route-bound initialization; Creator-revoked replacement passed below; first-ever startup and concurrent HTTP/Docker bootstrap remain unqualified. Catalog updates reject stale/conflicting revisions and preserve transcript/participant configuration. Snapshots alone do not prove immediate authorization revocation; cross-store management needs durable store-qualified command receipts and no worker-local save fallback.

Membership is backend-authored and revisioned in source: persist invitation intent, actor/revision pins and public notices before worker delivery. Workers apply the returned catalog then membership snapshot before resume/commands; lost delivery reconciles on a later request or replacement without duplicating agents/notices. Agent invitations use backend-owned authority and durable receipts, fail closed without the backend callback, and must not synchronously call back into a waiting worker transaction. The scoped deployed human/API invitation and creator-revoked replacement check below passed; first-ever startup, agent-tool invitations and concurrent bootstrap remain unqualified.

Remote Git stores source, PostgreSQL stores Pi state, and ordinary S3 stores artifact bytes. Worker Pi metadata references immutable blobs; workers use authenticated conversation-scoped artifact RPC and receive no S3 credentials. Backend namespaces objects by the authenticated route/store, never a supplied native conversation ID. Worker conversation open requires a remote attachment store; it must not silently fall back to worker-local bytes. Native installations retain their local default.

The backend `artifacts` object is `{endpoint, region, bucket, prefix}` plus exactly one credential mode: `credentialsFile` or `taskRole:true`. File mode uses restricted regular-file JSON `{accessKeyId, secretAccessKey, sessionToken?}`. The ECS candidate's task-role mode requires the regional endpoint `https://s3.<region>.amazonaws.com` and uses the AWS SDK credential chain; grant only backend-scoped artifact authority through the task role and do not inject static AWS credentials. Workers still receive no S3 credentials. The SDK uses path-style addressing without transparent retries or local fallback. The isolated rehearsal uses Garage, a self-hosted S3-compatible object store for attachment/artifact bytes, not AWS provisioning; actual S3 save/read, store-isolation and client-reopen checks passed. Later browser, replacement and isolated restore receipts below qualify their respective Garage artifact flows, not AWS S3 or off-machine durability.

Scoped storage provisioning is wired in source (deployed direct-SQL isolation and scoped real-worker integration passed): backend alone receives `postgresStores.adminUrlFile` for a dedicated worker database owner with `CREATEROLE`, not superuser authority. Authenticated bootstrap supplies per-store `access: "worker"` credentials; workers no longer read `DISPATCH_POSTGRES_URL`. Launcher/worker environments must contain no shared PostgreSQL URL. PostgreSQL RLS must bind row access to the authenticated session user through an owner-controlled role/store mapping. Worker roles get row DML only, with no ownership, DDL, TRUNCATE, role administration or RLS bypass; worker storage skips migrations and verifies its binding. Provisioning runs under backend support-write admission. Native storage and existing trials remain unchanged.

Consistent backup covers backend authentication, connection, routing and launcher state; PostgreSQL including provisioned roles; separately protected derivation/encryption keys; and artifact bytes while writers are quiesced. Keep root keys in separate encrypted escrow and link each recovery point to its required key versions. An exclusion from a data archive is not proof of recoverable secret coverage.

Maintain an explicit secrets manifest covering TLS identities, signing/derivation keys, tokens, database URL files and provider/backend root keys. Retain the backup access credentials independently of captured paths, command arguments and logged environments. Verify restored ownership/modes, exact data/key pairing and application recovery separately. File pairing or archive integrity alone does not qualify a restored installation. Concrete locations, escrow identities and recovery receipts belong in private operator records.

Isolated restore must verify expected TLS/key ownership and modes (provider key `0600 65532:65532`), credential decryption, worker-token validation against the restored signing key, resolved attachment references and continued denial of retired owners/executors. Wrong/missing key versions must fail closed before activation; qualify recovery of an older snapshot with its matching older escrowed key while a newer key is current, without implying online rotation is supported. Disposable worker workspaces are not backup inputs. A local S3-compatible service or replacement check does not establish off-machine durability.

Inspected Expert's `1525013-restore-report.json`: seven macOS ARM64/Node 24.21.0/PostgreSQL 17.11/Pi 1.0.4 component checks record cold logical dumps after source owners closed and zero sessions, transactional restore to fresh nonsuperuser owners, matching-key credential recovery via public `Models.getAuth()` and loopback MCP HTTP, wrong/empty-key refusal, uncertain-intent denial, pending callback single-use and durable disconnect. Retired principals' new connections were denied only after source sessions had closed. Same-cluster fixtures used verified TLS with HBA trust: not production password authentication, encrypted Restic/independent escrow restoration, Linux/backend lifecycle or restored model/tool execution. Full paired recovery remains open.

### Open integration gaps

The routing adapter preserves SQLite compatibility, synchronous committed reads and process-local summary freshness. PostgreSQL cache reads fail closed on connection loss, fresh journals start drained, and explicit owner recovery requires confirmed retirement. There is no automatic takeover.

The adapter keeps `get/list/readSummary/admissionBlocked` synchronous; callers await `ensure/ready/retiring/replaceRetired/updateSummary/setAdmissionBlocked/close`. Mutations serialize, revalidate the attempt and publish cache changes only after commit. `workers/routing-config.ts` reads `{installationId,databaseUrlFile,databaseCaFile}` without an encryption key; owner recovery is invocation-only. Database or uncertain-commit failure permanently denies cached reads, and failed close retains the recovery latch.

Callers match installation identity, apply persisted drain before refresh and reconcile workers independently. Routing ownership does not fence an executor. See [routing storage](../server/workers/routing-storage.md); the loader does not provision databases, import SQLite, silently fall back or activate an installation.

**Startup and shutdown.** Check installation identity before opening state, load persisted admission early and attempt remaining cleanup after a cleanup error. Preserve support/credential admission until workers are confirmed retired while public admission stays closed. Apply current authentication and authorization gates during activation and recovery; source review alone does not qualify live shutdown.

**Inspected entrypoint evidence.** Expert’s `3419536-backend-report.json` records eight scenarios using actual backend subprocess/HTTP routes and six disposable PostgreSQL databases: loader selection, drained startup/restart, explicit undrain, persisted drain, owner/session release, shutdown retry, wrong-key startup cleanup and mismatched-launcher denial. `18f1a08-backend-baseline-report.json` reproduces a 503 support callback during unresolved retirement; the fixed candidate returns 200 while public admission stays closed. Limits: macOS ARM64, verified PostgreSQL TLS with fixture HBA trust, backend HTTP loopback, seeded session, launcher double and synthetic MCP fixtures; S3 opens without object operations. Not fresh sign-in, Linux/Docker retirement, hosted model/tool work or encrypted application restore.

**Explicit controller recovery.** Require the matching PostgreSQL configuration, exact expected owner identities and independently verified backend retirement. Persist public admission closed before opening credentials. An operator confirmation is an assertion, not executor fencing. Keep recovery arguments out of retained service configuration; inspect the stopped owner and prevent automatic supervisor restart before using the [recovery CLI](../server/workers/backend-recovery.md). Worker retirement is a separate operation. Recovery source and component checks do not establish all live failure paths.

Membership synchronization, MCP actor authority/rollout and durable summaries have scoped deployed HTTP/Docker evidence below; first-start/concurrent-bootstrap and external OAuth boundaries remain open. Membership MCP pins carry `{connections,extensions,tools}`; ordinary definition saves preserve existing selections, while explicit rollout changes only MCP selections, not instructions/model/cwd/history or original revision labels. `authorizeWorkerMcp(claim,connectionId,toolName)` resolves backend pins and current managed authorization for the exact connection/extension/registered Dispatch tool. Executable MCP preparation/callback wiring (`af7ad4b`, `f3477ee`) is implemented locally with loopback component checks; ordered invocation/revocation and activation-versus-policy-acknowledgement are implemented at `7c13c44`/`d606f09` with component evidence, with later deployed held-call/delayed-body/revocation checks passing; immediate backend-authoritative project authorization remains open. Authorized list merging (`7f3fe8e`) and admission-tracked callback delivery (`30c4f5b`) are now implemented locally; Later deployed summary/list delivery and freshness checks passed below.

`workerSummary()` projects `{revision,updatedAt,status,error?,suggestedTitle?}` from the bound room without reauthorizing its creator. Its durable worker-local revision advances only for changed content. Routing persists observations under current attempt/store fencing; replacement retains historical observations marked stale until the new attempt publishes. Stale status is not current liveness. Backend-owned ACLs/preferences/title overrides must remain authoritative, and list reads must not start dormant workers. Automatic-title eligibility is read atomically with authorized entries: only `displayTitle === undefined && title === "New conversation"` permits a suggestion; an explicit user title with that text must be preserved. Receipt-age freshness (`e6a1907`) uses process-local monotonic receipt time, expires after 10 seconds and resets on backend reopen. Validated/persisted identical retries refresh it; rejected publications do not. Retirement fencing alone cannot detect a silent crashed worker, and observation freshness is never replacement authority. Deployed pause/expiry/resume verification at `7caa835` passed: inspected `.local/worker-qualification/live-summary-freshness-result.json` confirms unavailable status, retained historical title/time and fresh publication from the same unpaused idle worker. This is not crash or executor-fencing evidence. Summary polling may write a projection receipt and must be admission-tracked. External OAuth refresh/revocation and broader cross-store management receipts require integrated qualification; scoped Docker interrupted-tool recovery passed below. Do not drop these requirements from acceptance or treat catalog snapshots, TypeScript or component checks as proof.

Source review also requires enforcing storage isolation below application query predicates, backend-verifiable management actor authority, and admission/shutdown tracking for MCP discovery/refresh, reconnect credential renewal and catalog callbacks before backup readiness. Durable resolved creation choices, directory/routing crash reconciliation, consistent external-ID translation and a fresh-workspace notice before resumed model work remain recovery requirements. Successful revocation must join previously admitted MCP calls and deny later unauthorized calls; it cannot reverse upstream effects. Activation/RPC admission and policy mutation plus acknowledgement need coordinated ordering so a concurrently starting worker cannot accept a delayed old-policy RPC after revocation returns. Bootstrap/definition callbacks must remain available during reconciliation to avoid deadlock. The local ordering correction waits for earlier activation/RPC operations, then performs mutation plus acknowledgement inside the MCP policy gate; later operations wait and reauthorize while independent conversations remain concurrent. Missing launcher attempts must be stopped/tombstoned and verified absent, not skipped. Failed acknowledgement without confirmed retirement returns failure; another catalog fetch alone is insufficient. Component checks do not establish the deployed ordering boundary. Callback authority must also be checked at use time: revalidate the current route/attempt/token after POST body parsing, inside MCP invocation admission, and after asynchronous authorization/reconnect immediately before upstream invocation. An earlier authentication check cannot authorize a delayed callback from a retired attempt. The October 8 source-review finding blocked `d606f09` activation. Corrections revalidate all POST callbacks after parsing (`0445420`), require invocation-time `assertCurrent` through the native MCP-client handoff (`7caa835`), and join admitted MCP calls before replacement retirement (`3f40a82`). Replacement still independently requires stopped/absent confirmation. Local call settlement is not proof of remote-effect completion after transport failure; the scoped deployed HTTP/Docker held-call/delayed-body/revocation check below passed, but external OAuth and full concurrent membership/recovery acceptance remain pending. These are blockers, not limitations waived by a private startup rehearsal.

## Worker Spot and service tracing — October 10, 2026

Authorized baseline extension: the ECS driver accepts `capacityProvider` as
`"FARGATE"` (default) or `"FARGATE_SPOT"`. It submits a single-provider strategy,
not `launchType`, and includes provider selection in the immutable launch
fingerprint. The owning infrastructure must associate both providers with the
worker cluster; controllers remain On-Demand. A changed provider applies to new
attempts, never to an already running worker. Spot capacity is not guaranteed;
interruption does not relax exact-task reconciliation, no uncertain-call replay
or confirmed termination before replacement. Workspace recovery remains the
disposable-disk policy, not checkpointed
external effects or an automatic persistent-filesystem promise.

Explicit service tracing uses `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
`OTEL_SERVICE_NAME` and `OTEL_TRACES_SAMPLER_ARG` (default ratio 0.1). Without an
endpoint, collection is disabled. Hosted ordinary backend/launcher/worker tasks
export through loopback ADOT to X-Ray; operator tasks/credential terminals are
excluded. HTTP/RPC spans propagate W3C traceparent and use X-Ray-compatible IDs.
HTTP/SSE spans measure response-header latency without wrapping streams; they do
not measure completion or model token latency. Only the outer request boundary emits sampled structured request-summary logs;
nested owner spans remain without duplicate summaries. Logs contain registered
route templates, method/status/duration and trace identities,
not raw URLs/query strings, headers, user identifiers, SQL, model/tool payloads or
Pi's native durable traces. Health polling is excluded; export shutdown is
bounded/best-effort after owners close. Telemetry must not retry application
operations or let an incoming sampled flag override local collection policy.

The managed CloudFront path disables backend SPA serving, preventing unknown API
routes from becoming `index.html`. CDN cookies/origin enforcement, actual exported
spans, Spot interruption and streaming/rolling behavior still need runtime
qualification; TypeScript/build/source review alone establishes none of them.

## Acceptance and evidence

Historical isolated Linux checks covered separate conversation workers,
confirmed retirement before replacement, retained committed histories and
attachments, membership changes, scoped store isolation, and selected MCP and
recovery paths. Separate ARM64 runtime/container checks covered a narrower set.
These results did not establish all provider lifecycles, host failure, sustained
load, external OAuth quiescence or complete restoration of active work.

Qualify each installation with its actual immutable artifacts and configuration:

- Confirm old executor termination before admitting a replacement. Preserve
  completed results; do not replay uncertain external effects automatically.
- Reconcile ambiguous launch/stop responses using the same attempt identity.
- Verify company/project membership, revocation, grants and catalog propagation
  across active and dormant conversations.
- Check database-enforced store isolation and complete paired backups, including
  keys, controller state, provider authorization and artifact bytes.
- Verify real model/tool execution, browser streaming/reconnect and independent
  conversation replacement within the authorized verification scope.

Keep exact installation IDs, hostnames, operator paths and raw receipts private.
The [portable-worker qualification](portable-worker-qualification.md) records the
newer opt-in protocol separately; it does not retroactively qualify legacy paths.
