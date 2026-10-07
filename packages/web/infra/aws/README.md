# Dispatch Web — AWS service module

Generic Terraform/OpenTofu child module for one ECS Fargate owner behind an HTTPS ALB, with durable S3 Files storage. This is a deployment candidate, **not yet AWS-qualified**. See [deployment operations](../../docs/aws-deployment.md) and [SQLite qualification](../../docs/aws-sqlite-qualification.md).

## Ownership

The caller supplies its AWS provider, backend, VPC, task and ALB subnets, ECS cluster, S3 Files filesystem and authoritative bucket/prefix, issued ACM certificate, DNS, image digest, and any secret references. No provider credentials, backend, private module dependencies or installation-specific accounts/domains are embedded here.

The module creates an ALB with a TLS 1.2/1.3 HTTPS listener, IP target group, restricted ingress groups, task/execution roles, logs, S3 Files access point and ECS service. DNS must alias the chosen origin hostname to `alb_dns_name`/`alb_zone_id`. The certificate must cover that hostname. Only HTTPS port 443 is exposed; there is no HTTP listener. The ALB is internal by default; public reachability requires explicit `alb_internal=false`, suitable ALB subnets and client CIDRs. Tasks default to private addressing and require working egress for model/MCP APIs, registry/logs/secrets and storage.

## Example

```hcl
module "dispatch_web" {
  source = "./path/to/dispatch-web-next/packages/web/infra/aws"

  name                 = "example-dispatch"
  vpc_id               = var.vpc_id
  subnet_ids           = var.private_subnet_ids
  alb_subnet_ids       = var.alb_subnet_ids
  cluster_arn          = var.cluster_arn
  certificate_arn      = var.certificate_arn
  origin               = "https://dispatch.example.com"
  allowed_client_cidrs = ["10.0.0.0/8"]
  image_uri            = var.image_uri # registry/repository@sha256:<64 hex>
  ecr_repository_arns  = var.ecr_repository_arns

  s3_files_file_system_id  = var.file_system_id
  s3_files_file_system_arn = var.file_system_arn
  s3_files_bucket_arn      = var.bucket_arn
  s3_files_prefix          = var.filesystem_bucket_prefix
  desired_count           = 0
}
```

See `variables.tf` for all inputs, validation and defaults; `outputs.tf` defines integration outputs. Pin source to a reviewed release/commit, image to a Linux x86-64 digest and provider versions in the caller lockfile. The child module intentionally does not ship a provider lockfile.

## Runtime and IAM

The container runs as 65532:65532 with a read-only root and dropped capabilities. `/data` is the access point root `/dispatch/NAME/data`; `/data/state`, `/data/workspace` and `/data/home` hold state, coding workspace and provider home respectively. `/tmp` is ephemeral. Back up the entire access-point tree, including encryption keys and provider credentials; a database-only backup is insufficient.

Non-secret `environment` values enter infrastructure state. `secret_environment` accepts exact Secrets Manager/SSM ARNs, not secret values; ECS injects resolved values at runtime. Never put secrets into `environment` or image layers. Runtime-critical environment names cannot be overridden. Coding agents share service-account access to files and runtime credentials; this is not tenant or project execution isolation.

Task permissions allow S3 Files mount/write only through the declared access point, plus read/version-read/list under its exact backing S3 prefix following the Wiki pattern. The execution role separately owns image pull, log writes and declared secret reads/decryption. ECR authentication requires a wildcard resource; repository pulls are scoped. ECS Exec is disabled. The caller owns filesystem/bucket resource policies, storage encryption/KMS policy, mount-target connectivity and backups; these must agree with the task role and security group outputs.

## Operations and qualification

`desired_count` is restricted to 0 or 1 and defaults to zero. Bootstrap using the **same image and volume settings**, with the service at zero and every old task confirmed STOPPED. Keep invitation output private. After qualification, explicitly set count to one. Stop-before-start deployment (0% minimum, 100% maximum) allows downtime; it is not distributed fencing or high availability. Do not launch overlapping maintenance tasks. Automatic rollback is disabled because an older image may not understand migrated state.

Scale to zero and confirm STOPPED before enrollment/recovery CLI, file-copy backups, integrity checks, restore or downgrade. Root `/` health checks prove HTTP/static serving, not database integrity or model readiness. Verify authenticated SSE through the actual ALB, including idle periods and reconnect after replacement.

Destroy removes the service/ALB/access point and roles but not caller-owned storage or retained task-definition revisions. Data remains under the documented backing prefix; deleting it is a separate explicit operator action. Preserve image digests and a consistent backup for recovery. Rename/root-path changes require deliberate data migration.

Compatibility checks: Terraform 1.16.5 and OpenTofu 1.12.6 init/validate passed locally; live deployment, SQLite qualification, artifact execution and consumer plan remain pending. Build/source checks do not establish live compatibility.
