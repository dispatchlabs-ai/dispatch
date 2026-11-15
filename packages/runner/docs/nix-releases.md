# Repo-owned Nix releases

The agent repository owns its application source, deployment declarations and
`flake.lock`. Dispatch owns the reusable build/runtime. Infrastructure owns
machines, Nix, identities, secrets, network and supervision. Never put secrets,
state or operational captures in a flake source.

Package an allowlisted source tree with the shared builder:

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

The default `bin/NAME` runs the shared connecting CLI. An application with its own
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

The launcher provides the same explicit host/client commands as npm installations.
Applications may add a newer watcher
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

## Complete definitions

`src` is the complete definition tree: agent instructions and TypeScript, skills,
local helpers and company integrations. The builder copies it unchanged, supplies
the runtime dependencies and loads every runnable definition to produce the
catalog. Relative links and imports refer to the same files in the checkout and
in the release. Nothing is inherited from a separate starter package.

Edit an agent's own files to customize it. Inspect changes with ordinary Git diffs.
Upgrade Dispatch by changing the pinned input and updating `flake.lock`, then build
and check the application. Runtime updates do not replace or append instructions.

A small complete example is in `examples/chat/definitions` in Dispatch. Build it
with `nix build .#agent-example`; `result/bin/example-agents catalog` lists its
helper without opening a store or connecting to a model.

## Evaluation

`withEval = true` installs the [evaluation package](../../eval/README.md), from the same Dispatch input as the
builder, so a company repository holds only its use-case packages:

```nix
dispatch.lib.mkAgentRelease {
  inherit system;
  name = "company-agents";
  src = source;
  revision = self.rev;
  withEval = true;
}
```

The release gains `bin/dispatch-eval`, the package's source, engine and synthetic example under
`lib/NAME/eval`, and a Python interpreter with the engine's dependency. Definitions can import
`@dispatch/eval/grading`, `@dispatch/eval/records` and `@dispatch/eval/task` beside Runner. `release.json`
gains `eval` with the package's revision and version, the launcher (`command`), the engine directory
(`engine`) and its interpreter (`python`). The launcher passes the release manifest to every evaluation, which
is how a run records its definitions commit, its Dispatch revision and whether either was dirty; evidence from
a dirty build is labelled as development evidence. The evaluation package is versioned with Runner, so
`withEval` with an `execution` of another version fails the build. It adds no agent to the company's
definitions or catalog. Without `withEval` the release contains no evaluation package.

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
restart an already-running process. The application operator handles idle/drain,
closed-state backup and supervised restart (see [application upgrades](upgrade.md)). The optional Fleet package
supplies worker ownership and retirement; ordinary releases remain inactive.

Binary rollback does not undo Pi schema changes.
Keep compatible closed-state backups. A rollout must preserve namespace,
adapters, tool/data bindings and store ownership; never open a second writer.
Company instruction paths are definition-root-relative, so a different release
store path alone does not change a definition fingerprint. Changes to instructions, roles or skills require an explicit idle definition update.

## Host and client commands

`bin/NAME catalog` loads complete definitions without credentials, stores or
inference. `bin/NAME-service HOST.json serve` explicitly starts a host using
absolute root, stateRoot, cwd and socket paths. The packaged definitions path is
recorded in `share/NAME/release.json`; use it as the host's root.

`bin/NAME --socket SOCKET run --agent helper --session main` connects a terminal.
The same session key returns to the same host conversation. `--history` reads
without creating one. Disconnect leaves work running; explicit Stop cancels.
No command creates a detached owner or chooses a machine-wide runtime version.
Use [the service guide](service.md) for configuration and the common client API.

`bin/NAME watch --config HOST.json --session .` inspects retained native state
without becoming its owner. Application entrypoints can provide their own commands
while retaining the same host/client boundary.
