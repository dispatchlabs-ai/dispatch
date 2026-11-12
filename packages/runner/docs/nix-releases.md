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
[read-only terminal watcher](watch.md), and `NAME upgrade` to the selected
execution Runner's [machine upgrade command](upgrade.md). Applications may add a newer watcher
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

## Starter kit

`withKit = true` composes the [kit](../../kit/README.md) of generic agents and
skills under the company tree, so a company repository holds only its own
definitions. A new repository can start from the kit's flake template,
`nix flake init -t github:dispatchlabs-ai/dispatch/TAG#kit`. The kit comes
from the same Dispatch input as the builder:

```nix
dispatch.lib.mkAgentRelease {
  inherit system;
  name = "company-agents";
  src = source;
  revision = self.rev;
  withKit = true;
}
```

The builder writes the kit's `agents/`, `skills/` and `kit/` first and the
company `src` on top, giving the one definitions root Runner reads.

- A company path the kit does not use is added unchanged.
- `agents/ROLE/company.md` is appended to the kit's `agents/ROLE/agent.md`. Use
  it for company context a generic role lacks. It must name a kit role that the
  company does not also replace.
  `DIR/NAME.company.md` is appended the same way to any other kit Markdown
  file, such as a role's `operations.md`.
- `kit.json` can omit a kit agent or skill, by file or directory, with a reason:
  `{ "omit": { "skills/development": "Uses its own cleanup skill" } }`.
- `kit.json` can set a kit role's model:
  `{ "models": { "developer": { "provider": "openai", "id": "gpt-6-astra", "thinking": "high" } } }`.
- A company file at a kit path is a replacement. Declare each one with a reason
  in `kit.json` at the company root, or the build fails:

  ```json
  { "replacements": { "agents/developer/agent.md": "Uses the company's own delivery stages" } }
  ```

  A declaration naming no kit file, or no company file, fails too.
- `kit.json` can change a kit role's message recipients, delegates and
  extensions without replacing its `agent.ts`:
  `{ "roles": { "jett": { "messages": { "add": ["researcher"] } } } }`.
  The [kit guide](../../kit/README.md#company-changes) describes the forms.

`release.json` gains `kit` with the kit's revision and version, and
`share/NAME/kit.json` lists the applied replacements, omissions, model and role
changes and addenda. Without `withKit` the release contains exactly `src` and
neither record. Adopting the kit or moving its pin changes definitions; apply
that through the ordinary idle definition update.

A replaced file stops receiving the kit's changes. `kit.lock.json`, written by
the kit's `accept` command, records the kit a repository was last checked
against. When a replaced file's kit original has changed since, or has no
record, the build prints a warning, keeps it in `share/NAME/kit-warnings.txt`,
and the default launcher repeats it before `NAME catalog`. See
[moving to a new kit](../../kit/README.md#moving-to-a-new-kit).

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
definitions or catalog and composes with `withKit`. Without `withEval` the release is built exactly as before.

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
drain, closed-state backup and supervised restart; `NAME upgrade` does this for
a whole machine from one declaration (see [upgrading a machine](upgrade.md)). The optional Fleet package
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
A session follows the selected release: changed definitions apply once its saved
work is idle, and one state root runs one Pi Durable version (see [service](service.md#one-pi-durable-per-state-root)).
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
Each session stores agents under `stateRoot/KEY/`. The selected agent and its
transitive `message_agent` recipients share one detached native owner in that
exact directory. Reopening the same session joins its owner; separate sessions
remain independent. Do not aim this launcher at another service's stores.
Native same-store locking remains authoritative.
Every participant can read its packaged instructions and linked workflow
references through `read_definition_resource`, including host-bound sessions.

Normal `run` starts or discovers an owner-only local socket automatically. No
factory schedules, calendar reconciliation or transport adapters are started.
The CLI is a client: exit or SIGINT/SIGTERM disconnects without stopping execution.
Prompt mode waits for the native receipt and drains admitted peer work and replies,
including on host-bound desktops. The detached owner remains available afterward.
Use explicit `/stop` (or Web Stop) to cancel native work. `--history` reads the
retained terminal key without starting an owner, including for legacy sessions.
See [ordinary session ownership and controlled recovery](service.md#ordinary-session-owners).
The trusted process binding `DISPATCH_SESSION_STATE_ROOT` gives definition-owned
inspection tools the selected session directory; it grants no new permissions.
This is not a scheduler,
whole-tree cancellation API or automatic integration of external services.
