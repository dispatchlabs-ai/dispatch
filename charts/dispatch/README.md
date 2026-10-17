# Dispatch Helm chart — standalone Kubernetes experiment

This unpublished chart packages the **existing standalone application**, pinned to the published 0.6.0 AMD64 controller digest. It does not change product behavior or provide a Kubernetes launcher/individual conversation-worker Pods. It is the fresh-installation milestone, not the final distributed platform or an HA deployment.

## Required platform inputs

- A supported Kubernetes cluster with enforced NetworkPolicy and an RWOP-capable CSI storage driver.
- A caller-owned retained encrypted StorageClass, supplied through `persistence.storageClass`; the application chart does not create cloud storage controllers.
- One canonical HTTPS `origin`, installation company ID/name and explicit internal ingress CIDRs.
- A caller-selected ingress controller/TLS configuration. Cloud-specific annotations are values, not chart forks. The Service stays ClusterIP. Deny public `/internal` and `/internal/*` at the ingress before publishing the hostname; NetworkPolicy cannot filter HTTP paths. `ingress.additionalPaths` accepts standard Ingress backends before the application catch-all, for example an ALB fixed-response deny action supplied by the AWS caller.

Application, authentication/native SQLite records, keys, credentials, attachments and workspace live together on the new PVC. Scratch `/tmp` is disposable. The Pod runs non-root with a read-only root, no Kubernetes API token or IAM role, and no host filesystem/socket mount. Native tools still have the application's filesystem and network authority; this is for trusted users, not a hostile-code sandbox.

The network policy permits configured internal ingress, cluster DNS and public egress excluding private/link-local/loopback IPv4 destinations. Private MCP/Git/database access is not implicitly granted. Enforcement must be supplied and verified by the platform.

## First installation

Use an isolated namespace and never adopt another installation's PVC. Render/lint with the actual caller values. Install initially with `application.enabled=false`, so the chart creates the retained claim and application configuration without opening the runtime. Run the documented installation-owned enrollment operator while the application is stopped, then enable the application. Account invitation URLs, passwords, authenticator seeds and recovery codes are private; do not put them in chart values, Helm history, Git, reports or logs copied into a public transcript.

The initial operator must use the identical image, origin, company and data/workspace settings. Disable Service environment injection (`enableServiceLinks: false`) and set the numeric application port explicitly: a Service named `dispatch` otherwise injects a `DISPATCH_PORT=tcp://…` value that fails application configuration. The operator mounts the same PVC exclusively. There are no initialization, invitation, migration or credential-maintenance Helm hooks.

## Ownership and recovery

An application owner is the process that opens the installation's persistent state. Multiple people can enroll in the same installation; this runtime restriction is not an account limit.

The replica count is deliberately fixed at one; Recreate prevents an ordinary rolling upgrade from opening two owners. RWOP further limits the claim to one Pod. Indefinite not-ready/unreachable tolerations block automatic eviction to a replacement node. They do not prove an old executor stopped: do not force-delete its Pod or force-detach the volume. First positively stop/fence the process/node and its work through a qualified operator procedure. Automatic node-loss recovery is not provided.

Stop admission/work and verify settlement before image updates, operator account changes, node maintenance or backups. An image-only rollback is not data rollback. Uninstall retains the PVC via `helm.sh/resource-policy: keep`; the platform's Retain StorageClass also retains the underlying volume after claim deletion. Retained volumes are not independent backups. Reinstall/restore and orphan-resource adoption require explicit review, not deleting ownership metadata to force Helm installation.

The Surton caller owns deployment instructions/evidence. No existing project, model credentials, Slack app or legacy content is imported by this chart. Functional acceptance requires actual enrollment/sign-in, project/agent/chat creation, reload and an authorized real model response; rendered YAML and running Pods alone do not establish those outcomes.
