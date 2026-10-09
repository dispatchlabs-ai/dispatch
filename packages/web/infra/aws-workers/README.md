# Conversation-worker AWS module

**Retained POC candidate, October 8, 2026; not deployed or AWS-qualified.**
This is the worker/PostgreSQL topology, not the older sibling `../aws` module's
SQLite/S3 Files deployment. Installation account, domain, backend state and secret
values belong in a separate consumer repository. The Surton consumer is
`dispatchlabs-ai/dispatch-infra/environments/surton/dispatch-workers`.

## Resources and runtime

- Dedicated VPC, two public and two private subnets, one NAT gateway and S3 gateway
  endpoint. Single-NAT egress is not multi-AZ availability. Review the CIDR against
  live routing before applying. Tasks never receive public addresses.
- Separate stable-service and **worker-only** ECS clusters. Backend and launcher
  are count-zero by default, maximum one each; 0/100 ECS replacement, no automatic
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

All tasks use the same digest. A short same-image `volume-init` container runs as
root without the app's secret/environment bundle, creates an empty marker in each
volume to prevent Docker repopulating empty-volume metadata, then fixes ownership
of only the three task-local volume roots `/data`, `/tmp`, `/workspace`, and exits successfully
before application startup. It has no application command or persistent mount.
ECS task-role identity is task-wide (including this trusted initializer), not an
OS-user boundary. Main containers run UID/GID 65532, read-only root, dropped
capabilities, init process and 120-second stop allowance. Workers' writable disk
is disposable. Actual Fargate mount behavior remains unverified.

Backend/launcher commands are `dispatch-bootstrap backend|launcher`. The public
`services` input carries rendered configuration and **exact secret ARN references**,
never secret values. Per-service execution roles fetch only their declared
Secrets Manager secrets; the worker execution role cannot fetch either bundle.
Reference the application's [bootstrap contract](../../server/workers/bootstrap.md)
for exclusive 0700/0600 materialization and environment removal. Raw encryption
keys are base64 inputs decoded to 32-byte files; retained secret versions must
match encrypted records. Configuration is not a backup.

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
   versions. Record exact prior/new image digests and schema compatibility. ECS
   stop-before-start does not automatically establish complete application drain.
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
Verify the separately executed CLI's own clean exit and credential-owner release;
the holder container's exit code (including 143) does not establish either.
Then confirm the operator task STOPPED before normal flag-free backend startup.
If the owner latch remains, use the owning CLI/backend's explicit retired-owner
recovery procedure rather than clearing SQL latches or forcing normal startup. Set the input back to null and review temporary-resource cleanup without
removing retained databases, artifacts or secret versions. Registration/source
review is not live Exec, bootstrap, OAuth or model/workload acceptance.
