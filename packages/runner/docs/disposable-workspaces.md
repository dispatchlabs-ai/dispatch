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

Build the image from `packages/runner/workspace-image` at that source revision.
The controller checks the image digest, platform, contract and source labels
before launch. An ordinary image tag is not accepted. The image includes a Cua
server and a credential-free developer desktop; the host must supply Docker,
gVisor, Cua CLI, nftables and reachable DNS. The configured Docker runtime must
use `--net-raw`, `--allow-packet-socket-write`, `--allow-suid`, and
`--overlay2=none`. Runtime names are host-owned. Provision a dedicated bridge and
its nftables rules with `configure-network` before admitting work. These rules
block guest access to new host connections, other workspaces on that bridge and
cloud instance metadata. The Cua control port is bound only to host loopback.
Containers never restart automatically: after a host reboot, `ensure` verifies the network policy before
starting a retained computer. Host provisioning must restore the nftables rules
before admitting workspace operations.

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
commands use shared run locks; checkpoint/delete use exclusive locks. No global
workspace or command concurrency limit is imposed.

## On-demand agent CLI

In the ordinary CLI host config add:

```json
{
  "workspace": {
    "agents": ["development"],
    "command": ["sudo", "-n", "/usr/local/libexec/example-workspace"]
  }
}
```

The release wrapper passes its manifest automatically. Run a named session as
usual, or prepare the desktop before importing source:

```sh
example-agents workspace --config /etc/example/host.json --agent development --session change-1 --action ensure
example-agents run --config /etc/example/host.json --agent development --session change-1 --prompt 'Inspect the imported project.'
example-agents workspace --config /etc/example/host.json --agent development --session change-1 --action suspend
```

The session key is also the controller run ID. Every agent participating in that
session uses the same workspace environment. Repository instructions are read
through that environment. Artifact publication copies guest bytes into the
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
never migrates its pinned release or image. End a workspace explicitly with
`--action finish` after its outputs are accepted. The on-demand process waits for admitted peer assignments and automatic replies
before exiting. Exiting a terminal turn alone does not finish the workspace.

Recovery archives omit Git-ignored dependencies and caches and preserve Git
metadata plus tracked and untracked source. Restore installs those bytes into a
fresh copy of the same prepared image; callers reinstall ignored dependencies
as needed. A failed archive, upload, verification or deletion leaves the saved
record and recovery evidence intact. Native Pi state is never stored in the
disposable writable layer. Host installation and platform qualification remain
the application's responsibility.
