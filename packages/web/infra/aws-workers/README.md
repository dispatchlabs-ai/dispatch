# Conversation-worker AWS module

**Retained POC candidate, October 8, 2026; not deployed or AWS-qualified.**
This is the worker/PostgreSQL topology, not the older sibling `../aws` module's
SQLite/S3 Files deployment. Installation account, domain, backend state and secret
values belong in a separate company-owned consumer repository. That caller owns
its exact deploy/rollback commands, build-host setup, release digest selections
and rollout receipts; this module documents only reusable application/infrastructure
contracts, without a company-specific deployment entry point.

## Resources and runtime

- Dedicated VPC, two public and two private subnets, one NAT gateway and S3 gateway
  endpoint. Single-NAT egress is not multi-AZ availability. Review the CIDR against
  live routing before applying. Tasks never receive public addresses.
- Separate stable-service and **worker-only** ECS clusters. Backend and launcher
  are count-zero by default, maximum one each; stop-first ECS replacement by default, no automatic
  rollback or ECS Exec. Workers are standalone launcher-owned `RunTask` attempts,
  never Terraform-managed conversation services. Database locks do not prove old
  task termination. Crash owners require the application's explicit recovery path.
  Optional `service_desired_counts` overrides accept only `backend`/`launcher`
  entries at `0` or `1`; omitted entries inherit `desired_count`. The default `{}`
  preserves shared counts. Use overrides for staged controller maintenance,
  reviewing each state-backed plan and confirming actual termination between stages.
- Private encrypted PostgreSQL 17, single-AZ `db.t4g.small`, 20 GiB gp3 (autoscaling
  up to 100 GiB), enforced TLS, seven-day backups and deletion protection. The
  generated RDS master secret is **operator-only**. Provision separate application
  roles/databases before activation; only the worker-store provisioner needs
  CREATEROLE. Workers obtain scoped credentials from the backend. Do not inject
  the RDS master identity into either service or workers. No initial application
  database is requested from `CreateDBInstance`: RDS rejected the former `dispatch`
  placeholder as reserved. The operator connects to `postgres` and separately
  creates the seven application databases.
- Private versioned AES256-encrypted ordinary S3; only backend task identity can
  read/write `artifacts/*`. No S3 version-read/delete/list or worker S3 grant.
  Noncurrent versions remain retained pending an explicit retention decision.
- Installation ECR repository with immutable tags and scan-on-push; caller pins
  the qualified image's registry digest. Publish that image into this repository;
  the execution role cannot pull arbitrary private repositories. `image = null`
  prepares foundation only. ARM64 is default; X86_64 is explicit.
- Optional ALB created only with a certificate ARN. Internal by default and no
  accepted client CIDRs by default. HTTPS 443 only, HTTPS target 3001, `/internal`
  and `/internal/*` denied at ingress. Caller owns certificate issuance/DNS and
  client routes; ALB TLS does not independently verify the backend certificate.
- `backend_health_check_path` defaults to `/` for older images. With an image
  containing `GET /internal/health`, select that private liveness path so an
  intentional drain does not trigger unhealthy-target replacement. Backend
  services attached to the ALB get 600 seconds of startup health-check grace;
  grace alone does not make a root-path check drain-safe. Liveness is not readiness
  or authorization to undrain, and public `/internal` remains blocked.
- Cloud Map names `backend.NAME.internal` and `launcher.NAME.internal`. Backend
  callback trust uses the application's request-local private CA, not globally
  expanded provider/MCP trust. Backend-to-launcher and backend-to-worker RPC are
  private authenticated HTTP in this POC, **not end-to-end encrypted transport**.
- Security-group references admit only the directed internal flows and PostgreSQL.
  Task outbound HTTPS is unrestricted by hostname. AmazonProvidedDNS is not
  filtered by SGs; no general VPC DNS-server rule is needed. Additional MCP ports
  need explicit review, not default all-port egress.

By default all tasks use `image`. `worker_image` optionally selects a separate
digest in the same authorized ECR repository. A short same-image `volume-init` container runs as
root without the app's secret/environment bundle, creates an empty marker in each
volume to prevent Docker repopulating empty-volume metadata, then fixes ownership
of only the three task-local volume roots `/data`, `/tmp`, `/workspace`, and exits successfully
before application startup. It has no application command or persistent mount.
ECS task-role identity is task-wide (including this trusted initializer), not an
OS-user boundary. Main containers run UID/GID 65532, read-only root, dropped
capabilities, init process and 120-second stop allowance. Workers' writable disk
is disposable. Actual Fargate mount behavior remains unverified.

For Ubuntu development workers, explicitly set `worker_image` and
`worker_package_installation = true`. Only the worker then runs UID/GID 0 with
writable root, ordinary container capabilities, no volume initializer and no
mounts hiding prepared image contents. All local disk is disposable. This mode
supports package installation and stock Pi cancellation, not hostile-code
isolation: coding tools can read their worker's scoped credentials and modify its
runtime. Controller settings, IAM, private networking, Exec-disabled behavior and
confirmed-STOPPED replacement remain unchanged. Mirrors must use HTTPS to fit
existing egress. Privileged mode, host mounts and nested Docker are not enabled.

Backend/launcher commands are `dispatch-bootstrap backend|launcher`. The public
`services` input carries rendered configuration and **exact secret ARN references**,
never secret values. Per-service execution roles fetch only their declared
Secrets Manager secrets; the worker execution role cannot fetch either bundle.
Reference the application's [bootstrap contract](../../server/workers/bootstrap.md)
for exclusive 0700/0600 materialization and environment removal. Raw encryption
keys are base64 inputs decoded to 32-byte files; retained secret versions must
match encrypted records. Configuration is not a backup.

## Controller deployment compatibility

Legacy application images require exclusive backend routing and launcher ownership.
A replacement backend cannot become ready while its predecessor holds the routing
owner lock (`server/workers/routing-database.ts`); the launcher has its own exclusive
owner. ECS deployment percentages alone cannot make these controllers safely overlap.
Keep application ownership and confirmed executor retirement intact; never remove
locks or infer termination from a failed replacement merely to complete a rollout.
Use ECS-native rolling replacement only for an application/service configuration
that supports overlapping ready tasks. Module settings, a successful plan and ECS
service stability do not independently establish zero downtime. Legacy controller
upgrades follow the ordered stop/start procedure below and incur an availability gap.

## ECS service deployment selection

`service_deployment_mode` accepts optional `backend` and `launcher` entries:
`"stop-first"` selects ECS minimum/maximum healthy percentages **0/100**;
`"rolling"` selects **100/200**. Omitted entries use `"stop-first"`. The map is
empty by default, preserving existing callers. Desired counts remain zero or one;
rolling allows ECS to run one temporary replacement alongside that service's owner.
Standalone conversation workers are not controlled by this option.

Rolling mode also opens only the selected role's peer traffic: backend-to-backend
TCP 3001 or launcher-to-launcher TCP 8830. Existing public ingress, cross-role
flows and standalone worker rules are unchanged. During launcher overlap, its
`ecs:RunTask` permission covers revisions of this installation's worker task family
only, still restricted to its worker cluster. This lets the old launcher use its
previous pinned worker definition while the new one starts; stop-first retains
exact-revision permission. Backend/worker identities gain no ECS launch authority.

For a rolling backend, the module ALB targets `/internal/ready` instead of the
legacy `backend_health_check_path`. A certificate/ALB is required so replacement
retirement cannot proceed on task RUNNING state alone. Public `/internal/*`
remains denied. A rolling launcher gets a loopback HTTP `/internal/ready` ECS
container check: 5-second interval/timeout, three failures, 300-second startup
period, with an internal 4-second request timeout. The controller image must
provide this endpoint on port 8830; no token or state payload is part of the probe.
Stop-first controllers retain their existing checks and networking.

These gates require the application handover contract: a new controller stays
unready until planned transfer and fresh-store activation finish, while the old
listener remains able to serve or forward until ECS retires it. Readiness must be
lightweight and bounded, not a full ECS inventory or a queued launcher mutation.
The endpoint reports 200 only for a functioning serving path and otherwise 503.
Liveness alone, an acquired SQL lock, or a merely listening standby is insufficient.

Introducing handover-capable images into a legacy exclusive-owner installation is
a separate one-time stop-first migration. Prepare and review that migration before
enabling rolling; changing these percentages cannot upgrade an old owner's shutdown
behavior. Subsequent rolling receipts must correlate old/new task identities,
readiness before retirement, preserved workers and sampled request availability.
No live migration or zero-downtime result is established by this module source.

**Do not select rolling for legacy exclusive-owner Dispatch images.** Both
require exclusive retained ownership, so a replacement cannot become ready while
the old owner runs. Enabling 100/200 alone can stall or fail deployment; disabling
owner locks is not a workaround. Retain ordered drain, confirmed retirement,
launcher-first startup and private readiness/undrain for these images.

A caller may opt a service into rolling only after its application supports safe
overlap and readiness-gated traffic/admission. The current `/internal/health`
endpoint is liveness, not such a readiness gate. The option supplies ECS readiness
gates, scoped peer networking and same-family worker launch permission, but does
not change application owner fencing, circuit-breaker rollback, secrets, database state
or admission behavior, and it does not establish zero-downtime operation. No live
consumer is switched to rolling by this module update.

## Reuse from a caller root

The caller owns its AWS provider/region, restricted Terraform/OpenTofu state
backend and provider lockfile. Pin this child module to an immutable commit;
there are no Surton account, domain or credential dependencies in the module.
This root-module example selects separate controller and Ubuntu worker images:

```hcl
module "dispatch" {
  source = "git::https://github.com/dispatchlabs-ai/dispatch-web-next.git//packages/web/infra/aws-workers?ref=7330a23d88e275331a62ce95415a042940d66b92"

  name               = var.installation_name
  availability_zones = var.availability_zones # exactly two distinct zones
  vpc_cidr           = var.vpc_cidr
  tags               = var.tags

  image                       = var.controller_image # repository@sha256:...
  worker_image                = var.ubuntu_worker_image # same authorized ECR repository
  worker_package_installation = true
  cpu_architecture            = "ARM64" # "X86_64" selects linux/amd64

  services                  = var.services
  secret_kms_key_arns        = var.secret_kms_key_arns
  certificate_arn           = var.certificate_arn
  internal_alb              = var.internal_alb
  client_cidrs              = var.client_cidrs
  backend_health_check_path = "/internal/health"
  desired_count             = 0 # explicit activation after bootstrap/owner checks
}
```

Define those variables in the owning root. `services` must contain exactly
`backend` and `launcher`, each with `{ environment = map(string), secrets =
map(string) }`. Environment holds public rendered configuration/bootstrap maps;
secrets holds exact Secrets Manager ARN references, **not resolved values**.
Config containing tokens/credential URLs must itself use secret delivery.
Supply separate backend/launcher bootstrap manifests and preserve key/secret
versions; see the [bootstrap contract](../../server/workers/bootstrap.md).
Never inject either controller bundle or the RDS master identity into workers.

Prepare foundation first with `image = null`, `worker_image = null`, install mode
false and counts zero. Use `ecr_repository_url` to publish matching native images
from the [Containerfile/build guide](../../container/README.md), then pin their
digests. Both controller and worker references must resolve to the selected Linux
architecture; changing architecture affects all tasks, not just workers. A
multi-platform index is useful only after each child is independently qualified.

Before activation, provision the seven separate application stores/roles using
[operator-only initialization](#optional-operator-database-initializer), retain
matching secret/key recovery material, and render the application's backend and
launcher configuration from this module's outputs: private service URLs, worker
cluster/task definition, private subnets and worker security group. Set the ECS
driver explicitly and pin its allowed task definition/configuration revision;
Terraform registers a worker definition but does not launch chats. Provide the
issued certificate and DNS alias to `alb_dns_name`/`alb_zone_id`, review public
versus internal ALB/client CIDRs and choose the origin before passkey enrollment.
Review the actual plan/cost, then follow ordered activation/undrain below.
This example is configuration guidance, not a tested fresh-install receipt.

## Operation, safety and retained state

1. Review exact Terraform/OpenTofu saved plan, account, network and cost; no apply
   is implied by a source commit or synthetic plan. Choose one engine for live
   state and keep caller-specific lockfiles. AWS provider pin is 6.67.0.
2. Foundation stage has `image = null`, zero tasks, optionally no ALB. RDS/NAT/EIP
   still incur costs. Output ARNs/addresses are not generated secret values.
3. Publish immutable separately qualified ARM64/AMD64 artifacts into ECR; generate
   installation secrets privately; bootstrap RDS roles and matching secret values
   through an operator-only path. Select final origin before passkey enrollment.
   Task definitions may be prepared at count zero; never start with placeholder
   configuration, missing secret versions or a synthetic image digest.
4. Activate only after application/configuration review. Fresh routing storage
   intentionally starts with admission blocked. After owner/inventory checks,
   use authenticated private `POST /internal/undrain` to reopen admission; never
   expose `/internal` publicly or bypass drain in code to make startup succeed.
   Verify actual runtime UID/permissions, private bootstrap files, secret-source environment removal,
   database verified TLS, signed-out HTTPS, enrollment, real model/tool execution,
   artifacts and replacement with independently confirmed old-task STOPPED.
5. For upgrades, seal admission and authenticate fresh drain/quiescence evidence.
   Stop the backend first, prevent its supervisor from restarting it, and confirm
   actual STOPPED while the launcher remains reachable; backend shutdown rechecks
   launcher retirement even after a complete drain receipt. Then stop and confirm
   the launcher. Do not scale both controllers down simultaneously. Complete
   termination before maintenance against their stores.
   Preserve PostgreSQL, S3 artifacts and matched encryption/signing/token secret
   versions. Record exact prior/new image digests and schema compatibility.
   For development image/container-only changes with unchanged application/schema,
   such as the Ubuntu worker repackaging, do not automatically create a fresh RDS
   snapshot or make one a rollout gate. Preserve existing state/recovery material
   without adding production-style backup ceremony to development deployments. Database-changing or destructive maintenance
   needs its own reviewed backup/restore plan. ECS stop-before-start does not automatically establish
   complete application drain.
   Restart the launcher first with backend desired count held at zero. Read back
   the resolved launcher configuration and RunTask policy against the intended
   worker task-definition revision before starting the normal flag-free backend.
   Reopen admission only through the authenticated quiesced preflight/undrain path,
   not a successful liveness probe.
6. On failure keep admission closed and preserve state/evidence. Reconcile the
   same immutable attempt; absence, expired leases and successful StopTask requests
   are not retirement proof. Recover stale backend ownership only after confirmed
   old process termination, using invocation-only recovery arguments. Do not put
   those recovery flags into retained service configuration. Follow the owning
   [stopped-backend recovery guide](../../server/workers/backend-recovery.md).
7. Rollback requires compatible schema or an independently verified matched restore
   set. Restoring old state can lose later writes and requires an explicit decision.
   POC is retained, not automatically destroyed. RDS and artifact bucket have
   `prevent_destroy`; RDS deletion protection/final snapshot and ECR/S3 non-force
   deletion are additional guards. Never remove these guards merely to make apply
   succeed. Teardown/data deletion require separate approval.

## Current evidence and limits

Terraform 1.16.5 and OpenTofu 1.12.6, AWS provider 6.67.0, validated the candidate
and produced identical synthetic ARM64 consumer actions: 78 additions (77 AWS
resources plus the consumer activation guard), zero updates/deletions. Fixture
copies use no backend, synthetic identifiers, disabled credential/account/metadata
validation, and substituted account identity; they make no AWS calls and are not
applyable deployment plans. Initial formatting/version-selection failures were
corrected; the installed Homebrew Terraform 1.5.7 is too old. Use the selected
operator binaries, not whichever `terraform` happens to be first on PATH.

Source/deslop review preserves direct Terraform resources, separate worker cluster,
scoped IAM/SGs, no secrets in state, restricted service ownership, stop-before-start,
matched recovery and retained state. Pi reviewed the initializer/bootstrap contract;
Full application runtime acceptance is not established. Application task IAM and
SQL isolation, ALB/path behavior, AWS recovery, credential lifetime, performance and full application
security qualification remain unverified. The Surton consumer records access,
actual cost assumptions, missing operator decisions and publication separately.

Native image follow-up: application `99ae730` built on native ARM64 Lima and AMD64
Omarchy. Non-root/Node 24/wrapper/fresh-workspace packaging passed. A second scoped
check found empty Docker volume repopulation resetting `/data` to 0755 after init.
The initializer now creates empty `.dispatch-volume-init` markers before setting
ownership/modes; both native reruns passed read-only-root UID 65532 bootstrap,
0700 directory/0600 exact 32-byte decoded fixture file, auth CLI help and collision
refusal. All volume roots retained their intended modes. Every layer path was
reviewed (63,822 ARM64 / 63,824 AMD64 entries) with no matched host-state/credential
paths. These bounded inspections are not an exhaustive secret audit. No network,
real credentials, application database or AWS execution was used. Candidate image
`99ae730` is superseded for actual activation by subsequent cold-start fixes.

## AWS readback corrections

Module `28a35fc` makes Cloud Map custom health checks explicit with
`failure_threshold = 1` and records `rds.force_ssl = 1` with
`apply_method = "pending-reboot"`. Empty custom-health blocks disappeared from
AWS readback and triggered repeated discovery replacements; the implicit RDS
apply method also drifted. Module `097d21b` also makes ECS's empty container
arrays, `capabilities.add = []` and awsvpc host ports explicit: AWS supplies these
on readback, and omitting them caused unnecessary task-definition replacements.
These source corrections do not prove runtime health.
Review exact state-backed actions and registrations before applying: replacing
empty discovery services before activation does not authorize replacing services
with live owners. Preserve partial state after failed apply and replan in place;
do not tear down the installation to retry provisioning.

## Optional operator database initializer

`database_initializer = {command, environment, secrets}` (default null) registers
one operator task definition only when `image` is set. It never creates a service
or calls RunTask. It has its own no-ingress security group, SQL access to RDS and
HTTPS outbound, execution role restricted to its declared secret ARNs/log group/
ECR, and a task role with no IAM permissions. No application role gains master
secret access. The same volume initializer and UID 65532 runtime apply.

The dedicated RDS parameter group prepares `log_parameter_max_length` and
`log_parameter_max_length_on_error` at `0` with dynamic (`immediate`) application.
RDS can deny session SET even to its managed master identity. Parameter-group
configuration is not proof of effective operator-session values: the helper must
still enforce its logging protections before password-bearing provisioning. Do
not grant application roles parameter authority to work around an initializer
failure. The helper's owning contract is
[`database-init.md`](../../server/workers/database-init.md).
Bound-parameter limits do not redact SQL password literals. Initializer-session
checks do not qualify the separate worker provisioner connection; that connection
must independently enforce safe statement/error logging before password DDL.
Module `6d0718a` also prepares `log_statement=none`, both duration logging
thresholds (`log_min_duration_statement`, `log_min_duration_sample`) at `-1`,
`log_min_error_statement=panic`, `log_error_verbosity=terse` and
`pg_stat_statements.track_utility=0`. Application `e87dbab` verifies effective
settings at provisioner connection open and again inside serialized `ensure()`
before password DDL, since dynamic RDS changes can affect an already-open session.
It fails closed with sanitized errors, without privileged SET; its full guard also
requires SCRAM password encryption and rejects enabled audit/utility capture where
those settings exist. See [the provisioner](../../server/workers/postgres-stores.ts).
Source/build checks and a parameter-only apply do not qualify deployed guard
behavior or a full external logging audit. Rebuild and deploy the supporting image
before resuming worker provisioning. Inspected consumer receipts at `0b8ef0a`
cover [native ARM64/AMD64 packaging](https://github.com/dispatchlabs-ai/dispatch-infra/blob/0b8ef0a/environments/surton/dispatch-workers/evidence/e87dbab-native-images.json)
and a [fresh, read-only provisioner-role TLS session](https://github.com/dispatchlabs-ai/dispatch-infra/blob/0b8ef0a/environments/surton/dispatch-workers/evidence/worker-effective-logging.json),
not the running backend connection or the deployed guard's password-DDL behavior.

The task definition precondition requires `desired_count=0` and every
`service_desired_counts` override at zero; this is not proof of
actual old-task termination. Before the operator invokes it, independently confirm
all backend/launcher/worker and maintenance owners STOPPED, reject uncertain state,
and pin exact task definition/secret versions. Run it in `service_cluster_arn`,
`private_subnet_ids` and the output `database_initializer.security_group_id`, with
public addressing and ECS Exec disabled. Retain `--verify` as the task's default;
creation and stopped-owner confirmation flags belong only to the reviewed RunTask
invocation. Its master credential is the directly injected RDS managed JSON secret,
not a second retained master-password URL.

After successful stopped-task verification, remove this optional input before
activating stable services: its definition is deregistered and dedicated IAM/SG
resources removed, without deleting database state. Caller owns helper arguments,
restricted-file manifest, seven distinct store URL secrets and private receipts.
A successful RunTask response is not completion; inspect task STOPPED and the
actual initializer exit code/logs, then explicitly run read-only verification.
Unknown outcomes must be investigated, never blindly recreated/reset.

Both engines' synthetic optional-initializer module plans agree on eight extra
AWS resources and no scheduled operator service. Runtime helper/RDS compatibility
is separate application work; no live invocation is established by these plans.

## Optional private credential-maintenance terminal

`credential_maintenance` defaults to `null`. With an image and explicit
`{ environment = map(string), secrets = map(string) }`, module `7a183ae` registers
an unscheduled task, separate Exec cluster (`logging = NONE`), security group and
IAM roles. It does not launch a task or service. Output `credential_maintenance`
provides `cluster_arn`, `task_definition_arn` and `security_group_id`.

The effective backend desired count must be zero and `database_initializer` null.
Independently confirm the backend and previous maintenance executors STOPPED;
configuration is not retirement proof. Review each plan/cost and secret-reference
allowlist. Surton's caller supplies provider URL/key references only, never master
credentials or an application bundle. Ordinary application/worker Exec stays off.

Only this operator container has writable ephemeral root/default capabilities for
Exec. No container log driver is configured. Follow the [bootstrap UID and
command-audit boundaries](../../server/workers/bootstrap.md#deployment-inputs-and-boundaries):
CloudTrail still records commands. Keep the terminal private and unrecorded.
Verify the separately executed CLI's settled outcome and awaited credential-owner
release; expected prompt cancellation may exit 1 after closing the store.
The holder container's exit code (including 143) does not establish either.
Then confirm the operator task STOPPED before normal flag-free backend startup.
If the owner latch remains, use the owning CLI/backend's explicit retired-owner
recovery procedure rather than clearing SQL latches or forcing normal startup. Set the input back to null and review temporary-resource cleanup without
removing retained databases, artifacts or secret versions. Registration/source
review is not live Exec, bootstrap, OAuth or model/workload acceptance.
