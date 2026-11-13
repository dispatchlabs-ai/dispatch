# Verification and limits

Dispatch is pre-1.0 source-alpha software. This record separates public source,
built artifacts and observed behavior. A successful build is not production
installation, model-quality or security qualification.

## v0.15.0 installable Web client — November 13, 2026

The [v0.15.0 release](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.15.0)
contains nine library archives and the Web client from commit
`27b2c6d2b8f1afec333dfb4a51e1a38c1f507af2`. All twelve published asset downloads
matched the reviewed archives, source manifest and checksums.

Fresh npm consumers installed Web from its versioned GitHub URL, both alone and
with Runner. The immutable dependency URLs and integrity hashes for Runner, Web
and Backend matched the release. An application started the owner and both clients
from outside its working directory with one `host.json`. Web returned the CLI's
saved conversation from that owner. The README quickstart also ran from a fresh
application with its default private socket, one Markdown agent and a synthetic
model. Web's browser assets and dependency licenses ship in its archive.

The workspace build and type checks, arm64 macOS and x86_64 Linux flake checks,
frontend and portable macOS builds and both Linux OCI builds passed. External
consumers installed the ten artifacts by URL, checked strict TypeScript imports
and executed libraries with Node 24.22.1 and 26.5.0. The selected production npm
audits reported zero findings. Scope covered local clients and local saved state.

The browser check followed a conversation from CLI to Web and back. Keyboard
send, streaming, explicit Stop, the retained partial answer after reload,
reconnection to the restarted owner and a follow-up completed. The four
required viewport sizes and mobile drawer were inspected. Browser diagnostics
were empty. The interactive check used the exact candidate packages and a
synthetic local model. The same bytes were verified after publication.

## v0.14.1 portable host settings — November 13, 2026

The [v0.14.1 release](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.14.1)
contains nine library archives from `a3699240f9212ecc871886dddb6d0d79ebb0d9d5`.
All published downloads matched the reviewed archives, manifest and checksums.

An external application installed Runner from its versioned GitHub URL. A local
host and CLI client launched from another directory used the same small
checked-in configuration. The host located the agent beside the settings file,
created private state and a socket, completed a synthetic model turn, and
returned the saved answer after a restart. Two named Markdown agents also reopened their distinct
saved conversations through a shared socket. Explicit HTTP-only settings and
existing service and watch commands were exercised with synthetic credentials.

The workspace build and type checks passed. macOS arm64 and Linux x86_64 flake
checks and builds passed, including frontend, portable macOS and both Linux
container images. External consumers checked public imports and strict types,
including the optional Backend and Fleet integrations. Production dependency
audits of the selected installations reported zero findings. The Web client used a
synthetic provider with the same portable host configuration and retained its conversation across a host
restart. Keyboard send, streaming, Stop, reload and mobile navigation were
exercised at the four required viewport sizes. Package and image contents were
reviewed.

## v0.14.0 native MCP tools — November 13, 2026

[v0.14.0](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.14.0)
ships nine library archives from `d7a8233f4287564a9c17739b3ee71c0f899ec93a`.
The downloaded archives, manifest and checksums matched the retained bytes. The
Runner archive installed by its versioned GitHub URL into a standalone application.
Pi MCP and Pi Durable are pinned to 1.5.2; the coding-agent runtime is not required.

One Markdown agent, a configured authenticated stdio MCP client, and a real
model routed through a shared inference gateway completed research with four
discovered tools. The resulting article and original conversation supported the
answer's citation anchors. The native store retained a 58,838-byte tool result;
the installed host reopened the same answer after restart without new work. A
separate live Streamable HTTP server returned a document through the released
connector. These checks qualify the transports and tools exercised, not arbitrary
servers, interactive OAuth or non-tool MCP features.

All nine archives passed external installation, public-file, integrity, strict
NodeNext type and runtime import checks; the selected production npm audits had
zero findings. Workspace build and type checks, arm64 macOS and x86_64 Linux
flake checks, frontend and portable macOS builds, and both Linux OCI builds
passed. Package and image contents were reviewed, including known-pattern scan
matches in upstream examples and library strings. Synthetic Web/CLI qualification
covered keyboard send, streaming, Stop, retained history, reload and reconnect;
Web was inspected at 1440×900, 1280×720, 768×1024 and 390×844. No hosted deployment
or live messaging channel was changed or qualified by this release.

## v0.13.1 one-file host — November 13, 2026

**Setup correction after release:** the initial instructions omitted `npm init`.
In a new directory nested beneath an existing npm project, installation selected
that parent project. The current instructions initialize a local package first.
The corrected commands were exercised in that nested layout: Runner was the
child application's only direct dependency, its audit reported zero findings,
and the parent manifest remained unchanged. Release archives and tags are unchanged.

[v0.13.1](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.13.1)
resolves to `29340ac0ff8bb5fb0daf9096572d720315a9cd2a`. All nine library archives,
their clean-source manifest and checksums were published and downloaded again;
all eleven assets match the reviewed originals, including every package's npm
SHA-512 integrity. This is a GitHub archive release, not npm registry publication.

A fresh directory installed Runner directly from its public GitHub URL with
ordinary npm. One root `agent.md`, `npx dispatch serve --demo` and `dispatch chat`
produced a saved conversation without application code, host JSON, a scaffold or
Nix. The final archive ran on macOS arm64 with ordinary Node 26.5.0 and an official
Node 24.22.1 download; history survived restarting the same host between them.
The same archive and one-file commands also ran on Linux x86_64 with Node 24.22.1.
Runtime and packages remain pinned to Pi Durable 1.5.2.

Actual CLI/Web use shared one conversation: keyboard send and incremental replies,
terminal disconnect without cancellation, explicit Stop with retained partial
text, host restart with automatic browser reconnection, follow-up, reload and
mobile navigation. Whole pages were reviewed at 1440×900, 1280×720, 768×1024 and
390×844, with no browser console errors. Root and named definitions coexist;
duplicate root/named IDs, missing credentials and absent or duplicate hosts
produce actionable errors. No live provider credentials were used.

Full source/type/build checks, measured dependency hashes and macOS/Linux Nix
flake checks passed, including frontend, portable macOS and both Linux OCI
artifacts. External consumers installed all nine archives, imported 22 library
subpaths and checked the worker executable's declarations/resolution. Strict
NodeNext declaration checking used the documented ES2024 types and optional
upstream MCP SDK dev dependency. Minimal Backend and Fleet consumers did not
require central-storage or Slack peers. Downloaded archives passed the same
import/type checks; imports ran on Node 24 and 26. Production audits reported zero findings.

Source, outgoing history, package contents, notices and image metadata were
reviewed. Nine package archives had no known-pattern scan matches. Application
artifact matches were reviewed upstream examples, parser strings, empty npm
configuration and SDK source directories; the images were qualified, not uploaded.
Scans are supplementary evidence, not comprehensive security clearance.

No automated functional tests were added or run. Live inference, channel delivery,
hosted TLS, multi-user authorization and other platforms were not requalified.
No fresh independent agent walkthrough or deployment was performed. Consumer
repositories and installed services were unchanged.

## v0.13.0 package release — November 13, 2026

[v0.13.0](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.13.0)
resolves to `6cb31cad047bdad54964c9602e9936d305accb7b`, with Node 24.22.1 and
Pi Durable 1.5.2. All nine reusable archives, their clean-source manifest and
`SHA256SUMS` are public release assets. Their uploaded digests and downloaded
bytes were verified against the original archives, including npm SHA-512
integrity. This is an archive release; the packages are not published to npm.

Full source builds and type checks passed. macOS arm64 qualification includes
Nix flake checks, the default application, frontend and portable build. Linux
x86_64 qualification includes Nix flake checks, the default application, Web OCI
and worker OCI builds. Linux arm64, Intel macOS and native Windows were not
requalified. The application images were inspected but are not release assets.

Fresh external consumers installed all nine archives together. Strict NodeNext
declaration checking used the documented ES2024 library types and optional MCP
SDK dev dependency. All 22 library subpaths imported; the worker CLI subpath
resolved and its declarations checked. That executable requires worker
configuration when run. Separate consumers verified Runner + Backend without
Remote/Postgres and Runner + Fleet without Slack. Full and production dependency
audits reported zero findings. The downloaded archives were installed and checked
again after publication.

The one-Markdown README example ran from installed archives on both platforms.
A fresh application also installed Runner alone from its public release URL;
the example ran and replayed the same retained entries. Actual Web interaction
on macOS covered streaming, keyboard send, explicit Stop with a retained partial
reply, automatic reconnection after the host restarted, continued conversation,
reload and mobile navigation. The whole page was reviewed at 1440×900,
1280×720, 768×1024 and 390×844. Temporary owners and browser sessions were closed.

Source and artifact content, metadata and license notices were reviewed.
Supplementary known-pattern scans found no matches in the nine package archives.
Application artifact matches were inspected as upstream SDK examples, parser
strings, documentation fixtures, empty npm configuration and SDK source
directories. These scans do not establish the absence of arbitrary secrets.

No automated functional tests were added or run. Live channel delivery,
real-model quality, hosted TLS and multi-user authorization were not requalified;
this was not a comprehensive security review or a fresh independent agent
walkthrough. No consumer repository or installed deployment was changed.

## Simple definitions and shared clients — November 13, 2026

Before v0.13.0, the host/client simplification was checked on macOS arm64, Node
24.22.1 and Pi Durable 1.5.2. Full source/type/build checks and the current
macOS Nix flake checks passed. Linux outputs were not executed for this change.

All nine reusable archives installed together outside the checkout and passed
real imports and strict NodeNext consumer type checking. Separate consumers
loaded and type-checked Runner + Backend without Remote/Postgres, and Runner +
Fleet without Slack. Full upstream declaration checking needed the documented
optional MCP SDK dev dependency. Dependency audits before and after it reported
zero findings. The archives included their licenses and declared exports, omitted
the removed owner/upgrade modules, and produced no known-pattern or sensitive-path
scan matches. Source and outgoing-change review accompanied those scans.

The Runner README example ran from an installed archive with just one `agent.md`
and application code. Repeating its request returned the same retained entries.
The CLI and Web used one explicit host and continued the same native conversation.
Observed behavior included streaming, keyboard send, explicit Stop with retained
cancellation, saved history after restart, and automatic Web reconnection after
the owner restarted. The browser recovery check exposed and fixed an HTTP error
that prevented EventSource from reconnecting. A CLI disconnect left its admitted
turn running, and its native receipt subsequently reached `done`.

Authenticated loopback HTTP accepted the client token and rejected missing
authentication. A changed owner expectation returned 409 before dispatch. A new
state directory exposed the same canonical owner identity before and after its
first restart; replaying the request kept the same conversation and submission.
The shared read-only CLI inspected the synthetic store without becoming its owner.
Rendered Web pages were reviewed at 1440×900, 1280×720, 768×1024 and 390×844;
mobile navigation and keyboard dismissal worked. Temporary services, stores and
browser sessions were removed after these observations.

No automated functional tests were added or run. This is source qualification,
not a package release, npm publication, deployment, new Linux qualification,
live Slack/Google Chat/email delivery check, hosted TLS or multi-user authorization
review, real-model quality evaluation, or comprehensive security assessment.
The revised walkthrough was exercised here; a fresh independent agent session
was not repeated. Existing deployed consumers remain on their selected releases.

## Complete application definitions — November 13, 2026

Before v0.13.0, removal of the starter kit was verified on macOS arm64 with Node
24.22.1 and Pi Durable 1.5.2. Package build/type checks, `nix flake check`, the
default application and the small agent-example build passed. The example's
packaged definition tree matches its source exactly; its catalog loads without
opening a conversation store. The release-preparation dry run includes the twelve
remaining workspaces and no kit inputs.

All five reusable archives installed together into a fresh external ESM project.
Strict NodeNext consumer type checking passed. The Runner README's synthetic
example produced a reply; the packaged CLI loaded its complete two-file definition.
A separate service owner accepted input from the CLI, a Backend client observed
the same native conversation, and stopping/restarting the owner preserved its
history. The clients disconnected without stopping the owner. Temporary owners
and synthetic stores were removed after verification.

Dependency audits reported no findings. Archive scans reported no known-pattern
or sensitive-path matches, accompanied by source/content review. This is a scoped
packaging check, not a new security certification, Linux execution qualification,
rendered Web review, real inference check or live channel deployment. No automated
functional tests were added or run.

## Earlier release baseline

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

## Web walkthrough qualification — November 12, 2026

The [published prompt and manual walkthrough](web-quickstart.md) were exercised by two
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
- The shared client protocol supports installation-wide authentication. Multi-human
  grants and machine-principal enrollment remain outside the current alpha contract.
  See the [interface inventory](interfaces.md).
- Source review and dependency scans are not a penetration test.

## Reproduce the permitted checks

Follow [CONTRIBUTING](../CONTRIBUTING.md) for source/type/build checks and the
[interactive verification guide](../.pi/skills/interactive-testing.md) for real
browser interaction. Dispatch does not add or run automated functional tests.
The public commands require no private repository or deployment configuration.

Keep private logs, machine identifiers and screenshots outside public source.
Publish only sanitized observations with revision, platform and explicit limits.
