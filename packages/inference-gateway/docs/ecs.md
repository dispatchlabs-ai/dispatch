# ECS gateway operations

Build the image from a clean committed repository root:

```sh
docker buildx build --platform linux/amd64 \
  -f packages/inference-gateway/Dockerfile \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t YOUR_ECR_REPOSITORY:SOURCE_REVISION --push .
```

Deploy the returned digest through
[terraform-aws-inference-gateway](https://github.com/dispatchlabs-ai/terraform-aws-inference-gateway).
The Node 24 base image is digest-pinned, installation uses the committed lockfile,
and the final distroless image runs without root, a shell, a package manager or a
writable root filesystem. An explicit entrypoint invokes Node directly.
The module expects port 8787 and configuration with `host: "0.0.0.0"`. Configuration is
non-secret JSON stored at a content-addressed S3 key. The task checks its SHA-256
before parsing it. Secrets Manager owns provider credentials and the session key;
never include their values in Terraform, the image or configuration.

The module sets `DISPATCH_GATEWAY_CONFIG` to an `s3://` URI and
`DISPATCH_GATEWAY_CONFIG_SHA256` to its digest. ECS coordination requires all of
`DISPATCH_GATEWAY_ECS_CLUSTER`, `DISPATCH_GATEWAY_ECS_SERVICE` and
`DISPATCH_GATEWAY_OWNER_TABLE`. Task identity comes from ECS task metadata, and
peer addresses come from ECS DescribeTasks for that exact cluster and service.
Do not reuse this table or credential set across independent deployments.

## Ownership and draining

Every healthy ingress task accepts authentication and health requests. One task
owns **all** provider operations, including catalog access, API keys and OAuth.
Standby tasks do not instantiate providers, because initialization can refresh an
OAuth credential. Both hops authenticate the bearer; only fixed protocol routes
are forwarded, with bounded bodies and streaming backpressure/cancellation.
Forwarding never retries an admitted operation or follows redirects.

The owner record has an immutable task ARN and generation, a heartbeat, and a
phase. Heartbeat loss blocks new requests and permits StopTask. It does not make
it safe to acquire ownership. A candidate must observe ECS `lastStatus=STOPPED`,
or a durable STOPPED receipt for the current task, before a conditional claim.
Missing DescribeTasks results alone are insufficient. The table has no TTL.
The STOPPED observer writes a receipt only if the stopped task still owns the
record. A successful claim replaces the entire record, clearing prior receipts.

Task draining blocks new owner requests, including peer-forwarded requests.
Existing operations may finish and persist refreshed credentials. The ALB drains
for up to 300 seconds; once SIGTERM arrives, the process allows up to 110 seconds
before the Fargate 120-second stop deadline. A deployment, forced stop, network
partition or host failure can interrupt a long stream. Callers decide whether to
start a new inference request; the gateway cannot prove the previous request was
uncharged. Two ingress tasks improve replacement availability, not parallel
provider ownership or seamless stream migration.

## Upgrade, rollback and recovery

1. Build and retain the committed image digest; upload content-addressed config.
2. Apply the updated task definition. Monitor ECS, ALB and metadata-only logs.
3. Verify public HTTPS identity, catalog and a real completion; then observe a
   takeover. An HTTP health response proves process readiness only.
4. Roll back by applying the earlier compatible image/configuration digests.
   Keep the **current** Secrets Manager versions: restoring an older OAuth refresh
   token can invalidate authentication.

For migration from an uncoordinated process, stage ECS with `desired_count=0`,
stop the old process and verify it cannot restart, then start ECS and switch DNS.
For rollback to the old process, scale ECS to zero and verify every old and new
task is `STOPPED` before starting it. Desired count zero or STOPPING is not proof.

If the owner is absent from DescribeTasks and no durable receipt exists, the
service fails closed. Inspect the dead-letter queue and Lambda logs, establish
that the exact owner task stopped, then replay its original STOPPED event. Never
clear the owner record merely because it is old. For disaster recovery, first
fence every writer in every region, restore compatible configuration and the
latest credentials, then initialize a fresh coordination table. Replicated OAuth
credentials can still require reauthorization; a provider may have rotated a
token immediately before a regional outage.

All operator `login` commands are direct credential administration. Stop all
writers first, then restart to load the new login. The gateway does not host or
migrate Pi Durable agent databases, execution, tools or review cursors.
