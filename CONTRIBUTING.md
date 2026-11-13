# Contributing

Read [OSS.md](OSS.md). Work in an owned task branch/worktree, preserve other work,
inspect the full diff and staged/outgoing content for private information before
committing. Use synthetic data; keep captures and receipts outside public source.
Publish only within explicit task authority; source publication is not deployment.

## Ownership and contributions

Chris Reynolds, cofounder of Dispatch Labs AI, created Dispatch and maintains the
project. Contributions are accepted under the existing MIT license; no CLA or
copyright assignment is required. Preserve contributors' and upstream notices.
Use GitHub Issues for reproducible bugs and proposals, and [SECURITY.md](SECURITY.md)
for private vulnerability reports. Keep reproductions synthetic.

Automatic checks run on maintainer-owned equipment; this repository does not use
GitHub Actions. Public check commands below remain independently reproducible.
Current observed checks and limits are in [the verification record](docs/qualification.md).
The portable CI entry points are `scripts/check` (locked toolchain, dependency
installation, build and type checks) and `scripts/check-package` (Nix checks and
application build). They run no automated functional tests, publish nothing and
do not deploy a service.

## Testing policy

Do not add or run automated tests. AI-agent interaction using `agent-browser` is
permitted. Use source/type/build checks and real rendered interactions, not scripts
disguised as tests. Builds alone do not qualify behavior or external inference.

## Development and checks

```sh
nix develop
npm ci
npm run build
npm run check
nix build
nix flake check
```

Build dependencies before typechecking a fresh checkout: public package exports
resolve generated declarations. Slack must be built before Fleet. `npm run build`
uses dependency order. For a first browser result use the [composition example](examples/chat/README.md).
`npm run dev` builds then starts Web; frontend changes require rebuilding.
No machine-specific launchers or installed-runtime dist-file discovery.

TypeScript checks run inside `nix develop`. Packaging/dependency/Nix changes also
require measured `npmDepsHash`, `nix build`, `nix flake check`, affected artifacts
and isolated packed consumers. Record source revision, commands/results and limits
in the private task report. Do not run functional suites. Review the whole page
at 1440×900, 1280×720, 768×1024 and 390×844; observe keyboard, recovery and mobile
navigation, not just screenshots. Run `git diff --check`, staged whitespace checks
and affected documentation-link review.

## Specification and implementation

The authorized Web replacement supersedes the retired database-only workspace
specification. Current bounded contracts live with [Web](packages/web/README.md),
[Backend](packages/backend/README.md), [Workers](packages/workers/README.md) and
[Postgres](packages/postgres/README.md). [Use cases](packages/web/USE_CASES.md)
distinguish surviving goals, explicitly retired surfaces and accepted future scope.
No restored company/project API, no parallel editable database spec.

Authored agent definitions, skills, tools, model bindings, authority and native
state belong outside Web. CLI and channels use the same native identities and
operations. This feature does not implement every accepted portable-agent goal.

## Agent workflows

Read [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md) for
rendered checks, [.pi/prompts/deslop.md](.pi/prompts/deslop.md) for the required
behavior-preserving review, and [.pi/skills/release.md](.pi/skills/release.md) only
for an authorized release. No cleanup or separate acceptance stage is implied.

## Pi as the packaging reference

Packaging reference, rechecked November 13, 2026: released Pi 1.5.2
[`b4afddd`](https://github.com/earendil-works/pi/tree/b4afdddf44e059c67ccf5097e5317d913521b470)
governs the current runtime.
Read its Durable manifest (exports/types/files/exact dependencies),
`scripts/publish.mjs`, `scripts/check-package-install.mjs` and release procedure.
Use the pinned release's public contracts, not unreleased storage internals.
Dispatch follows packed, external consumer checks and emitted types/files, not
Pi tests or CI. Reusable runtime and channel packages and the Web executable are prepared together as versioned archives;
actual release availability is recorded in the root README. npm publication is separate. The root, Observer and Eval manifests set `private: true` to exclude npm publication; their
source is public under MIT. Follow
[scripts/README.md](scripts/README.md) for reviewed tarball preparation, external
consumers and separately authorized publication. The PostgreSQL implementation
uses the **released public Storage** contract, including grouped commit receipts, not copied unreleased SQLite internals.

## Versioning and releases

Root and workspace manifests remain lockstep. Keep changes under each package's
Unreleased changelog. `npm run release -- minor --dry-run` previews a version;
mutating release preparation requires a clean tree, does not publish or deploy.
There is no longer a separate Web capability package to version. During 0.x,
breaking contracts require a minor release at the next authorized release.

Fixed dependency hash: temporarily select the standard all-zero SHA-256,
run `nix build`, record its actual mismatch hash, replace every shared-lock
`npmDepsHash`, then build successfully. Never commit a placeholder hash.
Before publication fetch/reconcile the remote, rerun affected checks, inspect
outgoing commits and push normally only when assigned. No force pushes or moved tags.
