# Contributing

Dispatch Web is at the specification stage. There is no runnable application, dependency installation, build command, or test suite yet. Establish those commands with the first implementation package and document them here and in the owning package's README.

## Local development and Nix builds

Use TypeScript throughout application code. Local development, including on M1 Air, and Nix-based builds are accepted requirements; see the [Web specification](packages/web/docs/spec.md#language-and-development-requirements). Establish `nix develop`, `nix build`, and `nix flake check` with the first implementation package, sharing pinned toolchain and dependency definitions. They are not available yet. Shared flake configuration and lockfiles belong at the repository root; package-specific build recipes stay with their package. Future automation must invoke the same build definitions.

## Where work belongs

| Location | Responsibility |
| --- | --- |
| Root `README.md` | Project overview and package links |
| Root `AGENTS.md` | Concise repository-wide agent instructions |
| Root `CONTRIBUTING.md` | Shared development and contribution workflow |
| `.pi/prompts/` | Reusable development prompts listed below |
| `.pi/skills/` | Focused browser-testing and release procedures |
| `packages/<package>/README.md` | Package purpose, usage, and documentation links |
| `packages/<package>/CHANGELOG.md` | Package changes and release history |
| `packages/<package>/docs/spec.md` | Intended behavior, contracts, and explicit unresolved questions |
| `packages/<package>/docs/handoff.md` | Implementation decisions, ordered work packages, and acceptance criteria |
| `packages/<package>/docs/usage-guide.md` | Detailed integration guidance when the package has usable interfaces |
| `packages/<package>/src/` | Implementation |
| `packages/<package>/test/` | Package tests, with runnable examples in `test/examples/` |
| `scripts/` | Shared development and release tooling |
| `.github/workflows/` | Reserved workflow location; no CI is configured |

Language-specific manifests and build configuration belong beside the relevant package code. Add root configuration only for shared workspace tooling. The initial `web` directory establishes documentation ownership; further package boundaries will follow the design.

## Specification and implementation

1. Read the relevant product intent and decisions from the [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/), then the affected package's specification and handoff.
2. Agree the user workflow and observable outcomes. Record behavior and contracts in `docs/spec.md`, including state ownership, failure paths, and recovery. Mark proposed or unresolved details explicitly.
3. Translate the design into ordered work packages in `docs/handoff.md`. Each package needs its scope, dependencies, acceptance criteria, and applicable checks. Link significant decisions to their maintained wiki record.
4. Implement the current work package. Keep validation in its acceptance criteria and the package's tests. Add runnable examples under `test/examples/` and document actual usage when it exists.
5. Run the package tests and repository checks, inspect the diff, update the package changelog as appropriate, and review the result with Chris before starting the next package. Do not redesign later packages while implementing the current one.

The reference is [Pi Durable's Pico5 handoff](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/docs/pico-v5-handoff.md). This repository will define its own real check commands as tooling is introduced.

The wiki maintains product intent and decision history. Package documents define implementation contracts and execution steps linked to those decisions. Keep both current when an authorized change affects them.

## Agent workflows

These prompts adapt [Pi's development workflow](https://github.com/earendil-works/pi/tree/4c6fb7cfe8c538a668726f6f8b3554098c39faee/.pi) to Dispatch Web. They follow this repository's package contracts, worktree/publication policy, and available checks. They do not assume Pi's npm commands, release versioning, GitHub labels, or terminal UI.

In Pi, launch from the repository or task-worktree root and grant project trust to load `.pi/` resources. Invoke a prompt by its filename, such as `/deslop` or `/is <issue-url>`; use `/reload` after changing templates in an active session. Other agents should read and follow the linked Markdown directly; these files are not automatically registered as commands in every client.

| Prompt | Use it for |
| --- | --- |
| [/deslop](.pi/prompts/deslop.md) | Simplify a completed work package while preserving its intended behavior |
| [/is](.pi/prompts/is.md) | Investigate an issue and propose a verified implementation approach |
| [/pr](.pi/prompts/pr.md) | Review a PR against code, contracts, acceptance criteria, tests, and documentation |
| [/wr](.pi/prompts/wr.md) | Finish the current task through checks, documentation, commit, and verified publication |
| [/cl](.pi/prompts/cl.md) | Audit package changelogs against the relevant commit history |
| [/sa](.pi/prompts/sa.md) | Prepare an evidence-based security advisory draft |

Load these longer procedures only when their task applies:

- [Interactive testing](.pi/skills/interactive-testing.md): verify specified browser workflows and observable outcomes once a runnable application exists.
- [Release](.pi/skills/release.md): establish the actual release target and commands, validate the candidate, and verify an authorized publication. Release tooling is currently unconfigured.

Use `/deslop` after implementing a work package, then rerun affected checks before `/wr`. `/is` and `/pr` are investigation/review tasks; neither authorizes implementation or external messages. `/wr` follows the Git publication policy below, but does not itself authorize GitHub comments, issue-state changes, a deployment, or starting the next work package.

## Checks and publication

For this documentation-only stage, run `git diff --check` (and `git diff --cached --check` after staging), inspect the full diff, and verify local documentation links. No application behavior has been verified by these checks.

Use a task branch and worktree for concurrent work; edit canonical `main` only with exclusive checkout ownership. Before publication, fetch the latest remote target, reconcile any changes, and rerun the applicable checks. Commit only task changes, push normally to `main` unless the task requires a PR, and verify the published commit. Fast-forward a clean canonical checkout after publication; preserve existing edits and unpublished work.

CI and release automation are not configured. Existing shared CI policy continues to apply; an empty workflow directory does not enable GitHub Actions.
