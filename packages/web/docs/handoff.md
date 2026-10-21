# Implementation and qualification overview

This public summary preserves useful implementation boundaries from the earlier
handoff records. Installation-specific transcripts, accounts, hostnames, local
paths, task identifiers and deployment receipts are retained privately. The
[use-case inventory](../USE_CASES.md), [usage guide](usage-guide.md) and package
[changelog](../CHANGELOG.md) describe the public project. Live project intent
remains available through the [specification interface](spec.md).

Historical observations qualify their stated configurations and workflows only.
They are not acceptance of every current feature, platform or installation.

## UI and conversations

The workspace supports shared conversations, threaded replies, agent invitations,
inline mentions, attachments, Markdown composition and responsive navigation.
Historical review used desktop and phone layouts, including 1440×900, 1280×720,
768×1024 and 390×844. Still images establish layout observations only; they do
not establish keyboard, touch, accessibility or recovery behavior.

The public [UI review](ui-ux-review.md), [agent design review](agents-design-review.md)
and [component workshop](component-workshop.md) retain design criteria and limits.
Composer and chat presentation changes must preserve unsent drafts, submission
identity, committed messages and explicit Stop behavior. Pagination and reconnect
states must distinguish missing presentation from deleted durable history.

## Agents and evaluations

Saved agent definitions have immutable revisions. A conversation pins the selected
revision; editing a definition does not silently replace existing instances.
Connections, skills, tools and agent-management grants require their own
authorization. An editor preview is not a saved revision or an access grant.

Evaluation profiles store expectations, criteria and cases separately from agent
instructions. Saving a profile does not execute it. Historical disposable-data
checks covered persistence, revision conflicts and desktop/phone presentation;
broader device and crash-recovery qualification remained separate. See
[agent evaluation profiles](usage-guide.md#agent-evaluation-profiles) for current
interfaces and evidence boundaries.

## Providers and native runtimes

Provider connections and OAuth credentials are installation-owned. Public setup
examples use synthetic identities. Scoped model/tool and continuation observations
do not establish every provider, account lifecycle, hosted platform or recovery
path. Native shells inherit the service account's authority; a working directory
is not a sandbox.

The [runtime guide](runtime.md) describes Pi, Claude and Muse ownership,
continuation, interruption and qualification limits. The separately maintained
inference gateway retains provider credentials outside client workloads; it is
no longer distributed from this repository.

## Projects and specifications

Projects own shared membership, instructions, repository bindings and specification
history. A saved project specification is distinct from an unsaved editor draft,
a source reference or an export. Historical source-editor experiments do not
supersede the current database authority. See [spec access](spec.md),
[saved spec history](usage-guide.md#saved-spec-history-dsp-049) and
[GitHub integration](github-integration.md).

## Tools and connections

MCP, secret-backed Git access, web research, image generation and bundled skills
have separate permission and data boundaries. A successful demonstration of one
operation does not establish broad hosted access or credential lifecycle support.
Private prompts, credentials, authenticated captures and generated run metadata
must stay outside public source and release artifacts. See the relevant sections
of the [usage guide](usage-guide.md).

## Storage and recovery

SQLite and PostgreSQL stores have explicit identities and single-owner recovery
rules. Startup is not an automatic storage migration. Scoped native Linux trials
observed restart persistence and paired database/local-state restore; those checks
did not establish interrupted-agent recovery or full conformance.

Backups must pair databases with encryption keys, attachment bytes and applicable
configuration. Lock release alone is not proof that every writer has exited.
See [offline SQLite import](sqlite-postgres-import.md),
[storage qualification](aws-sqlite-qualification.md) and
[offline installation recovery](usage-guide.md#offline-installation-recovery).

## Workers and deployment

Controller handover must preserve one executor per conversation and distinguish
ordinary instance retirement from installation drain. Confirm old executor
termination before replacement; an expired lease or unavailable status is
insufficient. Exactly-once external effects are not promised.

The [legacy worker contract](conversation-workers.md) and
[backend recovery guide](../server/workers/backend-recovery.md) retain operational
requirements. The newer [portable worker protocol](portable-workers.md) and its
[October 21 qualification](portable-worker-qualification.md) document the opt-in
ECS/exe.dev path and measured limits. No deployment or migration follows merely
from publishing source.

## Portability and backups

Portable agent/project bundles and installation recovery archives serve different
purposes. A bundle is not a full backup, does not convey credentials or grants,
and does not transfer running processes. Validate source identity and imported
content before adopting it. See [bundles](usage-guide.md#agent-and-skill-bundles)
and [installation recovery](usage-guide.md#offline-installation-recovery).

## Checks and limitations

Follow [CONTRIBUTING.md](../../../CONTRIBUTING.md#checks-and-publication) for the
current check policy. Source review, type checking and builds do not establish
runtime correctness. Retain dated, scoped observations and outstanding checks
without publishing customer data or private operational identifiers.

The October 21, 2026 public-history reset changes documentation and distribution
history, not application behavior. Earlier release downloads were withdrawn;
build the current source using the [repository quickstart](../../../README.md).
