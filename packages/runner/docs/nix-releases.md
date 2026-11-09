# Repo-owned Nix releases

The agent repository owns its application source, deployment declarations and
`flake.lock`. Dispatch owns the reusable build/runtime. Infrastructure owns
machines, Nix, identities, secrets, network and supervision. Never put secrets,
state or operational captures in a flake source.

Compose an allowlisted source tree with the shared builder:

```nix
dispatch.lib.mkAgentRelease {
  system = "x86_64-linux";
  name = "company-agents";
  src = source;
  revision = self.rev or self.dirtyRev or "uncommitted";
}
```

Pin `dispatch` and follow its `nixpkgs` input in the application lock. The
builder includes Node 24, Runner/Pi dependencies and physically nested
definitions, with no installation on the target. It imports every runnable
definition during the build and writes `share/NAME/{catalog,release}.json`.
`dispatch.lib.agentRuntime { inherit system; }` exposes the same patched Node,
Git, SSH, curl and Python selections for a company's business-dependency build
and isolated workspace toolchain. Do not select an older Node from raw nixpkgs.
The release records both the application commit and the Dispatch commit; they
belong to different repositories. The store path identifies the complete build.
Dirty/local revisions are for qualification, not published release provenance.

The default `bin/NAME` runs the shared on-demand CLI. An application with its own
host can supply `entrypoint = "src/main.ts"`; it is run with the packaged Node.
That host still owns native initialization, adapters, signals and recovery.
Applications hosting replaceable workers can select `withFleet = true` and a
trusted `fleet` descriptor; see [Fleet packaging and installation](../../fleet/README.md).
The base runtime contains Runner, not Web. Set `withSlack = true` for the pinned
Slack adapter. Other adapters are not included. An optional `nodeModules` store
path supplies separately locked business dependencies under the definitions,
without a second Runner/Pi tree. The builder never installs dependencies on the
target. `dispatch-native-tools` supplies the model-free worker endpoint described
in [isolated native tools](isolated-native-tools.md).

The default launcher also routes `NAME watch --config HOST.json` to the separate
[read-only terminal watcher](watch.md). Applications may add a newer watcher
without changing the runtime that owns their agent state:

```nix
tools.lib.mkAgentRelease {
  inherit system;
  name = "company-agents";
  src = source;
  revision = self.rev;
  execution = {
    package = pinnedDispatch.packages.${system}.runner;
    revision = pinnedDispatch.rev;
  };
}
```

Here `tools` and `pinnedDispatch` are separately locked Dispatch inputs. Omit
`execution` to use the builder's own Runner. The execution package and its source
revision must describe the same artifact; supply `runner-slack` when that pinned
execution needs Slack. `release.json` records execution under `dispatch` and the
viewer separately under `watch`. All execution commands and `runtimeEntryPoint`
continue to use the selected execution package. Custom application entrypoints
own their own command routing.

## Build, publish, activate

Build on the target OS/architecture using a clean, published application revision:

```sh
nix build .#default
nix flake check
RELEASE=$(readlink -f result)
cat "$RELEASE/share/company-agents/release.json"
nix path-info --json "$RELEASE" > release-receipt.json
nix copy --to ssh://operator@host.example.com "$RELEASE"
```

Copying publishes the closure to that host's store; it does not select or start
it. Existing Nix SSH permissions and trust must already be provisioned.
Alternatively publish through an infrastructure-managed binary cache. Keep the
manifest, source revisions and store/NAR identity in the release record.

On the target, explicitly select that store path in a dedicated profile:

```sh
PROFILE="$HOME/.local/state/nix/profiles/company-agents"
mkdir -p "$(dirname "$PROFILE")"
nix-env --profile "$PROFILE" --set /nix/store/STORE-company-agents-REVISION
readlink -f "$PROFILE"
"$PROFILE/bin/company-agents" catalog
# Deliberate rollback of binary selection:
nix-env --profile "$PROFILE" --rollback
```

Nix profile generations retain previous closures and change the selection
atomically. Do not remove generations needed for rollback. Activation does not
restart an already-running process. Service deployments need their own idle/
drain, closed-state backup and supervised restart. The optional Fleet package
supplies worker ownership and retirement; ordinary releases remain inactive.

Binary rollback does not undo Pi schema changes or native definition migrations.
Keep compatible closed-state backups. A rollout must preserve namespace,
adapters, tool/data bindings and store ownership; never open a second writer.
Company instruction paths are definition-root-relative, so a different release
store path alone does not change a definition fingerprint. Stores created before
this correction still require an explicit idle definition migration once; actual
instruction, role or skill changes continue to require it.

## On-demand CLI

`bin/NAME catalog` loads definitions without credentials, stores or inference.
`run --config HOST.json --agent helper --prompt "..."` creates a random session;
`--session KEY` reopens an explicit one. `--history` replaces the prompt.
`--update-definitions` explicitly opts into Runner's existing idle migration.
`watch --config HOST.json` discovers running sessions without opening a runtime;
`watch --session KEY` also inspects stopped work. Viewer exit leaves owners running.

HOST.json contains `stateRoot`, `cwd`, `namespace`, `gateway`, optional
[`modelProviders`](service.md#local-model-providers), and optional `retry`,
`compaction` and `afterFailedRun` [host policies](service.md#compaction-and-queued-input-recovery)
from the [service configuration](service.md). State and working-directory paths
are absolute. The definition root is supplied by the immutable release.
The launcher changes its process directory to `cwd` (or the session state
directory for a container workspace) before opening agents, so host-side
provider subprocesses do not depend on the caller's directory. A task may remove
the worktree it was launched from without breaking later turns.
Each session stores agents under `stateRoot/KEY/`; do not aim this launcher at
an existing service's stores. The selected agent and its transitive
`message_agent` recipients share one native service in that process. Separate
sessions run concurrently; same-store locking remains authoritative.
Every participant can read its packaged instructions and linked workflow
references through `read_definition_resource`, including host-bound sessions.

No socket, scheduled work or transport adapter is started. Output streams through
the existing terminal client. SIGINT/SIGTERM suspend native work; restarting
resumes admitted work, not calendars. Sessions with messaging recipients drain
admitted peer work and replies before exiting, including on host-bound desktops.
The trusted process binding `DISPATCH_SESSION_STATE_ROOT` gives definition-owned
inspection tools the selected session directory; it grants no new permissions.
This is not a scheduler,
whole-tree cancellation API or automatic integration of external services.
