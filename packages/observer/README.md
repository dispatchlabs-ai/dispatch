# Dispatch Observer

A desktop view into what Pi Durable agents are doing: conversations, tool calls,
subagents, workflows, and recorded activity you can step through.

**Status: design-stage package.** This package contains the agreed use cases,
design guide, and three ImageGen reference mockups. It has no executable Electron
app, database connectors, remote helper, or installers yet. The screenshots show
synthetic data and are design references, not captures of implemented behavior.

The intended application runs locally on macOS, Windows, and Linux. Add a local
SQLite database, a Postgres connection, or a remote source reached through SSH or
AWS SSM. The same interface then shows live work and retained history. A separately
hosted observer service is optional, not a prerequisite.

## Start with the design

Open [the live activity mockup](docs/design/01-live-activity.png), then read the
[use cases](USE_CASES.md) and [design guide](DESIGN_GUIDE.md). Together they define
what an implementation must support and how the interface should behave.

| Reference | Purpose |
| --- | --- |
| [Live activity](docs/design/01-live-activity.png) | Follow an agent, its children, and the selected tool call. |
| [Workflow playback](docs/design/02-workflow-playback.png) | Inspect a completed workflow and step through retained events. |
| [Add a connection](docs/design/03-add-connection.png) | Choose SQLite or Postgres and configure an optional tunnel. |
| [Generation record](docs/design/README.md) | Image provenance, exact prompts, and visual review limits. |
| [Changelog](CHANGELOG.md) | Package changes and availability. |

![Dispatch Observer live activity design](docs/design/01-live-activity.png)

## Read-only by design

Pi Durable remains responsible for execution, checkpoints, and recovery. Observer
reads existing state; opening a source never starts a Harness, takes its execution
lock, runs a tool, or resumes an agent. Playback changes only the local view.

Remote SQLite requires a reader beside the database. A tunnel transports that
reader's responses; it does not turn a SQLite file into a network database.
Postgres can be read directly, with each selected logical store kept distinct.
The [storage boundary](DESIGN_GUIDE.md#storage-and-process-boundaries) explains
the intended implementation and the existing code it can draw from.

## Package development

The manifest reserves `@dispatch/observer` and packages these design assets. It is
not yet in the root npm workspace list: there is no application to build or type
check. When executable implementation begins, register it with the root workspace,
lockstep release tooling, lockfile, and relevant build definitions. Do not add
placeholder build commands that report success without building an application.

Follow [the repository contribution guide](../../CONTRIBUTING.md) and
[open-source standards](../../OSS.md). This stage uses documentation/link review,
image inspection, and package-content review; it establishes no runtime or
platform qualification.

MIT licensed; see [LICENSE](LICENSE).
