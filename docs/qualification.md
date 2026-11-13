# Verification and limits

Dispatch is pre-1.0 source-alpha software. This record separates public source,
built artifacts and observed behavior. A successful build is not production
installation, model-quality or security qualification.

## Released baseline

[v0.12.0](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.12.0)
resolves to `5aba1696f9944175fd4ce6da87b44560a1eec970` and pins Pi Durable 1.5.2.

Recorded November 12, 2026 at that commit: full package build/type checks; macOS
arm64 Nix flake, default, frontend and portable builds; Linux x86_64 default, Web
OCI and worker OCI builds and Nix flake checks; external packed consumer strict
type checking with real imports; and production and full dependency audits with
zero findings. The five public reusable archives have a clean source manifest and
SHA-256 checksums, verified again after download. They are GitHub release assets,
not an npm registry publication. On Linux the kit command and the starter
template also built, and the template's catalog listed its seven agents. No
automated test suite was run, and no rendered browser review was repeated for
the release commit; the release changes no browser interface.

Artifact scans were accompanied by source/content review and reported no
known-pattern matches in the five archives. This is bounded privacy evidence,
not a security certification. [v0.11.2](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.11.2)
(`9707e09bc4a192425249f37a725bbc40f3e1ca18`) passed the same checks earlier the same day.

## Kit customization and first conversation — November 12, 2026

Observed on macOS 27.2 arm64 at `403eefe`, with a Nix-built release unless noted:

- A repository created with `nix flake init` from the kit template built, and
  its catalog listed the seven agents its `kit.json` keeps. `nix flake check`
  builds the same template with the checkout standing in for the pinned release.
- With one OpenAI API key bound through `environmentProvider`, the template's
  Jett answered, continued the same session, and delegated a file-writing task to
  `assistant-terra`, which wrote the file in the configured working directory.
  Without the key, the turn ended with the withheld-details authentication
  message. This is one short conversation; it does not measure model quality.
- A synthetic company tree changed four kit roles through `roles`: added and
  whole-list recipients and delegates, an added company extension, a removed
  kit extension and a whole extension list. The composed definitions loaded with
  the expected lists and passed strict type checking. A change naming an
  extension the kit role lacks failed the release build with that message.
  Malformed entries, a changed role that is also replaced or omitted, and
  unknown recipients or modules were each reported by the composer.
- `status` and `accept` ran directly and through `nix run ...#kit`. With a
  record altered to stand for an earlier kit, `status` listed the changed
  replaced file, the unrecorded one, received changes, and new and removed
  files; the build printed the two warnings, `catalog` repeated them, and both
  stopped after `accept`.

After the release, from the published tag: a repository created with
`nix flake init -t github:dispatchlabs-ai/dispatch/v0.12.0#kit` built on macOS,
`nix run --inputs-from . dispatch#kit -- status` ran against it, and the guide's
first-conversation commands produced a real OpenAI reply. Four private company
repositories moved to v0.12.0 and turned 11 of their 20 declared file replacements into
`roles` entries, leaving 9. Each built its releases on Linux x86_64 with the
composed roles carrying the configured recipients and extensions, and three
passed their own Nix checks. The fourth passes its type check and 85 of 86
tests: its own tool authorization follows task owners from a delegated child to
the coordinator's current model turn and stops at the background worker task
that Runner 0.11.1 introduced (see [parallel children](../packages/runner/docs/parallel-children.md#who-owns-a-delegated-child)).
None of those four builds has been deployed.

Not observed: a kit move between two real releases (the earlier kit was
simulated by editing the record); `environmentProvider` with any provider other
than OpenAI; a first conversation on Linux; any installed service running a
role changed through `roles`.

## Web walkthrough qualification — November 12, 2026

The [published prompt and manual walkthrough](quickstart.md) were exercised by two
fresh agent sessions using clean public clones and isolated synthetic state:

| Platform | Source | Observed result |
| --- | --- | --- |
| macOS 27.2.1 arm64 | `579c5f471c2b45b149b477bbccafa1dea3c68925` | Install/build, synthetic reply, reload, stop/restart, preserved conversation, follow-up and phone navigation passed. |
| Linux x86_64 | `579c5f471c2b45b149b477bbccafa1dea3c68925` | The same workflow passed, but process status exposed an undeclared `lsof` dependency. |
| Linux x86_64, fresh follow-up clone | `8d80691c741d890dd065e98e155e00a0d7eff175` | Install/build, synthetic reply, reload, restart/history, follow-up and mobile navigation passed; the process-status warning was absent. |

Both sessions reviewed the whole browser page at 1440×900, 1280×720, 768×1024 and
390×844 and exercised keyboard send and mobile navigation. Neither required user
intervention. They used the guide's existing-Nix-profile instructions and alternate
loopback port; Linux also used the documented per-command experimental-feature
flags. The Linux browser ran on Linux, with a private control tunnel supplied by
the verification harness. This does not establish compatibility with every agent
or browser. Both demos were stopped and their browser sessions closed.

The follow-up `8d80691c741d890dd065e98e155e00a0d7eff175` supplies `lsof` in the
development shell and Nix Web/Runner commands. The Linux repeat observed incremental
reply streaming; the macOS run observed the sending state and complete reply,
without independently verifying incremental streaming.

Additional observations:

- Full dependency installation, package builds and type checks passed. The final
  full npm audit reported zero findings after updating the affected HTTP,
  frontend-build and packaging dependencies. This is the audit database's result
  on this date, not a guarantee about undiscovered vulnerabilities.
- macOS Nix flake/default-package, frontend and portable builds passed. Linux
  Runner, Web OCI and worker OCI builds passed. The repaired Linux watcher also
  ran from its Nix package with a minimal PATH and returned no discovery issues.
- Kit catalog loading and the synthetic Eval example passed: three cases,
  twelve grading steps and zero failed steps. Kit composition retained the exact
  kit MIT notice; the Eval release retained its MIT notice. These synthetic
  graders do not measure a real model's quality or human agreement.
- All five reusable archives installed in an external ESM consumer; strict
  NodeNext type checking and real imports passed, with zero production audit
  findings. A release dry run included the OpenAPI version and changed no files.
- Manual HTTP checks observed unauthenticated denial, Host/Origin denial,
  successful login, idempotent replay of a message request, scoped Stop, logout,
  cookie revocation and closure of the authenticated event stream. This used a
  loopback fixture and synthetic identity, not a deployed HTTPS installation.
- Independent source/privacy review covered documentation, contracts, licensing,
  dependency changes, Nix packaging and CI entry points. Outgoing-commit secret
  scanning found no secrets. Artifact scan matches were reviewed as upstream
  examples, parser strings or SDK source paths; image content and metadata were
  reviewed separately. These checks are bounded evidence, not a penetration test.

The repository-owned CI entry points passed both source/type/build and Nix stages
on maintainer-owned Linux infrastructure for
[`8d80691`](https://github.com/dispatchlabs-ai/dispatch/commit/8d80691c741d890dd065e98e155e00a0d7eff175).
GitHub's `omarchy/linux` status was verified as successful. This uses no GitHub Actions.
No automated functional tests were added or run. This qualification publishes
source fixes only: it does not replace v0.11.1 assets, publish to npm or upgrade
any installation.

## Discovery observation — November 12, 2026

Before updating GitHub's description, topics and homepage, Dispatch was absent
from the first ten results for both `durable agents evaluation language:TypeScript`
and `agent starter kit evaluation`. Afterward, it appeared in the first ten for
the former query and remained absent for the latter. This is one dated GitHub
repository-search observation, not evidence of adoption or a stable ranking.
The public quickstart was also fetched anonymously with HTTP 200.

## Platform and capability boundaries

- The Nix flake defines macOS arm64, Linux x86_64 and Linux arm64. Declaring an
  output does not qualify every workflow on that architecture.
- This Nix walkthrough does not claim Intel macOS or native Windows support.
  Runner's separate [Windows guidance](../packages/runner/docs/windows.md) retains
  the scope and dates of its earlier observations.
- Synthetic examples exercise native execution, storage and client plumbing.
  They do not qualify external model quality, live tools, real channel accounts
  or production provider credentials.
- Hosted HTTPS, consumer-specific authorization, real channel delivery, fleet
  installation and each production recovery path remain installation-owned.
- Multi-human grants and a general authenticated network agent-client API are
  outside the current alpha contract. See the [interface inventory](interfaces.md).
- The kit requires composition before loading an adopting repository. Model
  and role changes, addenda and declared file replacements are supported.
  `status` names the kit files that changed for a repository by digest; it does
  not show what changed in them. Repositories that do not use Nix are not a
  supported audience: the kit and composer have no npm distribution. The
  synthetic Web quickstart does not establish the kit workflows; the section
  above records what was observed for them.
- Source review and dependency scans are not a penetration test.

## Reproduce the permitted checks

Follow [CONTRIBUTING](../CONTRIBUTING.md) for source/type/build checks and the
[interactive verification guide](../.pi/skills/interactive-testing.md) for real
browser interaction. Dispatch does not add or run automated functional tests.
The public commands require no private repository or deployment configuration.

Keep private logs, machine identifiers and screenshots outside public source.
Publish only sanitized observations with revision, platform and explicit limits.
