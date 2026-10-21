# Contributing

Dispatch Web has a local browser/service implementation with authentication, native Pi Durable chat, named agents, and a branded responsive workspace. Work within the current authorized task and the check policy below.

## Testing policy

Do not add or run automated tests. This does not apply to AI agents using `agent-browser` for interactive verification of authorized work; no separate testing-policy exception is needed. Source review, TypeScript checks and builds remain permitted. Future coverage should prioritize stable end-to-end and API behavior, not implementation details or coverage counts. Builds do not establish runtime correctness; record dated observations and unverified outcomes in the task report or relevant linked supporting document.

## Local development and Nix builds

Use TypeScript throughout application code. From the repository root, with Nix installed and `nix-command`/`flakes` enabled:

```sh
nix develop
npm ci
npm run dev
```

The current local development instance uses `http://localhost:5174` (October 11, 2026). For startup commands and port selection, see the [development guide](packages/web/docs/usage-guide.md#start-development). Frontend source edits hot reload without restarting the persistent service. Changes to the service or its imported modules restart only the backend after its previous process shuts down; existing state stays in place. Stop the launcher with Ctrl-C. See the [background launch instructions](packages/web/docs/usage-guide.md#background-development) to keep it running after closing the terminal. Stop development before repeating `npm ci` after a lockfile change. Use the scoped [checks below](#checks-and-publication); reuse existing build outputs when their inputs have not changed. The Node 24 toolchain is shared by the Nix shell and build, and npm dependencies are locked in `package-lock.json`.

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
| `packages/<package>/USE_CASES.md` | Package actor goals, supported behavior, and explicitly approved additions |
| `packages/<package>/CHANGELOG.md` | Package changes and release history |
| `packages/<package>/docs/spec.md` | Package specification where applicable; Dispatch Web retains only a database-spec access pointer |
| `packages/<package>/docs/handoff.md` | Public implementation and qualification summaries |
| `packages/<package>/docs/usage-guide.md` | Detailed integration guidance when the package has usable interfaces |
| `packages/<package>/src/` | Implementation |
| `packages/<package>/server/` | Owning package’s persistent service integration |
| `scripts/` | Shared development and release tooling |
| `.github/workflows/` | Reserved workflow location; no CI is configured |

Language-specific manifests and build configuration belong beside the relevant package code. Add root configuration only for shared workspace tooling. Keep use-case inventories with their owning package and link them from its README; preserve stable identifiers and distinguish implemented behavior from approved additions. The `web` package owns the frontend and persistent service; further package boundaries will follow the design.

## Specification and implementation

1. Read authoritative project intent and relevant affected-package documentation; follow the database authority below for Dispatch Web.
2. Agree the user workflow and observable outcomes. Record behavior and contracts in the authoritative spec, including state ownership, failure paths, and recovery. Mark proposed or unresolved details explicitly; do not edit a repository copy as live intent after database cutover.
3. Keep implementation notes and verification receipts in repo-local supporting documents when needed. Link useful detail from the specification; do not create additional product requirements or ticket numbering by default.
4. Implement the current authorized task. Record source/type/build evidence and unverified functional outcomes in the task report or relevant linked supporting document; document actual usage.
5. Run the permitted repository checks, inspect the diff, update the package changelog as appropriate, and review the result with the maintainer before starting further work. Do not expand the agreed scope.

Use this repository's checks below and the current testing policy.

The repository is the authoritative home for product setup, usage, runtime and contribution documentation. Dispatch Web's live project requirements are versioned Markdown stored only in Dispatch's database. Read them in Projects → project → Spec or through `conversation_project_spec`, pinning the returned revision across pages. The repo [spec-access pointer](packages/web/docs/spec.md) contains no requirements body or export. Other package-local specifications remain documentation where applicable.

Historical handoffs and retired Git content are evidence, not a second authority. Do not restore requirements from history, populate intent from code, or treat omissions as approval. Iterate intent with the maintainer; reading/adoption does not authorize implementing a backlog. No file synchronization or competing editable master. Keep technical detail repo-local and link it from the project document when appropriate.

## Agent workflows

These prompts adapt [Pi's development workflow](https://github.com/earendil-works/pi/tree/4c6fb7cfe8c538a668726f6f8b3554098c39faee/.pi) to Dispatch Web. They follow this repository's package contracts, worktree/publication policy, and available checks. They do not assume Pi's npm commands, GitHub labels, or terminal UI. Our release workflow adopts lockstep versions with the SemVer policy below.

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
- [Release](.pi/skills/release.md): canonical executable runbook for preparation, local builds, verification, public publication and documentation. A release request authorizes the whole ordinary workflow; prior release chats are not prerequisites.

These repository prompt/skill files and `AGENTS.md` are not automatically loaded by Dispatch agents. Dispatch-native discovery requires a pointer in supplied agent/project context or an explicitly assigned saved catalog skill; see [release discovery](.pi/skills/release.md#discovery-in-dispatch). Verify that connection in a fresh conversation rather than assuming the directory name enables it.

Use `/deslop` after implementing a work package; rerun affected checks only if that review changes their inputs before `/wr`. `/is` and `/pr` are investigation/review tasks; neither authorizes implementation or external messages. `/wr` follows the Git publication policy below, but does not itself authorize GitHub comments, issue-state changes, a deployment, or starting the next work package.

## Public information boundary

Keep company/customer names, account and request identifiers, deployment hosts,
personal paths, authenticated captures, transcripts and credentials outside this
public repository and its release artifacts. Use synthetic examples and retain
installation evidence in private operator records. Check image content as well
as text; a secret scanner alone does not identify private operational details.
Preserve license notices and public author attribution.

The public history was reset on October 21, 2026. Start new work from a fresh
clone. Do not merge or push branches from the retired history; transfer reviewed,
sanitized changes as patches onto the new history. Earlier tags and release
assets were withdrawn rather than moved to different source.

## Checks and publication

Run `npm run check` inside `nix develop` for TypeScript changes. Run `nix build` and `nix flake check` when packaging, dependencies or Nix inputs change, and for release artifacts. Documentation-only edits need diff and affected-link review. Build each required artifact once and reuse it across verification and deployment; repeat checks only after relevant changes or failures. There is no functional test suite under the current zero-tests rule. AI-agent interactive verification using `agent-browser` is permitted under the [testing policy](#testing-policy).

Also run `git diff --check` (and `git diff --cached --check` after staging), inspect the full diff, and verify changed local documentation links. Documentation checks do not verify application behavior.

Use a task branch and worktree for concurrent work; edit canonical `main` only with exclusive checkout ownership. Before publication, fetch the latest remote target and reconcile changes; rerun checks affected by that integration. Commit only task changes, push normally to `main` unless the task requires a PR, and verify the published commit. Preserve existing edits and unpublished work; reconcile them with their owner rather than resetting or overwriting them.

For a local development task, synchronize the checked revision into the clean canonical checkout and verify it in the running browser. For other tasks, deliver to the authorized target without an unrelated local restart or deployment. Preserve active work when synchronizing or restarting.

**Accepted October 10, 2026:** release builds run locally with Nix, not GitHub Actions. Keep the exact source revision, reproducible commands and artifact checksums/digests in build receipts; local builds do not replace installation acceptance. CI and automatic release publication are not configured; an empty workflow directory does not enable GitHub Actions.

## Versioning and releases

**Accepted October 12, 2026:** a human request to make a release is authorization to prepare, verify, commit/push, tag, publish public archives/registry images using available credentials, and update documentation. Do not request approval again for those ordinary steps. Missing access is an action-specific blocker, not an approval gate; report it and continue unblocked channels. Live customer deployment/data changes are separate from making a release. The [release runbook](.pi/skills/release.md) is the canonical procedure for a fresh chat, without prior transcripts or ignored scripts.

**Accepted October 9, 2026:** follow Pi's lockstep workflow: the root manifest, workspace packages and shipped capability package (`packages/web/capabilities/package.json`, outside npm workspaces) share one SemVer version, while each package keeps its own changelog. Preserve `0.1.0` as the initial-development baseline; adding version metadata does not retroactively cut a release. Nix and the browser build derive their version from the web package manifest, not separate literals.

During development, keep meaningful changes under each owning package’s `## [Unreleased]` section, using concise feature or change headings where useful. Do not bump versions for individual work packages. At an explicitly requested release, select one version for the accumulated changes: patch for compatible fixes, minor for compatible additions, and major for incompatible public-contract changes after `1.0.0`. During `0.x` development, use minor bumps for breaking changes and document them; compatibility is not yet stable. Dependency versions and portable bundle format versions are separate identities.

From the root, inside `nix develop`:

```sh
npm run release -- minor --dry-run
npm run release -- minor
```

Replace `minor` with `patch`, `major`, or an explicitly selected newer SemVer version. The mutating command requires a clean working tree; from a prerelease, select an explicit version. The command rejects an existing local `v<version>` tag. The release command prepares lockstep manifest/lockfile versions and dated per-package changelog sections, leaving a fresh `Unreleased` section. Review the dry-run and complete diff before proceeding. It does not commit, tag, push, publish packages, or deploy. Version-only manifest/lockfile changes can invalidate Nix’s fixed `npmDepsHash`; refresh it through the [existing hash-update procedure](packages/web/docs/usage-guide.md#dependency-updates-and-later-deployment) when needed and complete a full `nix build` before tagging. Follow the [release procedure](.pi/skills/release.md) for candidate checks and publication under the initial release request. Tag the checked release revision as `v<version>`; do not move published tags. Private packages are not npm registry publication targets merely because they have a version.

The version shown in the web app identifies its built browser assets, not a live backend handshake or proof of deployment. Retain source revision/artifact digest alongside versions when identifying deployed artifacts.
