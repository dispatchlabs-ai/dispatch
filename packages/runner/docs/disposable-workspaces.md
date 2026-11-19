# Disposable development workspaces

A host can bind a native run to an immutable application release and give its
coding tools a separate Linux desktop. Native conversations, model credentials
and tool/task ownership stay in the host process. Code, browsers, package
installs and nested Docker run in a digest-pinned image under gVisor. The guest
has no host mounts or host credentials. This is an opt-in Linux host integration;
ordinary terminal and service installations retain their existing behavior.

The application release supplies a `workspace` descriptor to `mkAgentRelease`:

```json
{
  "format": 1,
  "contract": "dispatch-workspace-v1",
  "platform": "linux/amd64",
  "image": "registry.example.com/workspace@sha256:<64 hexadecimal characters>",
  "sourceRevision": "<40 hexadecimal characters>"
}
```

From a clean Dispatch checkout at the chosen image source revision, use Docker
Buildx and `jq` to build and publish the image below. Replace the example
registry/repository with one you control and authenticate Docker to it first.
The build requires the exact
40-character `WORKSPACE_SOURCE_REVISION` argument; it is recorded in the image.

```sh
WORKSPACE_SOURCE_REVISION="$(git rev-parse HEAD)"
WORKSPACE_IMAGE_REPOSITORY=registry.example.com/team/agent-workspace
docker buildx build \
  --platform linux/amd64 \
  --build-arg WORKSPACE_SOURCE_REVISION="$WORKSPACE_SOURCE_REVISION" \
  --tag "$WORKSPACE_IMAGE_REPOSITORY:$WORKSPACE_SOURCE_REVISION" \
  --metadata-file /tmp/dispatch-workspace-image.json \
  --push packages/runner/workspace-image
jq -r '."containerimage.digest"' /tmp/dispatch-workspace-image.json
```

Use the printed digest as `REPOSITORY@sha256:...` in the descriptor and the same
source revision in `sourceRevision`. Retain the build metadata with the release
record. The controller checks the image digest, platform, contract and source
labels before launch. An ordinary image tag is not accepted.

The image includes a Cua server and a credential-free developer desktop. The
host must supply Docker, gVisor, Cua CLI, nftables and reachable DNS. On a Linux
x86_64 host with Nix flakes enabled, the pinned Cua and gVisor packages can be
built from a published Dispatch revision. Run from a clean checkout of that
revision:

```sh
WORKSPACE_TOOLS_REVISION="$(git rev-parse HEAD)"
nix build "github:dispatchlabs-ai/dispatch/$WORKSPACE_TOOLS_REVISION#workspace-cua" \
  --out-link result-workspace-cua
nix build "github:dispatchlabs-ai/dispatch/$WORKSPACE_TOOLS_REVISION#workspace-runsc" \
  --out-link result-workspace-runsc
readlink -f result-workspace-cua
readlink -f result-workspace-runsc
```

Append `/bin/cua` and `/bin/runsc` to the respective resolved store paths in
host-owned configuration. Keep these output links or equivalent GC roots while
the tools are installed. The gVisor output includes adjacent helpers; retain the complete
output rather than copying only `runsc`.

The configured Docker runtime must
use `--net-raw`, `--allow-packet-socket-write`, `--allow-suid`, and
`--overlay2=none`. Runtime names are host-owned. Provision a dedicated bridge and
its nftables rules with `configure-network` before admitting work. Use nftables
with JSON support (`nft -j`). The rules block guest access to new host connections,
other workspaces on that bridge and cloud instance metadata. The Cua control
port is bound only to host loopback.

`ensure` refuses to create or start a workspace if the Dispatch-managed table
is missing or does not contain the expected chains and rules. Keep custom rules
in a separate table. Containers never restart automatically: after a host reboot
or firewall reset, restore the policy with `configure-network` before admitting
workspace operations.

## Host controller

The release manifest includes `workspaceController`, `python`, `definitionsRoot`,
`runtimeEntryPoint`, and the descriptor. Invoke its Python controller with
`--config /absolute/host.json`; send one JSON request on standard input. Python
3.11 or later is required. The host config and release directories must be owned
by the controller identity and not writable by other users. Its state root and
artifact directory must be private. Install a fixed privileged helper when the
native process runs as a different user; do not let guest arguments choose the
controller config or executable.

```json
{
  "format": 1,
  "namespace": "example-development",
  "stateRoot": "/var/lib/example-workspaces",
  "allowedReleaseRoots": ["/nix/store"],
  "runtime": "workspace-runsc",
  "network": "example-workspaces",
  "bridge": "example-ws",
  "firewallTable": "example_workspaces",
  "docker": "/usr/bin/docker",
  "cua": ["/opt/cua/bin/cua"],
  "dns": ["1.1.1.1"],
  "storage": { "kind": "directory", "path": "/var/lib/example-artifacts" }
}
```

An S3 store uses `kind: "s3"`, `region`, `bucket`, and `prefix` instead of `path`.
Enable bucket versioning. The controller records and verifies object version,
length and SHA-256; cloud credentials remain on the host. The optional `aws`,
`nft`, `nixStore` executable paths and `cuaEnv` are also host-owned.

| Operation | Request and result |
| --- | --- |
| `bind` | `run`, `release: {definitionsRoot, runtimeRevision, runtimeEntryPoint?, workspace}`; first binding wins and returns the saved record. |
| `ensure` | Creates or restores this run's workspace using its original release/image. Returns its state and loopback Cua identity. |
| `status` | Returns the saved record, or `null`; does not create a desktop. |
| `shell` | `command` string or argument array, optional `cwd`, `env`, `inheritEnv`, `timeout` in seconds. Returns `exitCode`, `stdout`, `stderr`. |
| `read` / `write` | Guest `path` and base64 `content` for binary-safe transfers. No host path is accepted. |
| `checkpoint` | Saves source, dirty/untracked work, Git metadata and desktop downloads; verifies durable storage before replacing the old recovery pointer. |
| `suspend` | Checkpoints, removes the container and writable layer, retains a recoverable run. An uncreated run needs no snapshot. |
| `export` | Retains a regular file within `/workspace`; returns a verified artifact receipt. |
| `read-artifact` | A saved `receipt`, optional byte `offset`/`length`; returns base64 content, byte positions and complete size. |
| `finish` | Retains a final source/results archive, removes compute and recovery cache, and closes the run. Retained deliverables and native history survive. |
| `discard` | Explicit `confirm` equal to the run ID; discards recovery and compute. Existing deliverables survive. |

`fs` carries a guest filesystem `request`; `WorkspaceClient` implements Pi's
native execution environment using it. `shell` with `stream: true` emits newline
JSON output frames followed by a result frame. The native client preserves
stdout/stderr streaming, output spill files, cancellation and tool timeouts.
Each shell cancellation kills that command's guest process group. Independent
commands use shared run locks; checkpoint/delete use exclusive locks. Trusted
Python adapters can hold `Controller.desktop_lease(run)` around external Cua
calls; it validates the running computer and holds the same shared lock until
the call finishes. No global
workspace or command concurrency limit is imposed.

Guest commands and checkpoint operations run as `cua` with `HOME=/home/cua` and
matching `USER`/`LOGNAME`. Checkpoint, restore and artifact bytes stream through
the live guest, including files on its temporary filesystems. Transfers verify
regular files and do not follow a final symlink; exports remain inside
`/workspace`.

## Connect a host

### One workspace per chat

An agent asks for a workspace of its own for each chat in `agent.ts`:

```ts
export default defineAgent({ extensions: [CodingTools], workspace: "chat" });
```

The host names its installed controller command and the image descriptor in
`host.json`, then starts with `dispatch serve` as usual:

```json
{
  "workspace": {
    "command": ["sudo", "-n", "/usr/local/libexec/example-workspace"],
    "image": {
      "format": 1,
      "contract": "dispatch-workspace-v1",
      "platform": "linux/amd64",
      "image": "registry.example.com/workspace@sha256:<64 hexadecimal characters>",
      "sourceRevision": "<40 hexadecimal characters>"
    }
  }
}
```

A chat's first shell or file tool call creates its workspace. A turn that uses
neither creates none. Later turns and delegated children of that chat use the
same workspace; other chats cannot reach it. The workspace identity is saved
with the chat's native state. The host refuses to start an agent that selects
`workspace: "chat"` without this setting. Agents without the option keep their
existing tools and working directory.

Delegated and handed-off work uses the workspace of the chat that started it.
An agent that delegates or hands off to an agent with `workspace: "chat"` must
therefore select it too, and a host that supplies its own `env` cannot serve
such an agent. The host refuses both at startup.

The controller binds each workspace to the application root and the agent's
definition fingerprint, so `allowedReleaseRoots` must cover the application
root. Repository instructions inside a workspace are read once the chat has
one. After a host restart, the first request of such a chat starts its
workspace again to read them. If a guest has stopped, the next request starts it
again. A file request is then repeated. A shell command is reported as possibly
cut off and is not repeated.

The host suspends a chat's workspace after 15 minutes without a shell or file
request. Set `suspendAfterMinutes` in the `workspace` setting to change that;
`0` keeps workspaces running. Suspending checkpoints the files under
`/workspace` to the controller's durable storage and removes the guest. Running
processes, browser pages, installed packages and files outside `/workspace` are
not kept, and a Git repository's ignored files are left out. The chat's next
request restores the workspace, including the instruction read at the start of
its next turn. The host records the workspaces it has running in
`workspaces.json` beside its stores, so a restarted host still suspends those
that then go unused. Workspaces are not finished when a chat ends, and desktop
tools are not bound per chat.

### An embedding host

The CLI has no workspace command. A host that embeds Runner can instead select
the controller command and run itself, then supply the workspace as the native
execution environment:

```ts
import { run, WorkspaceClient } from "@dispatch/runner";

const workspace = new WorkspaceClient(["sudo", "-n", "/usr/local/libexec/example-workspace"], "change-1");
const host = await run({ root, models, env: () => workspace.environment() });
```

The host runs the controller's lifecycle operations in the table above, such as
`ensure` before work and `finish` once outputs are accepted.

The run ID identifies the workspace. Every agent the host opens with that
environment uses the same workspace. Repository instructions are read
through that environment. The read-only `read_definition_resource` tool reads
UTF-8 files and lists directories within the session's pinned definition
package, including workflow references linked from agent instructions. Relative
links resolve against their packaged document's directory. The tool rejects
paths and symlinks that leave the package. It grants no host shell or writes;
native file/shell tools continue to use the guest, and `read_skill` retains its
scoped catalog. Custom hosts can opt in with `definitionResources: true` on
`ChatService.open`, `openAgent`, or `run`; native children inherit the reader.
`definitionResourcesExtension(root)` also exposes the bounded reader for host
adapters that select their own immutable definition root.

Artifact publication copies guest bytes into the
existing native artifact store. A host source-transfer helper can import a Git
bundle or publish completed commits using the user's existing Git credentials;
never copy credentials, SSH agents or a credential-bearing remote URL into the
guest.

A resumed run selects its saved definitions and re-executes its original Node
runtime before native state opens. Nix releases receive indirect GC roots for
their pinned closure; retain these roots with the run record for history access.
The privileged host controller is maintained separately and must continue to support
the saved `dispatch-workspace-v1` contract. Updating the default application
release affects new sessions. Reusing an existing session
never migrates its pinned release or image. End a workspace explicitly with the
controller's `finish` operation after its outputs are accepted. Exiting a
terminal turn alone does not finish the workspace.

Recovery archives omit Git-ignored dependencies and caches and preserve Git
metadata plus tracked and untracked source. Initialized submodules, including
nested submodules, retain their working files, `.git` pointers and shared Git
metadata under `/workspace`. Each repository's own ignore rules apply;
uninitialized submodules remain uninitialized. Restore installs those bytes into a
fresh copy of the same prepared image; callers reinstall ignored dependencies
as needed. A failed archive, upload, verification or deletion leaves the saved
record and recovery evidence intact. Native Pi state is never stored in the
disposable writable layer. Host installation and platform qualification remain
the application's responsibility.
