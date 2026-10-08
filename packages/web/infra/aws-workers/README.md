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
- Private encrypted PostgreSQL 17, single-AZ `db.t4g.small`, 20 GiB gp3 (autoscaling
  up to 100 GiB), enforced TLS, seven-day backups and deletion protection. The
  generated RDS master secret is **operator-only**. Provision separate application
  roles/databases before activation; only the worker-store provisioner needs
  CREATEROLE. Workers obtain scoped credentials from the backend. Do not inject
  the RDS master identity into either service or workers.
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
- Cloud Map names `backend.NAME.internal` and `launcher.NAME.internal`. Backend
  callback trust uses the application's request-local private CA, not globally
  expanded provider/MCP trust. Backend-to-launcher and backend-to-worker RPC are
  private authenticated HTTP in this POC, **not end-to-end encrypted transport**.
- Security-group references admit only the directed internal flows and PostgreSQL.
  Task outbound HTTPS is unrestricted by hostname. AmazonProvidedDNS is not
  filtered by SGs; no general VPC DNS-server rule is needed. Additional MCP ports
  need explicit review, not default all-port egress.

All tasks use the same digest. A short same-image `volume-init` container runs as
root without the app's secret/environment bundle, fixes ownership of only the
three task-local volume roots `/data`, `/tmp`, `/workspace`, and exits successfully
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
4. Activate only after application/configuration review. Verify actual runtime
   UID/permissions, private bootstrap files, secret-source environment removal,
   database verified TLS, signed-out HTTPS, enrollment, real model/tool execution,
   artifacts and replacement with independently confirmed old-task STOPPED.
5. For upgrades, seal admission and authenticate fresh drain/quiescence evidence;
   stop and confirm stable task termination before maintenance against its stores.
   Preserve PostgreSQL, S3 artifacts and matched encryption/signing/token secret
   versions. Record exact prior/new image digests and schema compatibility. ECS
   stop-before-start does not automatically establish complete application drain.
6. On failure keep admission closed and preserve state/evidence. Reconcile the
   same immutable attempt; absence, expired leases and successful StopTask requests
   are not retirement proof. Recover stale backend ownership only after confirmed
   old process termination, using invocation-only recovery arguments. Do not put
   those recovery flags into retained service configuration.
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
Linux/Fargate execution is not established. Live IAM authorization, RDS provisioning,
ALB/path behavior, AWS recovery, credential lifetime, performance and full application
security qualification remain unverified. The Surton consumer records access,
actual cost assumptions, missing operator decisions and publication separately.
