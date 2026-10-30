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
The release records both the application commit and the Dispatch commit; they
belong to different repositories. The store path identifies the complete build.
Dirty/local revisions are for qualification, not published release provenance.

The default `bin/NAME` runs the shared on-demand CLI. An application with its own
host can supply `entrypoint = "src/main.ts"`; it is run with the packaged Node.
That host still owns native initialization, adapters, signals and recovery.
The base runtime contains Runner, not Web. Set `withSlack = true` for the pinned
Slack adapter. Other adapters are not included. An optional `nodeModules` store
path supplies separately locked business dependencies under the definitions,
without a second Runner/Pi tree. The builder never installs dependencies on the
target. `dispatch-native-tools` supplies the model-free worker endpoint described
in [isolated native tools](isolated-native-tools.md).

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
drain, closed-state backup and supervised restart; this pilot supplies no fleet
manager, updater or automatic service activation.

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

HOST.json contains `stateRoot`, `cwd`, `namespace`, `gateway` and optional `retry`
from the [service configuration](service.md). State and working-directory paths
are absolute. The definition root is supplied by the immutable release.
Each session stores agents under `stateRoot/KEY/`; do not aim this launcher at
an existing service's stores. The selected agent and its transitive
`message_agent` recipients share one native service in that process. Separate
sessions run concurrently; same-store locking remains authoritative.

No socket, scheduled work or transport adapter is started. Output streams through
the existing terminal client. SIGINT/SIGTERM suspend native work; restarting
resumes admitted work, not calendars. Independent message recipients may still
have suspended work when the foreground turn ends. This is not a scheduler,
whole-tree cancellation API or automatic integration of external services.
