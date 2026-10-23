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
uses Pi Durable, Pi AI and Chord 1.4.0. Run `npm ls` in the installation to inspect
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
parent dependency tree. Deployment configuration belongs to the installation's
owner, outside the company definition repository.

Before opening an existing store with Pi 1.4, stop its owner and retain a complete
backup. Native SQLite migrates to schema 2; Pi 1.3 cannot reopen it. A source
rollback alone cannot undo this migration. Preserve admitted work and verify
recovery against a private copy before changing a live installation.
