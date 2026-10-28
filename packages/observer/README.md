# Dispatch Observer

A local Electron app for following Pi Durable agents and stepping through their
saved activity. Inspect conversations, tool calls and results, child agents,
native tasks, and workflow documents in one read-only workspace.

Start on **This machine** to discover local Pi SQLite stores open by your user's
processes. Unfinished conversations appear first; click one to open its formatted
conversation with expandable inline tool calls and results. Discovery requires
macOS or Linux with `lsof`; other stores remain available through Add connection.
Process presence and saved task status are shown separately.

**Implemented, October 22, 2026.** The macOS Apple Silicon build has been exercised
with local SQLite, direct/TLS Postgres, Postgres over SSH, and remote SQLite over
SSH and AWS SSM. Windows/Linux desktop execution and Postgres over SSM remain
unqualified. This is an unsigned development app, not a signed installer release.

## Try it

From the repository root, using the [shared Node 24 toolchain](../../CONTRIBUTING.md):

```sh
nix develop
npm ci
npm run build -w @dispatch/observer
npm run sample -w @dispatch/observer
npm run start -w @dispatch/observer
```

Choose **Add connection → SQLite**, browse to
`packages/observer/.local/sample.sqlite`, then **Save & connect**. The synthetic
workspace has a coordinator, two children, a waiting workflow, a failed attempt,
and a retained tool slot. No model provider or agent process is started. The
sample command refuses to replace an existing file; pass a different destination
with `npm run sample -w @dispatch/observer -- /path/to/new-sample.sqlite`.

For real work, select an existing Pi SQLite file or configure a Postgres logical
store. Add SSH or AWS Session Manager when needed. Use **Timeline** to select an
event, then play, step, scrub, or return to **Live**. The connection guide covers
credentials, prerequisites, troubleshooting, and the limits of saved evidence.

## Build a desktop app

```sh
npm run build -w @dispatch/observer
npm run package -w @dispatch/observer
```

The packager produces an app for the current host under `packages/observer/out/`.
On Apple Silicon macOS, open
`out/Dispatch Observer-darwin-arm64/Dispatch Observer.app`. It contains the reader,
renderer, fonts, and third-party notices; Node is bundled with Electron. Remote
SQLite hosts separately need Node.js 22.13+.

Packaging does not sign, notarize, install a system service, or configure updates.
It packages the current `dist/` output, so build first. For development,
`npm run dev -w @dispatch/observer` rebuilds and launches the app. Root
`npm run check` includes Observer; follow the repository's no-automated-tests
policy and its required Nix checks for dependency or packaging changes.

## Guides

- [Usage and qualification](docs/usage-guide.md): local/remote connections,
  playback, security boundaries, and dated acceptance evidence.
- [Use cases](USE_CASES.md): stable `OBS-` goals and implementation coverage.
- [Design guide](DESIGN_GUIDE.md): interaction rules, appearance, and record fidelity.
- [Design references](docs/design/README.md): original ImageGen concepts and provenance.
- [Changelog](CHANGELOG.md): package availability and changes.

The reference images are synthetic design mockups, not runtime screenshots.

## Read-only boundary

Observer does not open a Harness, acquire Pi's execution ownership, run tools,
resume tasks, or migrate agent databases. It reads short SQLite or Postgres
snapshots. Playback changes only the local view. SQLite on another machine is
read beside the database through a temporary helper; a database file is never
mounted over a network. Existing agents need no instrumentation or migration.

Database access is operator access. It does not recreate a chat application's
end-user permissions. Known credential fields and provider documents are excluded
or redacted, but arbitrary saved text can contain sensitive material. Give each
connection only the database access it needs.

An agent can help configure the app using this prompt:

> Read `packages/observer/docs/usage-guide.md`, build Dispatch Observer, and help
> me open my existing Pi Durable store. Use its read-only connection flow, preserve
> the agent's state and credentials, and report the connection and playback results.

MIT licensed; see [LICENSE](LICENSE) and [bundled license sources](licenses/README.md).
