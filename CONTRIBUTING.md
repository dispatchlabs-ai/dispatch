# Contributing

Dispatch Web has a local browser/service implementation with authentication, native Pi Durable chat, named agents, and a branded responsive workspace. Continue through focused work packages and the check policy below.

## Current check policy

Chris requested **zero tests at this stage** on October 3, 2026. Do not add or run automated tests, smoke tests, or browser acceptance tests. Use source review, TypeScript checks, and builds while this rule is active. Functional acceptance remains unverified unless prior evidence is explicitly dated; a successful build does not establish runtime correctness. The browser-testing workflow below is reserved for when this rule changes. Chris explicitly authorized focused manual browser validation for the October 6 conversation-layout work; [WP-028](packages/web/docs/handoff.md#wp-028--conversation-layout-refinement) records its observed scope and limits. Chris also authorized focused first-deployment SQLite/storage qualification on October 7 for the [AWS container target](packages/web/docs/spec.md#aws-container-deployment-target), using disposable data; this is not authorization for a broad application test suite. Automated tests otherwise remain deferred. Once useful behavior is stable enough to lock in, focus coverage on end-to-end and API tests; unit and implementation-level tests are not the default. Follow the [package testing policy](packages/web/docs/spec.md#testing-policy) before starting test work.

## Local development and Nix builds

Use TypeScript throughout application code. From the repository root, with Nix installed and `nix-command`/`flakes` enabled:

```sh
nix develop
npm ci
npm run dev
```

Open `http://localhost:5173`. Frontend source edits hot reload without restarting the persistent service. Changes to the service or its imported modules restart only the backend after its previous process shuts down; existing state stays in place. Stop the launcher with Ctrl-C. See the [background launch instructions](packages/web/docs/usage-guide.md#background-development) to keep it running after closing the terminal. Stop development before repeating `npm ci` after a lockfile change. Run `npm run check` for route-type generation, frontend/service/tooling TypeScript, and application builds; run `nix build` and `nix flake check` for the pinned build and declared type/build checks. The Node 24 toolchain is shared by the Nix shell and build, and npm dependencies are locked in `package-lock.json`.

Use `npm run auth -- invite --email person@example.com --name "Person"` to provision an account. See the [package usage guide](packages/web/docs/usage-guide.md) for sign-in, provider credentials, built mode, dependency updates, and platform coverage. Shared flake configuration and lockfiles belong at the repository root; the package-specific Nix recipe stays with its package. Future automation must invoke the same build definitions.

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
| `packages/<package>/server/` | Owning package’s persistent service integration |
| `scripts/` | Shared development and release tooling |
| `.github/workflows/` | Reserved workflow location; no CI is configured |

Language-specific manifests and build configuration belong beside the relevant package code. Add root configuration only for shared workspace tooling. The `web` package owns the frontend and persistent service; further package boundaries will follow the design.

## Specification and implementation

1. Read the relevant product intent and decisions from the [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/), then the affected package's specification and handoff.
2. Agree the user workflow and observable outcomes. Record behavior and contracts in `docs/spec.md`, including state ownership, failure paths, and recovery. Mark proposed or unresolved details explicitly.
3. Translate the design into ordered work packages in `docs/handoff.md`. Each package needs its scope, dependencies, acceptance criteria, and applicable checks. Link significant decisions to their maintained wiki record.
4. Implement the current work package. Keep source/type/build evidence and unverified functional outcomes in its acceptance criteria; document actual usage.
5. Run the permitted repository checks, inspect the diff, update the package changelog as appropriate, and review the result with Chris before starting the next package. Do not redesign later packages while implementing the current one.

The reference is [Pi Durable's Pico5 handoff](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/docs/pico-v5-handoff.md). Use this repository's actual checks below; follow the current testing policy for any future coverage.

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

Run `npm run check` inside `nix develop` for code changes. Run `nix flake check` for the declared type/build check and `nix build` to produce artifacts. There is no functional test suite under the current zero-tests rule. Do not run the browser-testing procedure.

Also run `git diff --check` (and `git diff --cached --check` after staging), inspect the full diff, and verify changed local documentation links. Documentation checks do not verify application behavior.

Use a task branch and worktree for concurrent work; edit canonical `main` only with exclusive checkout ownership. Before publication, fetch the latest remote target, reconcile any changes, and rerun the applicable checks. Commit only task changes, push normally to `main` unless the task requires a PR, and verify the published commit. Fast-forward a clean canonical checkout after publication; preserve existing edits and unpublished work.

CI and release automation are not configured. Existing shared CI policy continues to apply; an empty workflow directory does not enable GitHub Actions.
