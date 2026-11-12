# Dispatch

Durable agents independent of their user interfaces. [Pi Durable](https://github.com/earendil-works/pi)
owns execution, task recovery and authoritative conversation history.

- [Web](packages/web/README.md): select an agent, reopen history, send/follow up,
  observe streaming/activity and stop owned work. Replaces the former workspace UI.
- [Backend](packages/backend/README.md): shared chat operations, read-only native
  observation and a central service for outbound workers.
- [Postgres](packages/postgres/README.md): Pi 1.5 Storage and receipted remote storage.
- [Workers](packages/workers/README.md): outbound-connected native Runner owners;
  only the central service accesses PostgreSQL.
- [Runner](packages/runner/README.md): authored definitions, native agents and CLI.
- [Remote](packages/remote/README.md): shared storage transport and remote SQLite.
- [Fleet](packages/fleet/README.md): existing fenced EC2 run placement; not required
  for the fixed-worker composition. No second Fleet coordinator is introduced.
- [Slack](packages/slack/README.md), [Google Chat](packages/google-chat/README.md)
  and [Email](packages/email/README.md): native channel integrations.
- [Observer](packages/observer/README.md): read-only desktop native inspection.
- [Kit](packages/kit/README.md): starter agents and skills a company release can
  compose instead of copying them.
- [Eval](packages/eval/README.md): grade retained runs and compare controlled reruns
  of a company's agents from its own use-case packages.

## First result

Requires Nix with flakes enabled. From a clean checkout:

```sh
nix develop
npm ci
npm run build
node examples/chat/configure.mjs
DISPATCH_CONFIG="$PWD/.local/chat-example/native.json" npm start
```

Open **http://127.0.0.1:4319**, select helper, send Hello and observe a slowly
streaming synthetic reply. This useful local example requires no credentials;
it is not inference qualification. See [central PostgreSQL + worker composition](examples/chat/README.md).
Production definitions, tools, models and credentials are consumer-owned, not Web settings.

## Boundaries

Local mode binds exact loopback Host/Origin. It is not hosted authentication.
Hosted mode requires an HTTPS `DISPATCH_ORIGIN` and an absolute trusted
`DISPATCH_AUTH_MODULE` exporting `authorize(request): Promise<boolean>`.
That installation adapter must validate real sessions/credentials and authorize
**all configured runs**; this first surface does not implement per-user grants or
multi-human identity management. No fake login or exposed loopback adapter.

Native durable history is authoritative. The browser stores only selection and
uncertain request identity/text, never a second transcript. Browsing/reconnecting
never opens an owner, resumes tasks or resends input. Unknown native owners,
uncertain effects and changed definitions fail closed; no timeout takeover.
Independent conversations have no application concurrency cap.

## Distribution and development

Source alpha, lockstep 0.6.0 with unreleased changes; no npm/public artifact release
is implied by a source commit. Build with `nix build`, `nix flake check`,
`nix build .#frontend .#macos-release`; OCI outputs require matching Linux builders.
The replacement retires old company/project/rooms/settings APIs, account enrollment,
capability bundles and old worker launcher commands without compatibility machinery.

Read [contribution rules](CONTRIBUTING.md), [public-information boundary](OSS.md),
[security policy](SECURITY.md), [Web goals](packages/web/USE_CASES.md) and
[portable-agent direction](packages/runner/docs/definition-workspaces.md).
