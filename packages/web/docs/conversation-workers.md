# Single-server conversation workers

Status: application integration in progress. A private, sealed backend/launcher/PostgreSQL/Garage stack is running on Omarchy with zero conversation workers; no HTTPS/DNS publication. Conversation execution and integrated acceptance remain unqualified. Implements the [accepted target](spec.md#aws-container-deployment-target) and [single-server rehearsal](spec.md#single-server-container-rehearsal). Chris authorized implementation, isolated Omarchy deployment and focused testing on October 7, 2026. Existing installations and their data remain untouched.

## Ownership and boundaries

The backend owns authenticated HTTP/SSE, company/project directories, definitions, skills, grants and connection administration. Each conversation worker owns exactly one logical Pi PostgreSQL store containing its collaborating agents, private context and execution. Pi retains scheduling and durable recovery ownership. The launcher manages containers, not Pi tasks.

The existing runtime combines catalog and conversation mutations in Pi transactions. Splitting those transactions requires explicit durable command receipts and revisioned catalog propagation; copying a whole catalog into workers without update/revocation semantics is not sufficient. Preserve membership checks, connection revocation, management grants and apply-to-existing behavior. Native single-runtime mode stays supported.

## Launcher lifecycle contract

Private authenticated control API; no public ingress. Only launcher has Docker access. Neither backend requests nor workers can choose arbitrary images, mounts, capabilities or commands. Operator configuration pins the worker image and allowed network/resources. Worker credentials are scoped separately from launcher control credentials.

- Ensure an attempt: backend persists conversation identity, immutable attempt ID and desired configuration revision before requesting launch. Repeating the same attempt reconciles its labeled container; changed inputs conflict. Timeouts never allocate a new attempt. Container identity includes installation and attempt; enumeration is scoped to the installation.
- Inspect an attempt: returns observed created/running/stopped/unknown state and container identity, not merely desired state. Unknown and unreachable block replacement.
- Stop an attempt: persist stop intent before acting; disable automatic restart, stop/kill as required and confirm termination before reporting stopped. Late ensure retries must not revive a stopped attempt; retain a terminal tombstone.
- Drain installation: persist admission-disabled state, reject new launches, stop all known attempts and reconcile installation-labeled containers. Return complete only when none can execute; launcher restart preserves drain state. Unreachable Docker is not successful drain.
- Status: installation identity, admission/drain state, active workers, outstanding attempts and unresolved operations, available through authenticated local access for upgrade/backup gating. Explicit authenticated undrain after the operator completes the change. Changed-stack activation requires confirmed drain and remains drained pending verification; unchanged reapplication must not interrupt workers.
- Backup additionally requires backend write quiescence: reject new mutations and drain admitted auth/catalog/connection writes before capturing their state. Launcher drain alone cannot establish a consistent application backup.

Application drain ordering is:

1. Persist closure of public admission and settle admitted public/background writes.
2. Drain and confirm retirement of workers while model-auth, artifact and management support callbacks remain available.
3. Quiesce remaining backend support requests before reporting backup readiness.

Blocking support callbacks before worker close can turn unfinished work into service errors. Backend restart requires fresh drain verification; persisted admission closure alone is not proof of quiescence. A fresh authenticated status receipt must include `drained: true`, `drainComplete: true`, `backendQuiesced: true`, zero active workers/unresolved attempts and matching installation identity. See the [installer drain contract](https://github.com/dispatchlabs-ai/terraform-local-dispatch-workers/blob/5e9af3e/docs/drain-contract.md). Integrated drain correctness remains unverified.

Deployment shutdown calls `Harness.close()` through runtime close, not the user-facing Stop operation (which deliberately cancels work). This preserves unfinished durable work for recovery; integrated interrupted-work recovery remains pending. Container termination must still be confirmed separately before replacement. Launcher `close()` closes the controller only; it does not retire workers.

A single launcher serializes installation lifecycle mutations. Its own exclusive ownership and durable journal must survive restart. Docker restart policies for dynamic workers must not compete with this state machine. Database advisory locks supplement, not replace, process termination. Container termination cannot cancel an external request already accepted elsewhere; exactly-once external effects are not promised.

## Integration deliverables

Developer owns application routing/RPC, authorization and integration. Deployer drives deployment and acceptance, owns Nix packaging, the generic Terraform module and Palm integration, and tracks findings through fixes in the owning repositories. Expert owns delegated Pi/lifecycle/artifact work and reviews recovery. Documenter maintains this contract, spec scope and evidence links.

### Entrypoints and private configuration

These entrypoints exist in source; their presence does not establish a running stack. Paths below are relative to `packages/web/` after build.

| Nix wrapper | Node entrypoint | Configuration |
| --- | --- | --- |
| `dispatch-backend` | `build/service/server/workers/backend-main.js` | Normal Dispatch configuration plus `DISPATCH_BACKEND_WORKERS_CONFIG_FILE` |
| `dispatch-launcher` | `build/service/server/workers/control-main.js` | `DISPATCH_LAUNCHER_CONFIG_FILE` |
| `dispatch-worker` | `build/service/server/workers/worker-main.js` | Trusted driver-generated environment; internal port 8831 |

Backend JSON contains `{installationId, workerKeyFile, launcherTokenFile, operatorTokenFile, launcherUrl, configurationRevision, artifacts}`. Launcher JSON contains `{installationId, stateDir, tokenFile, workerKeyFile, host, port, driver}`. Keep configuration and secrets in restricted files; do not publish real values or pass tokens in argv. Backend/launcher share the private installation HMAC key; each worker receives only a derived token bound to its immutable launch identity. Backend validates the current route/attempt before returning company-scoped bootstrap state. Provider OAuth resolution belongs to the backend, not copied worker auth files; refresh/revocation behavior remains an integration requirement.

Launcher bearer-authenticated routes are `/v1/status`, `/v1/ensure`, `/v1/reconcile`, `/v1/stop`, `/v1/drain`, `/v1/undrain`. Backend operator bearer-authenticated routes are `GET /internal/status` and `POST /internal/drain`, `/internal/undrain`, `/internal/replace`. Replacement accepts `{conversationId, attemptId}` and requires fresh confirmation that the old attempt is stopped and its container absent before allocating another. Do not expose `/internal/*` through public ingress. Host helpers, DNS/HTTPS and concrete installation values belong in Palm's runbook.

The `workers-oci` Nix image variant preserves the existing default `oci` image and declares no anonymous volumes. Configure worker driver `user: "65532:65532"` and `workingDirectory: "/workspace"`; worker disks are disposable. Only the launcher has the Docker socket.

### Catalog and artifact ownership

Backend directory-only runtime must neither construct conversation agents nor resume Pi scheduling. `openConversation(options, bootstrap)` seeds a company-scoped revisioned catalog before resume and durably binds the external conversation/store to one native room ID. Backend routing maps external chat IDs to that room. Catalog updates reject stale/conflicting revisions and preserve transcript/participant configuration. Snapshots alone do not prove immediate authorization revocation; cross-store management needs durable store-qualified command receipts and no worker-local save fallback.

Remote Git stores source, PostgreSQL stores Pi state, and ordinary S3 stores artifact bytes. Worker Pi metadata references immutable blobs; workers use authenticated conversation-scoped artifact RPC and receive no S3 credentials. Backend namespaces objects by the authenticated route/store, never a supplied native conversation ID. Worker conversation open requires a remote attachment store; it must not silently fall back to worker-local bytes. Native installations retain their local default.

The backend `artifacts` object is `{endpoint, region, bucket, prefix, credentialsFile}`. The credential file is restricted regular-file JSON `{accessKeyId, secretAccessKey, sessionToken?}`. The SDK uses path-style addressing and explicit credentials, without transparent retries or local fallback. The isolated rehearsal uses Garage, not AWS provisioning; actual S3 save/read, store-isolation and client-reopen checks passed. This does not qualify browser artifact flows, worker replacement or backup/restore. Artifact retrieval after fresh-worker replacement is required.

Consistent backup covers backend auth/connection/routing/launcher state, PostgreSQL and artifact bytes while writers remain quiesced. Restore must resolve restored attachment references in isolated resources. Disposable worker workspaces are not backup inputs. A local S3-compatible service or replacement check does not establish off-machine durability.

### Open integration gaps

Membership synchronization, immediate backend-authoritative project authorization, connection revocation and apply-to-existing propagation remain incomplete. Credential refresh/revocation, cross-store management receipts and interrupted Pi/tool recovery require integrated qualification. Do not drop these requirements from acceptance or treat catalog snapshots, TypeScript or component checks as proof.

Source review also requires enforcing storage isolation below application query predicates, backend-verifiable management actor authority, and admission/shutdown tracking for MCP discovery/refresh and catalog callbacks before backup readiness. Durable resolved creation choices, directory/routing crash reconciliation, consistent external-ID translation and a fresh-workspace notice before resumed model work remain recovery requirements. Revocation across network waits needs an acknowledged ordering/barrier contract; another catalog fetch alone is insufficient. These are blockers, not limitations waived by a private startup rehearsal.

## Acceptance and evidence

Integrated acceptance checks below remain pending. Focused disposable-data checks are authorized; component/build checks do not establish application runtime correctness.

Component evidence reported October 7, 2026:

- [Installer qualification](https://github.com/dispatchlabs-ai/terraform-local-dispatch-workers/blob/f08308ac45c55046e92ec9ee48abb7d0ebabb426/docs/qualification.md): synthetic Omarchy install/reapply/update gating, not application drain or execution.
- Launcher: 18 injected-driver lifecycle checks; actual Docker probe: stopped creation, identity, retirement, two shell workers/replacement and persistent drain. Neither exercised Dispatch/Pi/model execution.
- AMD64 source-snapshot image checks: three wrappers, Node 24, non-root execution, no anonymous volumes and fresh writable workspaces. Receipt remains restricted in `.local/worker-qualification/image-build-1-result.json`; this is packaging evidence, not deployed application evidence.
- Runtime/remote-attachment slice `932e560` and S3 slice `f4e8371` are locally committed with focused checks reported passing. SDK/HTTP checks do not qualify worker artifact replacement or backup/restore.
- Actual Garage probe: SDK PUT/GET preserved text/image bytes and external-chat URLs, cross-store artifact lookup was rejected, native MIME/size validation was retained, and a reopened client retrieved existing bytes. Receipt: restricted `.local/worker-qualification/garage-result.json`. This is object-store compatibility evidence, not integrated conversation execution.

The initial private stack reports `backendQuiesced: false`; uncovered MCP writers mean the barrier is not yet trustworthy for backup/update acceptance.

Retain sanitized exact revisions/receipts with integrated results before claiming qualification. ARM64 runtime and AWS deployment are not qualified by AMD64 Omarchy checks.

- Two conversations execute in distinct worker containers/stores; all agents within each share its Pi runtime.
- Replace one worker with a fresh workspace while the other continues; old executor is confirmed stopped first. Recover pushed source and durable history, visibly identify fresh workspace and reconstruct unpushed work only under the specified policy.
- Commit one harmless tool result, interrupt a second; count invocations and external effects independently and verify completed work is not repeated.
- Lost launch/stop responses, repeated requests, launcher/backend restart and Docker unavailability reconcile the same attempt without overlapping execution. Late launch after stop cannot resurrect it.
- Drain survives restart, catches dynamic workers, blocks new admissions and gates upgrades/paired backups. Restore is isolated, preserves the applicable secrets/state and artifact bytes, and resolves restored attachment references.
- Preserve company/user/project isolation, membership, revocation, definitions, skills, grants and apply-to-existing behavior across active and dormant conversations; stale updates must not restore revoked credentials.
- Exercise browser sign-in, message streaming/reconnect, attachments, real model/tool execution and independent conversation replacement using agent-browser where applicable.
- TypeScript/application builds, separate ARM64/AMD64 image builds and inspection, source/deslop review and whitespace/link checks. Omarchy runtime evidence qualifies AMD64 only; retain explicit ARM64 runtime limits.
- Fix observed defects in owning source/module/runbook, rebuild and redeploy immutable pins, then repeat affected checks. Record exact revisions, sanitized receipts and remaining limitations here or in the owning handoff.
