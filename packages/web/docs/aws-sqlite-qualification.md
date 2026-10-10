# AWS SQLite and recovery qualification

**Historical SQLite AWS candidate procedure; live qualification was not completed.** The standalone [PostgreSQL/conversation-worker module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch) is the supported new AWS installation path. This procedure preserves earlier SQLite probe mechanics and evidence, not prerequisites for that module. The local probe rehearsal below is not AWS evidence. This is the focused disposable-state qualification authorized for the [AWS container target](spec.md#aws-container-deployment-target), not a general application test suite. Do not use an existing personal or team installation. A build, successful mount, healthy ALB target, or clean SQLite integrity result alone does not establish application recovery.

Use the exact candidate image and module revisions. Record results in the deployment work package's acceptance criteria and the installation's private deployment record. Stop qualification and retain failure evidence if an invariant below fails; do not promote the installation to real data.

## Source basis and limits

Reviewed application source: `f0449e9`, Pi Durable `1.0.4`, Node 24. Recheck these observations against the candidate before running:

- [`runtime-owner.ts`](../server/runtime-owner.ts) holds an exclusive SQLite transaction in `runtime/runtime-owner.sqlite`. It is filesystem locking, not a distributed lease or a scheduler.
- [`index.ts`](../server/index.ts) opens authentication before acquiring that lock. [`auth/store.ts`](../server/auth/store.ts) creates tables and selects WAL; [`auth.ts`](../server/auth.ts) loads the encryption key and removes expired records. A rejected competing startup can therefore touch authentication state.
- Constructing [`McpConnections`](../server/mcp-connections.ts) does **not** open its database. `initialize()` runs inside [`DispatchRuntime.open()`](../server/runtime.ts) after the owner lock, before opening Pi storage. MCP recovery marks interrupted credential renewals as requiring reauthorization; do not expect every interrupted OAuth exchange to resume automatically.
- Shutdown stops HTTP admission, closes the native harness and agent connections, releases the runtime lock, then closes managed MCP and authentication. Lock availability alone is not evidence that the whole task has exited.
- [`auth-cli.ts`](../server/auth-cli.ts) opens authentication without taking the runtime lock. For this deployment, run separate enrollment/recovery helpers only while the service is stopped and all prior tasks have exited. This avoids relying on unqualified cross-client WAL access.
- [Pi 1.0.4](https://github.com/earendil-works/pi/tree/v1.0.4/packages/durable) uses SQLite WAL with `synchronous=NORMAL`. Process-crash recovery is not a zero-loss guarantee for host/power/storage failure. Recovery of an interrupted tool is governed by its replay policy, not exactly-once external execution.

[Prior Palm/AWS evidence](https://wiki.chrisreynolds.me/wiki/portable-application-deployment/#section-limits-and-everyday-team-use) establishes same-task WAL exclusion and crash recovery for earlier applications. It does not establish this application's recovery or exclusion across distinct Fargate mount clients. Preserve that distinction in the new result.

## Preconditions and evidence

Before any AWS mutation, review the isolated installation plan, identity/account/region, cost and cleanup disposition. Use synthetic accounts, harmless model/tool operations, and a disposable authenticated MCP endpoint. Never put credentials, invitation URLs, database contents, or raw auth/MCP responses in public logs or Git.

Record privately:

- Application commit, OCI digest, module commit, Terraform and OpenTofu versions, AWS provider version, task-definition revision, Fargate platform, Node/SQLite/Pi versions.
- Filesystem/access-point identities, mount configuration, POSIX UID/GID, service desired count and replacement settings, task-role policy, ALB configuration and the exact persistent paths.
- Every service/helper/contender task ARN, purpose, start/stop timestamps, exit code and termination reason. Track standalone tasks as well as service tasks.
- Synthetic fixture IDs, acknowledged message IDs, attachment/workspace hashes, expected rows for the probe below, and sanitized check results.

The proposed container paths are `/data/state`, `/data/workspace` and `/data/home` with UID/GID 65532. Resolve the actual candidate contract first. Record `DISPATCH_PI_AGENT_DIR` and `DISPATCH_AGENT_CONNECTIONS_FILE` if overridden. The provider store is normally `$HOME/.pi/agent`; preserve the entire store, not just `auth.json`.

Helpers must use the candidate's Node/SQLite runtime and exact mount configuration. Use approved task-definition/entrypoint overrides; do not bake fixture credentials into a helper image. Operational command transport and private result collection must be settled before testing, particularly when ECS Exec is disabled. Do not grant the application deployment-admin permissions to run the procedure.

## 1. Establish a baseline

1. Keep desired count zero. Confirm every previously tracked task is `STOPPED` and no other task or operator process uses the mount. A successful stop request, missing target, missing PID, timeout, or expired lock is insufficient.
2. Run one stopped-service enrollment helper using `dispatch-auth invite` for two synthetic users with the candidate's origin/company/data configuration. Deliver links privately. Wait for helper exit before starting the service.
3. Start one service task. Complete both users' enrollment using the final qualification origin. Include password/TOTP to exercise encrypted authentication state; passkeys alone do not establish TOTP key continuity.
4. Use both sessions concurrently. Create a shared conversation, submit identifiable synthetic messages from each user, and record the acknowledged IDs. Preserve a private conversation and confirm the other account cannot access it through the application.
5. Upload a harmless attachment and record its downloaded SHA-256. Have a coding agent write and read a harmless workspace sentinel. Record a completed native turn and its conversation ID.
6. Connect a disposable authenticated MCP service and perform one harmless authenticated operation. Record success without exporting credentials. This supplies evidence for `connections.key` decryption after replacement and restore. If the endpoint/credential is unavailable, mark that criterion unverified rather than treating an empty database as sufficient.
7. Observe browser streaming/reconnection through the ALB, including an idle interval longer than its configured idle timeout. Source-level heartbeat configuration is not an executed transport check.

## 2. Cross-task owner exclusion

This deliberately violates normal deployment sequencing **only on this isolated synthetic store**. It does not authorize rolling production writers.

1. Keep service task A running and confirm a normal authenticated operation succeeds. Record its ARN and fixture state.
2. Launch standalone contender B from the same image with the same filesystem, access point, UID/GID, company/origin, provider configuration and persistent paths. It must be a different Fargate task/client, not a second process in A. Do not attach B to the ALB.
3. Require B to exit nonzero with the runtime-owner rejection from `acquireRuntimeOwner`. A mount/IAM/configuration error, auth `SQLITE_BUSY`, health failure or startup timeout is **not** proof of successful owner exclusion. Capture the actual failure stage. B must never report a listening service or resume native work.
4. Confirm A remains usable and can commit another synthetic message. Repeat sign-in, attachment retrieval and authenticated MCP use. Authentication initialization precedes owner rejection; do not claim that B touched no application state.
5. Confirm B is `STOPPED`; stop A using the reviewed service operation and confirm A is `STOPPED`. Run the offline integrity check below, then restart a single owner and verify continuity. Unexpected lock failures, corruption or lost acknowledged state block qualification.

Run this check again for the exact storage/client configuration used for deployment; success is not a general distributed-filesystem guarantee.

## 3. Graceful replacement and abrupt interruption

**Graceful:** replace the task using the candidate module's documented stop-before-start procedure while synthetic work is active. Record old/new task ARNs and timestamps. Require proof that the old task stopped before the new owner started, and no manual recovery or data reset was needed. Recheck the entire baseline, not just ALB health.

**Abrupt:** use an explicitly reviewed fault-injection action on the synthetic service to kill the application without its SIGTERM cleanup. Record how the process was terminated and confirm the old task has reached `STOPPED` before opening the store with another task. `ecs stop-task` normally sends SIGTERM; do not label that as SIGKILL/crash evidence unless the recorded termination proves it. Suspend automatic replacement for the experiment if necessary to retain stop-before-start control, and restore the reviewed desired configuration afterward.

Interrupt both an active native model/tool turn and repeated synthetic user-message submissions. Retain client acknowledgement IDs outside the task before interruption. After reopening:

- All acknowledged pre-crash messages and completed baseline operations must remain present. A request without an acknowledgement has an uncertain outcome; inspect the restored history and reuse its original request identifier if retrying through the API. Do not blindly create a second operation.
- Native work must reach an explainable recovered or interrupted outcome. Pi owns recovery; do not edit task rows or invent completion markers. Interrupted non-replay-safe external tool calls need not rerun and must not be described as exactly-once.
- Sign-in/TOTP, existing conversation access, attachment bytes, workspace sentinel and authenticated MCP operation must still work. An interrupted OAuth renewal may legitimately require reauthorization; test ordinary decryption separately from that documented path.
- After confirmed task exit, all databases must pass offline integrity checks.

### Deterministic interrupted-write probe

Run this supplementary storage probe in a **separate disposable qualification directory**, never an application database or a live application's state directory. The service should be stopped. It tests WAL rollback after a killed writer using the candidate runtime; it does not substitute for the application interruption above.

From a qualification-only Node helper, run the following against a fresh `PROBE_DB` path under the same persistent mount. The child uses a small cache and approximately 4 MiB of synthetic writes to spill uncommitted WAL frames. The parent waits for that signal, then kills it without graceful cleanup. The local rehearsal below verifies this snippet's mechanics; it must still run on the candidate Fargate/S3 Files configuration.

```js
// Run with the candidate's Node 24, e.g. node --input-type=module < probe.mjs.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const path = process.env.PROBE_DB;
if (!path || existsSync(path)) throw new Error('Supply a fresh disposable PROBE_DB');
const db = new DatabaseSync(path);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
  CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO probe VALUES (1, 'committed');`);
db.close();
const child = spawn(process.execPath, ['--input-type=module', '-e', `
  import { DatabaseSync } from 'node:sqlite';
  import { statSync } from 'node:fs';
  const db = new DatabaseSync(process.env.PROBE_DB);
  db.exec("PRAGMA synchronous=NORMAL; PRAGMA cache_size=10; BEGIN IMMEDIATE;");
  db.exec("WITH RECURSIVE ids(id) AS (VALUES(2) UNION ALL SELECT id+1 FROM ids WHERE id<1025) INSERT INTO probe SELECT id, hex(zeroblob(2048)) FROM ids;");
  if (statSync(process.env.PROBE_DB + '-wal').size <= 32) throw new Error('No spilled WAL frames');
  process.stdout.write('WRITE_PENDING\\n');
  setInterval(() => {}, 1000);
`], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
let signaled = false;
let output = '';
child.stdout.on('data', chunk => {
  output += chunk.toString();
  if (!signaled && output.includes('WRITE_PENDING\n')) {
    signaled = true;
    child.kill('SIGKILL');
  }
});
const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);
if (!signaled || result.signal !== 'SIGKILL') throw new Error('Fault injection not established');
console.log('Writer killed after uncommitted insert; reopen from a separate task');
```

After that helper is confirmed `STOPPED`, open `PROBE_DB` from a **different Fargate task/mount client**, using Node `DatabaseSync`. Require `PRAGMA integrity_check` to return `ok` and `SELECT * FROM probe ORDER BY id` to return only `{id: 1, value: 'committed'}`. Insert and commit row 3, close, and verify rows 1 and 3 from one further replacement task. Keep expected and actual rows in the evidence. Do not delete WAL/SHM/journal files to make recovery succeed.

### Local probe rehearsal — October 7, 2026

The exact embedded probe extracted from application revision `7410e27` passed on Omarchy with the candidate's pinned Nix Node 24.21.0 binary (`/nix/store/frlyjd2wya3rk8xmdc98yq3x0rhpkh9n-nodejs-24.21.0/bin/node`), SQLite 3.51.2. The probe script SHA-256 was `5649a5a6f7878f177e0fa1015876a9bcdc6ee009400144cdbd7020ebddeafc99`.

- The writer signaled spilled uncommitted WAL frames and was terminated with SIGKILL.
- A separate sequential Node process reopened the database: integrity was `ok`, and only committed row 1 remained. It committed row 3.
- One further fresh Node process reopened it: integrity remained `ok`, with exactly rows 1 and 3.

Evidence and the synthetic database are retained in `/home/chris/.local/sqlite-probe-rehearsal.dC7HcW` on Omarchy; local scripts/log copies are ignored under `.local/sqlite-probe-rehearsal/` in the M1 Air checkout. No application data, credentials or live service was used or changed. This was unprivileged host execution on local storage, **not** Docker, a container identity/capability check, cross-task/cross-client storage, an application/native-work recovery check, or S3 Files qualification. It establishes that the probe mechanics work, not that the deployment acceptance criteria pass.

## 4. Offline database integrity

Only run after the service and all other helpers/contenders are positively stopped. A helper opening SQLite may perform recovery and create/update WAL sidecars; it is itself a storage client. Do not set `immutable=1`, disable locking, or delete journals to bypass failures.

For each existing database below, open it with the candidate's Node `DatabaseSync`, run `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, and close it. Require exactly `ok` from integrity checking and no foreign-key violations. Check file existence first: a misspelled path must not silently create an empty database. Retain only check results, not table contents.

- `$DISPATCH_DATA_DIR/auth.sqlite`
- `$DISPATCH_DATA_DIR/connections.sqlite`
- `$DISPATCH_DATA_DIR/runtime/pi.sqlite`
- `$DISPATCH_DATA_DIR/runtime/runtime-owner.sqlite`

Record each filename and outcome separately. Stop that helper before resuming the service. Integrity checks establish database structure, not message completeness or credential/attachment continuity.

## 5. Independent backup and restore

1. Stop all service/helper tasks and confirm terminal status. Take an access-controlled stopped-service copy of the entire persistent installation: authentication/MCP databases and their matching keys; full runtime directory including attachments and agent-connection configuration; workspace; complete provider store; externally overridden connection/configuration files. Preserve journal/sidecar files if present. Keep secrets outside Git and ordinary logs.
2. Retain the backup and a private checksum manifest independently of the source filesystem. A running filesystem's asynchronously visible S3 objects are not automatically a consistent multi-database backup; do not substitute bucket listing/copy for the reviewed stopped-filesystem backup mechanism.
3. Restore into a distinct disposable filesystem/access point, not merely another directory alias to the original. Restore matching ownership and original absolute container paths. Use the same origin when verifying original passkeys; do not silently treat a new relying-party hostname as a persistence failure. Route only to the restored installation during that check.
4. Run offline integrity checks, stop the helper, then start one restored service task. Verify both users' sign-in, shared/private access, acknowledged histories, attachment and workspace hashes, and authenticated MCP use. Commit fresh messages and workspace writes on the restore.
5. Confirm the restored installation does not depend on source-store access. Record the backup's recovery point and resulting recovery time; do not claim zero-loss failover.

## 6. Task-role boundary check

Use both live authorization probes and operator-side policy simulation, as selected by Security Engineer. Use approved synthetic fixture resources only; never probe unrelated customer installations, export task-role credentials, or add administrative permissions to the application role. The module's direct S3 reads bypass mount POSIX permissions; include those grants, not just the S3 Files access-point condition.

- **Live direct-S3 probes:** from an approved helper running in the application task's security context, obtain credentials through the normal container credential provider without printing them. Require successful `GetObject`, `GetObjectVersion` (where a fixture version exists) and `ListBucket` requests for the installation's exact backing prefix. Make the matching requests against a known-existing disallowed fixture prefix/version and require explicit authorization denial. Record action, synthetic resource identity, service error and request ID, not object bytes or credentials. A 403/`AccessDenied` is authorization evidence; it does not by itself identify which IAM/resource/SCP policy caused the denial.
- **Live mount exclusion:** the allowed installation mount must work. For the disallowed fixture access point, Deployer must select a supported Fargate volume-mount experiment using the same task role and otherwise valid fixture networking/POSIX configuration. Require an explicit service authorization failure, not generic task-start failure. Do not add mount capabilities or privileged execution to the application to manufacture this check. If Fargate's diagnostics cannot distinguish authorization from configuration/transport failure, keep this live criterion unverified.
- **Operator-side simulation:** using the operator identity, simulate the attached task policy (or the rendered policy documents) for `s3files:ClientMount` and `s3files:ClientWrite` with the allowed filesystem `Resource` and allowed versus disallowed `s3files:AccessPointArn` context. Also include missing context, another fixture filesystem and disallowed management actions. Require the expected allow/deny decisions. Simulate direct S3 object/version actions and `ListBucket` with allowed versus out-of-prefix `s3:prefix` context. Preserve the exact policy hash and supplied simulation context. Simulation permissions stay with the operator, never the task role.

A shell's inability to run `mount`, a missing CLI, or network failure is not proof of authorization denial. Policy simulation is supporting evidence, not service enforcement or proof of every applicable resource policy. Report only tested resource/action boundaries; a few negative checks cannot prove that nothing anywhere is reachable. This does not isolate coding agents from other files/secrets deliberately mounted within their own installation, including retained S3 object versions readable through the scoped direct-read grants.

## Completion

Attach results for baseline continuity, cross-task exclusion, graceful replacement, abrupt application recovery, deterministic interrupted writes, all four integrity checks, independent restore and the scoped IAM checks to the work package. Keep unexecuted or blocked checks explicit. List defects, mitigation and any retest with the new exact image/module identities.

No real accounts/data should be admitted until the storage/recovery acceptance criteria pass. The installation record must also identify retained backups, fixture resource cleanup, restored service settings and the next reviewed deployment action. These outcomes qualify the measured configuration, not arbitrary scaling, overlapping writers, another filesystem mode or a later Pi/image release.
