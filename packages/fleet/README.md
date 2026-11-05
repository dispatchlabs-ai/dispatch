# Dispatch Fleet

`@dispatch/fleet` supplies a root-owned coordinator and replaceable Linux EC2
workers for complete Pi Durable runs. Stock Pi retains ownership of tasks,
conversations, commit receipts and recovery. An application supplies its trusted
native adapter and coordinator-side model, company and transport authority.

This package is source alpha. Type/build checks do not establish installation
qualification. Its first release requires deployment-specific Linux worker,
handoff, transport and recovery verification. See [use cases](USE_CASES.md),
[changes](CHANGELOG.md), and the repository's [check policy](../../CONTRIBUTING.md).

## Package an application

Use the shared Nix builder on `x86_64-linux`:

```nix
dispatch.lib.mkAgentRelease {
  inherit system;
  name = "example-agents";
  src = source;
  revision = self.rev;
  withFleet = true;
  workspace = builtins.fromJSON (builtins.readFile ./deployment/workspace-image.json);
  fleet = {
    module = "src/fleet-run.ts";
    namespace = "example";
    roles = [ "helper" ];
  };
}
```

The immutable release selects the Node executable, native host, adapter module,
native store names and prepared workspace image. Run admission cannot replace
these with model input. The application module exports
`createRun(context: FleetRunContext): Promise<FleetRun>`. It uses `context.storage`
for every harness, `context.env` for native tools, and `context.connectModels`
for model access. Its `command({tool: "cancel"}, signal)` must durably cancel
native tasks. When `assignment.cancelPending` is true, cancel retained tasks
before resuming any harness. `close()` suspends work; it does not cancel it.

Include the complete stock Runner message graph in one run. The host provides
no replacement agent workflow. Private delegates inherit the application's
bound environment through Runner's normal `prepareAgent`/`env` interfaces.

`scripts/package-release.py --application /nix/store/… --output release.tar.gz`
packages the complete closure and a small bootstrap archive. Keep its printed
checksums separately. Publish both archives through your installation's private
release bucket. `stage-release.py ARCHIVE --sha256 HASH --verify-only` verifies
without activation; staging on a non-Nix Linux host requires root. Existing
Nix-managed machines must use native Nix import instead.

## Install the ownership boundary

The installation owns AWS resources, IAM permissions, an HTTPS coordinator
origin, termination lifecycle hooks, and a TLS/IAM EFS access point. Worker
bootstrap must install Docker, `amazon-efs-utils`, `nftables` and AWS CLI, verify
the bootstrap archive checksum, then invoke:

```sh
python3 install-fleet-worker.py --config /etc/dispatch-fleet/config.json
```

The root-only configuration has `format: 1`, `region`, `asgName`, `controlUrl`,
`secretArn`, `efsId`, `efsAccessPointId`, `bucket`, `releaseKey`, `releaseSha256`,
`workspaceRoot: "/var/lib/dispatch-fleet/workspaces"`, `lifecycleHook`, and
`metricNamespace`. The secret contains a random `token` of at least 32 characters.
Workers receive no model, Slack, company, Git or upstream application credential.
Their instance role reads only the fleet secret and assigned release objects,
mounts their EFS access point, and obtains the configured workspace image.

On the coordinator, stage the same verified release and supply the configuration
above plus the application's root-only `relaySocket`. Install with
`install-coordinator.py --manifest MANIFEST`; add `--activate` only when ready.
Put HTTPS in front of port 8788. Stop the coordinator before its storage service
for upgrades and closed-state backups; `install-coordinator.py` refuses to replace
an active owner. Preserve `/var/lib/dispatch-fleet` and required release archives.

Only the application's trusted root adapter can use `FleetClient` over
`/run/dispatch-fleet/control.sock`. `ensure(run, release, input)` durably pins a
SHA-256 run identity, release reference and initial input. Later input uses
`command`; existing runs cannot change their original release or initial input.
`assignment` and `status` inspect root metadata without asking the native process.
`suspend` retains work, `cancel` persists cancellation intent before stopping,
and `finish` removes shared workspace/artifact bytes after the application has
verified its wanted outputs. Failed release acknowledgments retain ownership
until confirmed EC2 termination; elapsed lease time never authorizes a new writer.

The application relay receives `/v1/*`, `/company/*`, and `/events` with trusted
`X-Dispatch-Run` and `X-Dispatch-Epoch` headers supplied by the coordinator. It must
authorize the immutable assignment and its own current transport policy.
`context.emit` waits for the relay response; retain transport receipts before
acknowledging. Native processes cannot provide authority headers or reach the
root control socket. Never return upstream credentials in relay responses.

## Recovery and limits

Native SQLite stays on the coordinator's local disk, behind the Pi `Storage`
interface. Only source/workspace files and immutable artifact bytes use EFS.
Each worker has a DynamicUser per run; the root worker reassigns artifact ownership
only after the previous host is fenced. The guest may bind only that run's exact
`/workspace` directory. Existing persistent files supersede an older checkpoint.

Workers report CPU/memory pressure. Sustained pressure can move a run to healthy
spare capacity through the same stop/release boundary; independent runs have no
configured concurrency cap. Lost coordinator contact suspends native work and
guest processes, then exits with failure so systemd reconnects. A restarted host
with previous assignments drains for fenced replacement. Long shell commands
do not hold the lifecycle fence. Failed effects and uncertain commits are not
blindly retried by transport; applications reconcile native receipts.

This fleet does not add a second coordinator or replicate its local databases.
Application credentials, routing, permissions, schedules, publication policy and
retained pre-fleet assignments remain the owning installation's responsibility.

## Slack applications

The optional root host installer uses a trusted entry point inside the immutable
definitions, defaulting to `src/fleet-host.ts`:

```sh
install-slack-host.py --manifest MANIFEST --config HOST.json --credentials-dir CREDENTIALS
```

The configuration and credentials directory must be private and root-owned. The
directory contains `slack`, `inference`, `wiki-config`, and `wiki-key` files; systemd
passes them through `LoadCredential`. Installation leaves the service inactive
unless `--activate` is supplied and refuses to replace an active owner.

The root host connects the supervisor to Fleet and authenticates its relay:

```ts
import { FleetClient, FleetSlackThreads } from "@dispatch/fleet";
import { startFleetRelay } from "@dispatch/fleet/relay";
import { runSlackHost } from "@dispatch/slack";

const client = new FleetClient();
const bridge = new FleetSlackThreads({ client, release: resolveRetainedRelease });
const relay = await startFleetRelay({ ...trustedRelayOptions, client, bridge });
await runSlackHost({ ...trustedHostOptions, executeThread: bridge.execute,
  async close() { await trustedHostOptions.close?.(); await relay.close(); },
});
```

The installation supplies the trusted options and maps each retained Slack
launch to its original `FleetRelease`. Its native adapter uses
`createFleetSlackRun` to open the complete message graph with `context.storage`
and `context.env`. Only the root supervisor opens Slack Socket Mode; remote
delivery uses the run-bound API relay and awaits durable stream receipts.
