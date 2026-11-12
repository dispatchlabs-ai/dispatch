# Dispatch Kit

Starter agents and skills that any company's agent repository gets by pinning a
Dispatch release. They name no company, person or host: a role reads company
context from the company's own `AGENTS.md` and `factory.yaml`. The company
repository keeps only what is its own.

For companies that build their agent release with the
[shared Nix builder](../runner/docs/nix-releases.md). The kit is source alpha,
versioned in lockstep with Dispatch and not published to npm.

## Contents

| Agent | Role |
| --- | --- |
| `jett` | General assistant: direct tools, optional workers, workflow follow-through |
| `development` | Coordinates a feature or fix through implementation, review and publication |
| `developer` | Implements an assigned change in an owned worktree |
| `code-reviewer` | Reviews an exact candidate; report only |
| `use-case-tester` | Separately assigned acceptance; report only |
| `assistant-fable`, `assistant-opus`, `assistant-sol`, `assistant-terra`, `assistant-glm-flash` | Model workers a coordinator can delegate to |

| Skill | Use |
| --- | --- |
| `verification` | Select checks for a change and reassess evidence after a repair |
| `project-work` | Project pages, work items, decisions and results from the company manifest |
| `slack-output` | Format Slack-facing replies |
| `development` | Use-case-preserving repository cleanup |

`kit/` holds what the agents import and link: the worker definition, the
read/shell inspection tools and the
[assignment contract](kit/docs/repository-assignment.md).

## First result

In the company repository's flake, opt in:

```nix
dispatch.lib.mkAgentRelease {
  inherit system;
  name = "company-agents";
  src = source;
  revision = self.rev or self.dirtyRev or "uncommitted";
  withKit = true;
}
```

`src` needs a `factory.yaml` and may be as small as [example/](example).
Build and list the agents; no credentials or model calls are involved:

```sh
nix build
./result/bin/company-agents catalog
```

The output lists the kit agents beside the company's own. From a Dispatch
checkout, `nix build .#checks.SYSTEM.kit-release` builds the example, with
`SYSTEM` such as `x86_64-linux`.

## Company changes

The builder lays the kit down first and the company tree on top.

- **Add.** Any company path the kit does not use is copied as is.
- **Addendum.** `agents/ROLE/company.md` is appended to that kit role's
  `agent.md` under a heading naming its source. Plain Markdown, no frontmatter.
- **Replace.** A company file at a kit path fails the build unless `kit.json`
  at the company root declares it with a reason:

  ```json
  { "replacements": { "agents/developer/agent.md": "Uses the company's own delivery stages" } }
  ```

  A declaration that matches no kit file, or no company file, also fails.

`release.json` records the kit's revision and version under `kit`, and
`share/NAME/kit.json` lists the replacements and addenda that were applied.
A kit role's instructions change with the pinned Dispatch release; apply them
through the ordinary idle definition update.

## Models and tools

Each agent's `agent.md` names a provider and model. The host binds those names
to real model access through its `gateway` or `modelProviders`
[configuration](../runner/docs/service.md#local-model-providers); the kit holds
no route or credential. A company that wants another model for a role replaces
that `agent.md`.

The kit agents use only Runner's coding, read and shell tools. A role that
needs a company tool (a wiki, a tracker) or other message recipients gets them
from a declared replacement of its `agent.ts`. Until then the role reports the
missing capability.

## Limits

- Composition exists only in the Nix builder. A parent Node installation that
  points Runner at a checkout does not get the kit.
- An addendum adds instructions. It cannot change a role's model, tools,
  delegates or message recipients.
- `jett` messages only `development`, and delegates to the five workers.
- The security-remediation mode in
  [Development's protocol](agents/development/operations.md) expects a security
  role and finalized report that a company supplies.

## Checks

`npm run build --workspace @dispatch/kit` runs
[scripts/check.mjs](scripts/check.mjs), which fails when a kit file contains a
home path, an email address, a host outside the reserved example domains, an IP
address, an account or workspace identifier, or a credential.
`npm run typecheck --workspace @dispatch/kit` checks the definitions against
Runner. `nix flake check` runs the content check and builds the example.

Kit text is public. Follow the
[public information boundary](../../OSS.md#public-information-boundary) and
read a change in full; the check matches shapes, not names.
