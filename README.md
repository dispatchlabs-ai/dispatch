# Dispatch

**A self-hosted workspace where people and AI agents work together.**

Dispatch brings shared conversations, named agents, project tools and background work into a browser workspace. Invite your teammates, connect a model provider, and work with multiple agents in the same conversation. Your installation owns its accounts, credentials and conversation state.

Dispatch is built on [Pi Durable](https://github.com/earendil-works/pi): Pi owns agent execution and recovery; Dispatch adds sign-in, collaboration and the browser experience.

For company agents that run independently of the browser,
[Dispatch Runner](packages/runner/README.md) loads agent directories and owns
native schedules and conversations. The optional
[Slack package](packages/slack/README.md) connects shared threads and report
discussions. These source-alpha packages are installed as locally packed
dependencies.

[Dispatch Observer](packages/observer/README.md) is the read-only Electron desktop
package for inspecting those agents through SQLite or Postgres, locally or over
a remote connection. It provides live following, saved-event playback, native
task inspection, and a locally packaged macOS app. See its usage guide for
qualified transports and remaining platform limits.

## Distribution status

This repository is a pre-1.0 source distribution. On October 21, 2026 its public
history was replaced with a sanitized snapshot, and earlier release downloads
were withdrawn. The package version remains `0.6.0`; the changelogs distinguish
later unreleased work. Build this checkout rather than relying on old release
links or commit hashes. Existing installations are not updated by this reset.

## Choose your installation

| Environment | Start here |
| --- | --- |
| Local development on macOS or Linux | [Run from source](#run-from-source) with the pinned Nix toolchain. |
| Apple Silicon Mac package | Build `nix build .#macos-release`; the archive and checksums are in `result/`. The extracted package includes its runtime. |
| Linux containers or Windows with WSL2 | Build `nix build .#oci` on the matching Linux platform, then use the [Compose setup](packages/web/docs/usage-guide.md#configuration). |
| AWS | Use the [deployment module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch) with your own verified application artifacts. Review installation qualification separately. |

Historical platform checks and their limits are recorded in the
[usage guide](packages/web/docs/usage-guide.md). They do not establish qualification
of this source snapshot on every platform.

## Run from source

You need Git and [Nix](https://nixos.org/download/) with `nix-command` and `flakes` enabled. Nix supplies the Node toolchain.

```sh
git clone https://github.com/dispatchlabs-ai/dispatch.git
cd dispatch
nix develop
npm ci
npm run dev
```

Open **http://localhost:5173**. Keep that terminal running; Ctrl-C stops the application.

### Create your first account

There is no default password or public signup. In a second terminal, enter the same checkout and create a private enrollment link:

```sh
# Run in the cloned dispatch directory.
nix develop
npm run auth -- invite --email person@example.com --name "Person"
```

Replace the example email and name with your own. Open the generated link and enroll with a passkey or a password plus an authenticator app. The invitation expires after one hour by default; Dispatch does not send an email. Save any recovery codes in your password manager.

### Connect a model and start working

1. Sign in and open **Settings → Model providers**.
2. Connect an available provider: OpenAI supports ChatGPT OAuth or an API key; Claude and Fireworks use API keys.
3. In **Agents**, configure Developer or create a named agent with a model your provider account can use.
4. Select **New chat**, choose your agent, and send your first message.

Provider credentials stay on the service and are shared by agents in this installation. See the [usage guide](packages/web/docs/usage-guide.md) for agent configuration, supported tools and account recovery.

## Keep your work safe

- Use trusted users, agents and tools. Coding tools execute with the service account's filesystem/process access; a project working directory is not a sandbox. Native Muse execution disables its sandbox and approval prompts. Disabling optional Dispatch tools does not confine native Muse access; see [Muse setup](packages/web/docs/usage-guide.md#muse-code-setup).
- MCP connections can reach private-network services and the service host's loopback interface. Restrict the host's network access when those destinations must remain isolated; see [connection boundaries](packages/web/docs/usage-guide.md#connect-an-mcp-server).
- Local development listens on your own machine. To serve other machines, use HTTPS and a matching `DISPATCH_ORIGIN`; do not expose a plaintext development server to the network.
- Source-development state lives in `.local/state/dispatch` by default. Back up the complete state directory, including the authentication database and encryption keys, together.
- Run only one application owner against a state directory. Stop it before activating a replacement. An older executable alone does not guarantee a safe rollback after state changes.

The [usage guide](packages/web/docs/usage-guide.md) covers state locations, backups, launchers and troubleshooting. Keep private enrollment links, provider credentials and recovery codes out of issue reports.

## Develop and contribute

Builds run **locally with Nix**, not GitHub Actions:

```sh
npm run check
nix build
nix flake check
```

Run these from the repository's Nix shell. They check types and builds, not end-to-end behavior. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for the current no-automated-tests policy, interactive verification and source publication.

## Learn more

- [Dispatch use cases](packages/web/USE_CASES.md) — browser workspace goals and approved additions
- [Web package](packages/web/README.md) — implementation and documentation index
- [Observer](packages/observer/README.md) — desktop agent inspection, connections, and recorded-event playback
- [Usage guide](packages/web/docs/usage-guide.md) — detailed setup and operation
- [Changelog](packages/web/CHANGELOG.md) — changes and release history
- [Security policy](SECURITY.md) — private vulnerability reporting and execution trust boundaries
- [Project spec access](packages/web/docs/spec.md) and [handoff](packages/web/docs/handoff.md) — database intent and public qualification boundaries
- [AWS deployment module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch) — infrastructure and AWS installation instructions

## License

[MIT](LICENSE).

Created by Chris Reynolds, cofounder of Dispatch Labs AI.
