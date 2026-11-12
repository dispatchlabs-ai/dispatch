# Runtime installations and company definitions

The installation owns Dispatch Runner and its Pi dependencies. A company
definition repository owns prompts, models, tools, skills, domain workflows and
the entrypoints that compose them. Do not vendor Runner or install a separate Pi
runtime inside that repository or an individual agent folder.

Use an ordinary parent Node installation:

```text
workspace/
  package.json               # deployment-owned runtime dependencies
  package-lock.json
  node_modules/
  definitions/
    company-agents/          # separate Git checkout
      package.json           # company integration/development dependencies only
      agents/
      skills/
      src/
```

Install the selected immutable Runner archive in `workspace`, retaining its
lockfile. Install optional adapters and the inference client in that same
installation. All shared packages must use the same Pi version; current Runner
uses Pi Durable, Pi AI and Chord 1.5.2. Run `npm ls` in the installation to inspect
the complete dependency tree after an update.

From a nested company checkout, `npm ci` installs only its business and developer
dependencies. Node and TypeScript resolve shared packages from the ancestor's
`node_modules` using ordinary package resolution. There is no custom loader,
global `NODE_PATH`, runtime copy, or dependency rewrite in the definition tree.
Keep the checkout physically under the installation: Node resolves symlinks to
their real location, so a symlink to an unrelated checkout is insufficient.

The company can import native Pi APIs for tools, documents and tasks. Those
imports declare what its code uses; the installation chooses their version.
Verify the company's TypeScript, definition loading and affected domain workflows
against that installed version before deployment. Keep company-specific
initializers, required extensions, persisted namespaces, state locations and
transport routing intact. Moving dependency ownership does not move those
responsibilities into Runner.

For immutable deployment, package the runtime manifest and lockfile above a
`definitions/` directory containing the exact committed company tree. Install
both layers separately and point the service at `definitions/`. Keep each
release's runtime with that release so rollback never silently selects a newer
parent dependency tree. The company repository can own application release
composition and deployment declarations through the [shared Nix builder](nix-releases.md).
Host provisioning, secret values and mutable state remain the infrastructure
owner's responsibility.

Before opening an existing store with Pi 1.4, stop its owner and retain a complete
backup. Native SQLite migrates to schema 2; Pi 1.3 cannot reopen it. A source
rollback alone cannot undo this migration. Preserve admitted work and verify
recovery against a private copy before changing a live installation.

Opt-in development agents can use [disposable workspaces](disposable-workspaces.md)
with a prepared image and a pinned per-run release. This keeps their editable
source separate from the immutable definition/runtime installation.

## Accepted portable-agent direction

Accepted November 9, 2026. [RUN-026 through RUN-033](../USE_CASES.md#2-portable-agents-and-published-packages)
record the intended outcomes; this section records ownership and integration
direction, not a claim of working APIs, published packages or migrated deployments.

An agent principal has its own authority and service identities. A runtime
instance authenticates to act as that principal and retains separate execution
attribution. Its definition and selected release determine instructions, skills,
model configuration and tool contracts. Interface choice and execution location
must preserve those choices for the same release and authorized scope; consistent
behavior does not mean identical model-generated text.

A principal can participate in many independent conversations and tasks. Multiple
people can share one conversation, retaining individual authorship. A messaging
thread maps to a durable conversation that authorized web or terminal clients can
also address. Separate threads retain separate context; using one principal does
not automatically create cross-conversation memory. That memory policy remains a
separate design decision. Reply destinations and audiences remain explicit.

The shared service provides authenticated access to conversations, execution and
capabilities. A worker on a local machine, server or ephemeral sandbox initiates
its connection to that service. Central PostgreSQL state stays behind the service;
workers need neither database credentials nor an inbound application listener.
Instance credentials and centrally managed service bindings let the same agent
use its own capabilities wherever it runs. One instance's access can be revoked
without changing the principal or unrelated instances. Workspace files and
published artifacts retain their own persistence contract.

Principal identity does not determine the number of native stores or owners.
Preserve Pi's ownership of each executing native session and task graph while
allowing independent work to run concurrently. Reuse the existing
[outbound-worker contract](../../workers/README.md),
[remote storage contract](../../remote/docs/spec.md) and
[fleet recovery mechanisms](../../fleet/README.md#recovery-and-limits).
The PostgreSQL protocol already has attempt ownership, atomic mutation receipts
and confirmed worker retirement; extracting and adapting it to shared packages
still requires current Pi storage compatibility and integration verification.
Storage receipts do not establish exactly-once external actions, and a lost
connection alone does not prove that an earlier worker stopped.

| Owner | Responsibility |
| --- | --- |
| Dispatch packages | Published libraries, service components, channel adapters, client APIs and reusable UI components that independent applications can compose; the [kit](../../kit/README.md) of starter agents and skills that name no company, person or host. |
| Shared infrastructure repositories | Centrally maintained, versioned Terraform/OpenTofu modules for deploying those components and their supporting infrastructure. |
| Consumer agent/application repository | Agent definitions, skills, domain workflows, company integrations and application composition from selected packages. |
| Consumer infrastructure repository | Module calls, installation configuration, version selections, secret references, deployment state and rollout. |

Work belongs in the repository of the company whose data and outcome it serves;
shared machinery belongs in the shared layer under a company-neutral name.

Each consumer owns its installation's principals, credentials and data. Local
validation uses the selected agent release and capability contracts against an
explicit target environment before that release is deployed. Existing local
SQLite and parent-installation workflows remain supported; the new goals do not
make a hosted service mandatory for every use.

Use [Pi as the packaging reference](../../../CONTRIBUTING.md#pi-as-the-packaging-reference).
The consumer outcome is an independent repository that installs released packages,
defines and runs an agent, and deploys through shared modules without checking out
Dispatch source or copying runtime implementation. Reusable UI and service APIs
must be consumable without requiring the complete Dispatch Web application.
Exact package extraction boundaries, public API shapes, credential enrollment and
existing-store migration procedures remain implementation decisions. This
direction does not replace Dispatch Web's database-owned product specification.
