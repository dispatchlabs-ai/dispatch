# Dispatch conversation workers on Kubernetes

**Infrastructure draft:** the matching Kubernetes launcher driver and filesystem artifact adapter are still pending. Do not deploy this chart with the published 0.6.0 image. Rendering and source review do not establish a runnable installation or functional qualification.

This experimental chart prepares one backend, one launcher and launcher-managed conversation worker Pods. It uses externally provisioned PostgreSQL, a platform-supplied artifact PVC and existing role-separated Kubernetes Secrets. It requires no AWS API, IAM role, S3 bucket or cloud-specific credential provider. It does not migrate the standalone chart, implement HA or enable automatic ownership takeover.

Use a fresh restricted namespace such as `dispatch-workers-qualification` and release `dispatch-workers`. The chart applies namespace-wide default-deny NetworkPolicy, so it must not share a namespace with unrelated workloads. The platform must provide an enforcing NetworkPolicy implementation, trusted ingress and a qualified CSI StorageClass. The artifact filesystem must support POSIX hardlinks and file/directory fsync; a PVC being Bound does not qualify those semantics or establish a backup.

## Configuration and secrets

Set `installationId`, canonical HTTPS `origin`, company ID/name, `configurationRevision` and immutable digests for the backend, launcher and worker images. Every image must contain the matching Kubernetes-driver and filesystem-artifact implementation; an older standalone image does not satisfy this chart. Supply public database and backend CA PEMs through `trust`. The backend TLS Secret uses standard `tls.crt`/`tls.key` keys; its certificate must match `<release>-backend.<namespace>.svc`, the verified worker callback endpoint. Only the backend receives its private key.

Create separate existing Secrets named by `secrets.backend` and `secrets.launcher`. Never put their values into Helm values, ConfigMaps, command arguments, Git or installation receipts.

| Secret | Canonical keys |
| --- | --- |
| Backend | `auth-db-url`, `provider-db-url`, `catalog-db-url`, `directory-db-url`, `routing-db-url`, `workers-db-url`, `auth-key`, `provider-key`, `catalog-key`, `worker-token`, `launcher-token`, `operator-token` |
| Launcher | `launcher-db-url`, `worker-token`, `launcher-token` |
| Backend TLS | `tls.crt`, `tls.key` |

The three encryption-key values are canonical base64 strings encoding distinct 32-byte keys. URLs, tokens and PEMs are UTF-8. Backend/launcher copies of `worker-token` and `launcher-token` must match; tokens are independently generated base64url values containing at least 32 random bytes. The backend's `workers-db-url` is its scoped worker-store provisioner credential, never the database master. The launcher receives no other database URL or encryption key. The worker receives conversation-scoped credentials only through authenticated backend bootstrap.

The public `<release>-config` ConfigMap contains JSON configuration and CAs. `dispatch-bootstrap` materializes its selected entries and Secret-sourced values into new UID-owned `0600` files under `/tmp/dispatch-bootstrap`, removes their source environment variables and executes the role. Each Pod gets fresh temporary/state/workspace directories. Authoritative application state belongs in PostgreSQL and artifact storage; key escrow and database/volume backups must survive these Pods.

Controller arguments preserve the OCI entrypoint, which creates the declared HOME/data/workspace directories before executing bootstrap. A container restart inside the same Pod retains its `emptyDir` contents, so bootstrap's exclusive directory creation intentionally refuses the existing `/tmp/dispatch-bootstrap`. Use a fresh Pod only after confirming the former owner stopped and reconciling any retained ownership state. Do not add startup cleanup or delete the bootstrap directory beneath a possible owner. This chart does not automatically remove or repair that state.

When `postgres.host` is supplied, the ConfigMap also includes `database-init.json` for a separate operator Job. It references `/tmp/dispatch-bootstrap/postgres-admin.json`, the database CA and seven role URL files. Supply the operator-only master JSON through a distinct initializer Secret, never either runtime Secret. The chart creates no initializer Job or Secret and never runs database initialization as a Helm hook. Label operator Jobs with `app.kubernetes.io/instance: <release>` and `app.kubernetes.io/component: operator`; their NetworkPolicy permits only DNS and the declared database destinations. Use `<release>-operator` without a service-account token.

## Platform boundaries

Configure `networkPolicy.databaseCidrs` for the private PostgreSQL endpoint ranges and `apiServerCidrs` for the API service/control-plane destinations on TCP 443. The launcher alone receives a Kubernetes token and namespace-scoped Pod get/list/create/delete/patch permissions. The backend and `worker.serviceAccountName` receive no API token. Pod-creation authority is trusted control-plane authority: ordinary RBAC does not constrain Pod fields, selected images or labels. Keep agents out of the launcher process and restrict human namespace administration.

`imagePullSecrets` references existing registry Secrets in the same namespace. Controllers declare those references directly; the worker ServiceAccount supplies them to new dynamic Pods through ordinary Kubernetes admission. The launcher needs no Secret-read permission. Changing that list does not modify already-created workers.

Backend/worker egress admits DNS, the declared database, their authenticated private RPC paths and public destinations excluding private, loopback and link-local ranges. The launcher receives DNS, database and declared API access. If the platform uses NodeLocal DNS, set `dnsCidrs` to its exact DNS addresses. Policy source/destination handling around service translation differs by CNI; qualify actual flows and denied metadata/API access. Declared policy is not evidence of enforcement or hostile-code isolation.

Ingress is off by default. The platform chooses controller, HTTPS termination, source CIDRs and annotations, and must supply `ingress.internalDenyPaths` before the application catch-all. Those routes must deny `/internal` and `/internal/*` publicly. The backend Service speaks HTTPS, so configure upstream HTTPS and appropriate certificate trust in the selected ingress controller. The chart requires deny routes but cannot infer their controller-specific semantics; verify the actual edge responses. Launcher/worker control endpoints have no public Ingress.

## Activation and recovery

`application.enabled` defaults to `false`, allowing storage/configuration preparation before initialization. Initialize only a fresh dedicated database with stopped controllers and retain exact credential/key versions. Enable controllers after successful initialization, then use the supported authenticated operator activation path. Fresh admission starts closed: backend readiness can remain false until activation. Do not confuse an initial Helm wait timeout with permission to clear ownership latches or recreate a database.

Both controllers use one replica, Recreate, readiness-only probes and indefinite not-ready/unreachable tolerations. Kubernetes may restart a terminated container; retained PostgreSQL ownership latches must fail closed on uncertain recovery. No liveness probe, automatic takeover or forced node eviction is configured. Positively stop/fence old executors before node-loss recovery or uncertain replacement. Preserve the launcher's attempt receipts, immutable Pod UIDs, finalizers and tombstones; deleting a Pod object is not proof its old process stopped.

Controller updates do not upgrade already-running conversation workers. Preserve their pinned image/revision and safely retire the exact attempt before replacement. Worker-local files remain disposable; useful source must be pushed and required artifacts published before retirement. Backup/restore must pair PostgreSQL, retained artifact bytes, installation identity and encryption/signing keys. PVC retention alone is not an independent backup or a qualified restore.

The small default requests are for sandbox coexistence with the existing standalone deployment. They do not establish load capacity, connection budgets or production acceptance. No PDB, autoscaler, multi-AZ failover or untrusted-code sandbox is claimed.

The proposed restricted worker uses the non-root Nix `workers-oci` image and writable `/workspace` plus `/tmp`. It must preserve that image's entrypoint and set HOME, state and workspace beneath `/workspace`. Its bundled shell/Git/Node tools can support basic execution qualification. This is not parity with the existing root Ubuntu worker's apt, mise and browser environment; root filesystem package installation and that image's runtime need a separate supported configuration and qualification.
