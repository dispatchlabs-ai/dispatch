# Dispatch

**A self-hosted workspace where people and AI agents work together.**

Dispatch brings shared conversations, named agents, project tools and background work into a browser workspace. Invite your teammates, connect a model provider, and work with multiple agents in the same conversation. Your installation owns its accounts, credentials and conversation state.

Dispatch is built on [Pi Durable](https://github.com/earendil-works/pi): Pi owns agent execution and recovery; Dispatch adds sign-in, collaboration and the browser experience.

## Choose your installation

| Where you want to run Dispatch | Start here |
| --- | --- |
| **Apple Silicon Mac** — one machine for development | Use the [portable Mac package](#apple-silicon-mac). It includes its runtime; no Nix or Homebrew is needed to run it. |
| **Windows with WSL2** — containers on your desktop | The container quick start is being prepared and is not yet installation-qualified. |
| **AWS** — your own infrastructure and ECR | Follow the [terraform-aws-dispatch module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch) for Terraform/OpenTofu setup. The application release artifacts and complete installation are still being qualified. |

We are preparing the first public packaged release. The Mac candidate has been installed and its login page checked on Apple Silicon; account enrollment and a model conversation are still being qualified. Windows and complete AWS installation remain pending. No separate Pi installation is needed.

## Apple Silicon Mac

The portable package includes Node and Dispatch. **A public release download is not available yet.** The steps below apply to the candidate archive supplied by the maintainer; do not download similarly named files from an untrusted source.

In Terminal, change to the directory containing `dispatch-0.2.0-darwin-arm64.tar.gz` and its `SHA256SUMS`, then:

```sh
shasum -a 256 -c SHA256SUMS
```

Proceed only if the checksum check passes. Obtain both files through the trusted maintainer/release channel: the checksum checks integrity, not publisher identity by itself.

```sh
tar -xzf dispatch-0.2.0-darwin-arm64.tar.gz
cd dispatch-0.2.0-darwin-arm64
./bin/dispatch version
./bin/dispatch invite --email you@example.com --name "Your Name"
./bin/dispatch
```

Replace the example email and name with your own. Keep the private enrollment link printed by `invite`, start Dispatch, then open that link to create your account. The app runs at **http://localhost:3001**. Keep the terminal running; Ctrl-C stops Dispatch. Once enrolled, [connect a model and start working](#connect-a-model-and-start-working).

State and project workspace live in `~/Library/Application Support/Dispatch`, outside the extracted application directory. Keep that directory when replacing the package and back up its complete contents together. Stop Dispatch before running `invite` or `reset` commands. The package does not install a login or reboot service.

Contributors can build the archive locally on an Apple Silicon Mac with Nix:

```sh
nix build .#macos-release
```

The archive and checksum file are in `result/`. Building requires Nix; running the extracted package does not.

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
- [Specification](packages/web/docs/spec.md) and [handoff](packages/web/docs/handoff.md) — contracts and scoped verification evidence
- [AWS deployment module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch) — infrastructure and AWS installation instructions

## License

[MIT](LICENSE).
