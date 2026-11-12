# Dispatch

Build durable AI agents, start with reusable agent roles, and evaluate their work.
Dispatch combines [Pi Durable](https://github.com/earendil-works/pi) with a runtime,
an optional starter kit, evaluation tools and clients for your own agent application.
Your repository owns its instructions, tools, model access and data.

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
| Start an agent repository with Jett, Development, Developer and review roles, then hold a first real conversation | [Kit](packages/kit/README.md#first-result) |
| Grade retained work or compare controlled reruns with your own rubric | [Eval](packages/eval/README.md) |
| Browse, steer and stop native conversations | [Web](packages/web/README.md) |
| Embed shared conversation operations in a client | [Backend](packages/backend/README.md) |
| Connect a supported channel | [Slack](packages/slack/README.md), [Google Chat](packages/google-chat/README.md), [Email](packages/email/README.md) |
| Inspect native records without running agents | [Observer](packages/observer/README.md) |
| Use remote storage or outbound workers | [Remote](packages/remote/README.md), [Postgres](packages/postgres/README.md), [Workers](packages/workers/README.md) |
| Place complete runs on replaceable EC2 workers | [Fleet](packages/fleet/README.md) |

Packages can be adopted separately at their documented boundaries. Fleet,
PostgreSQL, Web and channel accounts are optional. Pi Durable owns execution,
recovery and authoritative history. The kit stays a versioned dependency;
company definitions extend it when a release is built.

## Versions and distribution

The latest tagged source release is [v0.11.2](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.11.2),
using Pi Durable 1.5.2. Its five reusable package archives, source manifest and
checksums are attached to that release; they are **not published to npm**.
Current `main` also carries the unreleased changes listed in package changelogs.
The quickstart uses current source and records its exact commit.

Kit and Eval are included through the [Nix release builder](packages/runner/docs/nix-releases.md).
Web, Observer, Fleet and channel packages are public MIT source with separate
build instructions; `private: true` in an npm manifest means the package is not
an npm publication target. It does not make the source proprietary.

Use [the release guide](.pi/skills/release.md) to prepare artifacts and
[the upgrade guide](packages/runner/docs/upgrade.md) for an existing installation.
Building or publishing source never upgrades a running installation.

## Boundaries and contributing

Local chat trusts the local account and binds exact loopback Host/Origin. Hosted
Web requires HTTPS and an installation-owned authorization binding covering its
configured runs. Multi-user grants and a general network agent-client API remain
outside the current scope. Agent tools have their host's actual authority; a
working directory is not a sandbox.

Read the [interface inventory](docs/interfaces.md), [HTTP contract](packages/web/openapi.yaml),
[security policy](SECURITY.md), [contribution guide](CONTRIBUTING.md),
[open-source standards](OSS.md) and [verification record](docs/qualification.md).
Report ordinary bugs in [GitHub Issues](https://github.com/dispatchlabs-ai/dispatch/issues)
and vulnerabilities through [private reporting](SECURITY.md).

Created by Chris Reynolds, cofounder of Dispatch Labs AI. Published by
[Dispatch Labs AI](https://github.com/dispatchlabs-ai) under the [MIT license](LICENSE).
Upstream licenses and attribution remain with their components.
