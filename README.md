# Dispatch

Build durable AI agents in your own application. Your repository owns the agent
instructions, models, tools and skills. Dispatch provides the runtime and client
libraries; [Pi Durable](https://github.com/earendil-works/pi) owns execution,
recovery and conversation history.

An agent is two small files: `agent.md` describes it, and `agent.ts` selects its
capabilities. A host process loads those definitions and owns the conversation
store. CLI, Web and channel connectors interact with that owner. Add another
client by using the same conversation operations.

```mermaid
flowchart LR
  C[CLI · Web · Slack · Google Chat · Email] --> H[Agent host]
  D[Your definitions and tools] --> H
  H --> S[Pi Durable conversation store]
```

Install the library, write the definitions, and start the host. There is no
scaffold, generated agent layer or build-time instruction merge. Updating the
Dispatch dependency changes the runtime; your definition files stay yours.
See the [minimal agent example](packages/runner/README.md#try-it-without-credentials)
and the [service/client contract](packages/runner/docs/service.md#shared-clients-and-company-compositions).

**Source alpha.** Start with a local synthetic conversation: send a message,
watch the reply stream, restart the demo and reopen its saved history. No model
key, account, database server or private infrastructure is needed.

## Use it with your AI agent

Your agent needs public-documentation, shell, file and browser access. The machine
needs Git and [Nix with flakes enabled](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake).
Give your agent this prompt:

> Read https://github.com/dispatchlabs-ai/dispatch/blob/main/docs/quickstart.md and
> complete the local chat walkthrough in a fresh directory. Verify a synthetic
> reply and that the same conversation survives a service restart. Report the
> source commit, platform, observed result and any user intervention. Use only
> the demo's isolated state; leave existing installations and real accounts alone.
> Stop the demo you started when finished and tell me how to reopen its history.

The walkthrough downloads build dependencies, starts a loopback-only server and
writes synthetic conversation history in the new checkout. It does not install
a system service. The [manual walkthrough](docs/quickstart.md) follows the same
steps. See the [verification record](docs/qualification.md) for observed platforms
and limits; browser access and Nix are prerequisites supplied by the user or agent.

## Choose the pieces you need

| Goal | Package |
| --- | --- |
| Define and run durable agents from a CLI or local service | [Runner](packages/runner/README.md) |
| Grade retained work or compare controlled reruns with your own rubric | [Eval](packages/eval/README.md) |
| Browse, steer and stop native conversations | [Web](packages/web/README.md) |
| Embed shared conversation operations in a client | [Backend](packages/backend/README.md) |
| Connect a supported channel | [Slack](packages/slack/README.md), [Google Chat](packages/google-chat/README.md), [Email](packages/email/README.md) |
| Inspect native records without running agents | [Observer](packages/observer/README.md) |
| Use remote storage or outbound workers | [Remote](packages/remote/README.md), [Postgres](packages/postgres/README.md), [Workers](packages/workers/README.md) |
| Place complete runs on replaceable EC2 workers | [Fleet](packages/fleet/README.md) |

Packages can be adopted separately at their documented boundaries. Fleet,
PostgreSQL, Web and channel accounts are optional. Use a single application
dependency tree, or a separately managed runtime for
several definition repositories. Nix packaging is optional; it copies the same
definition files you inspect and edit in source.

## Versions and distribution

The latest tagged source release is [v0.12.3](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.12.3),
using Pi Durable 1.5.2. Its five reusable package archives, source manifest and
checksums are attached to that release; they are **not published to npm**.
Current `main` also carries the unreleased changes listed in package changelogs.
The quickstart uses current source and records its exact commit.

The optional [Nix release builder](packages/runner/docs/nix-releases.md) packages
complete application definitions with the runtime and, when selected, Eval.
Web, Observer, Fleet and channel packages are public MIT source with separate
build instructions; `private: true` in an npm manifest means the package is not
an npm publication target. It does not make the source proprietary.

Use [the release guide](.pi/skills/release.md) to prepare artifacts and
[the upgrade guide](packages/runner/docs/upgrade.md) for an existing installation.
Building or publishing source never upgrades a running installation.

## Boundaries and contributing

Local chat trusts the local account and binds exact loopback Host/Origin. Hosted
Web requires HTTPS and an installation-owned authorization binding covering its
configured runs. The shared local service uses a private Unix socket. Web supplies
its HTTP
adapter; Slack, Google Chat and email supply channel adapters. These share native
operations but are not all clients of one public HTTP endpoint. Multi-user grants
and a general authenticated network agent-client API remain outside the current
scope. Agent tools have their host's actual authority; a
working directory is not a sandbox.

Read the [interface inventory](docs/interfaces.md), [HTTP contract](packages/web/openapi.yaml),
[security policy](SECURITY.md), [contribution guide](CONTRIBUTING.md),
[open-source standards](OSS.md) and [verification record](docs/qualification.md).
Report ordinary bugs in [GitHub Issues](https://github.com/dispatchlabs-ai/dispatch/issues)
and vulnerabilities through [private reporting](SECURITY.md).

Created by Chris Reynolds, cofounder of Dispatch Labs AI. Published by
[Dispatch Labs AI](https://github.com/dispatchlabs-ai) under the [MIT license](LICENSE).
Upstream licenses and attribution remain with their components.
