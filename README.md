# Dispatch

**A self-hosted workspace where people and AI agents work together.**

Dispatch brings shared conversations, named agents, project tools and background work into a browser workspace. Invite your teammates, connect a model provider, and work with multiple agents in the same conversation. Your installation owns its accounts, credentials and conversation state.

Dispatch is built on [Pi Durable](https://github.com/earendil-works/pi): Pi owns agent execution and recovery; Dispatch adds sign-in, collaboration and the browser experience.

## Choose your installation

| Where you want to run Dispatch | Start here |
| --- | --- |
| **Apple Silicon Mac** — one machine for development | Use the [portable Mac package](#apple-silicon-mac). It includes its runtime; no Nix or Homebrew is needed to run it. |
| **Windows with WSL2** — containers on your desktop | Use the [WSL2 container installation](#windows-with-wsl2), with Docker Engine and Compose inside Ubuntu. |
| **AWS** — your own infrastructure and ECR | Follow the [terraform-aws-dispatch module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch) for Terraform/OpenTofu setup. Application archives are [available in 0.5.0](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.5.0); complete AWS installation remains unqualified. |

**[Dispatch 0.5.0 is available](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.5.0)**. All uploaded digests match the staged archives; anonymous Mac/frontend/checksum downloads and every asset URL are verified. The release includes portable Mac, Linux/AMD64 controller, Ubuntu worker and frontend archives. Artifact/build checks and scoped presentation verification are documented in the [0.5.0 verification record](packages/web/docs/usage-guide.md#050-release-verification). Installation, enrollment/model use, recovery, Windows/WSL2, AWS/hosted workers, retained-state upgrades and backup restoration have not been qualified for these new bytes. Earlier releases' checks do not qualify 0.5.0. No separate Pi installation is needed.

## Apple Silicon Mac

The portable package includes Node and Dispatch. Download it from the official [0.5.0 release](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.5.0), or run these commands in Terminal from a dedicated download directory:

```sh
curl -fL -O https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.5.0/dispatch-0.5.0-darwin-arm64.tar.gz
curl -fL -O https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.5.0/SHA256SUMS
```

Verify the archive before extracting it:

```sh
awk '$2 == "dispatch-0.5.0-darwin-arm64.tar.gz"' SHA256SUMS | shasum -a 256 -c -
```

This checks only the Mac archive; you do not need the Windows or AWS artifacts listed in the same checksum file. Proceed only if it prints `dispatch-0.5.0-darwin-arm64.tar.gz: OK`. Obtain both files through the trusted maintainer/release channel: the checksum checks integrity, not publisher identity by itself.

```sh
tar -xzf dispatch-0.5.0-darwin-arm64.tar.gz
cd dispatch-0.5.0-darwin-arm64
./bin/dispatch version
./bin/dispatch invite --email you@example.com --name "Your Name"
./bin/dispatch
```

Replace the example email and name with your own. Keep the private enrollment link printed by `invite`, start Dispatch, then open that link to create your account. The app runs at **http://localhost:3001**. Keep the terminal running; Ctrl-C stops Dispatch. Once enrolled, [connect a model and start working](#connect-a-model-and-start-working).

State and project workspace live in `~/Library/Application Support/Dispatch`, outside the extracted application directory. Keep that directory when replacing the package and back up its complete contents together. Stop Dispatch before replacing the package or making a file-copy backup of this directory. Also stop it before running `invite` or `reset` commands. The package does not install a login or reboot service.

Contributors can build the archive locally on an Apple Silicon Mac with Nix:

```sh
nix build .#macos-release
```

The archive and checksum file are in `result/`. Building requires Nix; running the extracted package does not.

## Windows with WSL2

The earlier 0.2.0 controller was checked with **Ubuntu on WSL2, Docker Engine 29.1.3 and Compose 2.40.3**, opening the app in Windows Edge. Docker Desktop is a different service lifecycle and has not been separately qualified.

The [0.5.0 release](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.5.0) contains the Linux/AMD64 controller archive. Use the checksum-verified download; it does not require rebuilding. Use a dedicated directory inside Ubuntu, not an existing deployment directory.

Download `dispatch-controller-839d7b11-amd64.tar.gz` and `SHA256SUMS` from that release. Also download the matching [Compose file](https://raw.githubusercontent.com/dispatchlabs-ai/dispatch/v0.5.0/compose.yaml) and [environment example](https://raw.githubusercontent.com/dispatchlabs-ai/dispatch/v0.5.0/.env.example), saving them as `compose.yaml` and `.env.example`. From an Ubuntu WSL terminal in that directory:

```sh
awk '$2 == "dispatch-controller-839d7b11-amd64.tar.gz"' SHA256SUMS | sha256sum -c -
```

Require `dispatch-controller-839d7b11-amd64.tar.gz: OK` before loading it. Obtain the archive and checksum through the official release channel; checksums verify integrity, not independent publisher identity.

```sh
docker load -i dispatch-controller-839d7b11-amd64.tar.gz
cp .env.example .env
```

The archive records `dispatch-web:839d7b113049`, with the full release revision in its image labels. Set `DISPATCH_IMAGE=dispatch-web:839d7b113049` in `.env`. The immutable v0.5.0 environment example still has a comment describing 0.4.0; use this inspected tag. The example on `main` points to the current instructions. This is a local tag, not a registry digest; the verified archive checksum identifies the downloaded bytes. Keep `DISPATCH_PORT=3001` unless it is already in use.

**Registry alternative:** skip the controller archive download/load steps, but download the matching Compose and environment files linked above. Copy `.env.example` to `.env`, then set:

```dotenv
DISPATCH_IMAGE=ghcr.io/dispatchlabs-ai/dispatch:0.5.0@sha256:8908b28986fc8f9235e829df04c741944c567ce19cbff635cd1567b5e0e71450
```

Pull the pinned controller without signing in:

```sh
docker compose pull
```

Then follow the same first-account and foreground-startup steps below. The Ubuntu worker is published separately as `ghcr.io/dispatchlabs-ai/dispatch-worker:0.5.0@sha256:5a2ad192bbeb3dfdf603a710a5a8679aa828272dc94aa017013df50c2e29286f`; the desktop Compose file does not start it. Both digest pulls were verified anonymously, with filesystem layers and runtime configuration matching the audited artifacts. Worker conversations and hosted AWS operation remain unverified for 0.5.0.

For the first account, while the controller is still stopped, run this from the same Compose directory (replace the example email and name):

```sh
docker compose run --rm --no-deps dispatch dispatch-auth invite --email you@example.com --name "Your Name"
```

This uses the same `dispatch-data` volume as the controller and prints a private, single-use enrollment link with an expiry. Its localhost port follows `DISPATCH_PORT`. Do not publish or share the link. Then start the service:

```sh
docker compose up
```

Open the printed enrollment link in your Windows browser to create the account and passkey. After enrollment, open **http://localhost:3001** (use your chosen port if you changed it). Keep the WSL terminal open. In the verified Docker Engine route, detached startup with `docker compose up -d` did not keep WSL alive after its last shell exited. Ctrl-C stops the foreground service; run `docker compose up` again to resume. This route does not yet provide verified unattended startup after reboot.

Compose publishes only on host loopback and preserves state/workspace in the `dispatch-data` named volume. Keep the same Compose directory/project identity when restarting or replacing the image. Do not use `docker compose down -v` for an upgrade: it deletes the data volume. Do not mount your Windows or Linux home directory into the agent workspace.

The earlier published 0.3.0 controller passed isolated Windows 11/Ubuntu 24.04 WSL2 startup, enrollment/sign-in, a real model response and saved-state persistence after an idle restart. The interactive check used Chrome on M1 through a tunnel with a virtual passkey—not Windows Edge or a physical passkey device; see [qualification and limits](packages/web/docs/usage-guide.md#030-windowswsl2-qualification). There is no default account or public signup. These were 0.3.0 fresh-install checks, not 0.5.0 qualification; upgrading retained state from an earlier version and restoring a backup are not yet verified.

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

- [Web package](packages/web/README.md) — implementation and documentation index
- [Usage guide](packages/web/docs/usage-guide.md) — detailed setup and operation
- [Changelog](packages/web/CHANGELOG.md) — changes and release history
- [Security policy](SECURITY.md) — private vulnerability reporting and execution trust boundaries
- [Project spec access](packages/web/docs/spec.md) and [handoff](packages/web/docs/handoff.md) — database intent and historical verification evidence
- [AWS deployment module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch) — infrastructure and AWS installation instructions

## License

[MIT](LICENSE).
