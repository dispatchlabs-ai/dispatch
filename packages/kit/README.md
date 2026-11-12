# Dispatch Kit

Starter agents and skills that any company's agent repository gets by pinning a
Dispatch release. They name no company, person or host: a role reads company
context from the company's own `AGENTS.md` and `factory.yaml`. The company
repository keeps only what is its own.

For companies that build their agent release with the
[shared Nix builder](../runner/docs/nix-releases.md). The kit is source alpha,
versioned in lockstep with Dispatch and not published to npm. Repositories that
do not use Nix are not a supported audience yet; the
[composer](#composing-without-the-nix-builder) runs without it from a Dispatch
checkout.

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
read/shell inspection tools, the role-change helper and the
[assignment contract](kit/docs/repository-assignment.md).

## First result

Start a repository from the [template](template). It needs Git and Nix with
the `nix-command` and `flakes` features; no credentials or model calls are
involved yet.

```sh
mkdir my-agents && cd my-agents
nix flake init -t github:dispatchlabs-ai/dispatch/v0.12.0#kit
git init -q && git add -A
nix build
./result/bin/my-agents catalog
```

Nix reads only files Git knows, so `git add` comes before `nix build`. The
catalog lists the kit agents this repository keeps. The template's
[`kit.json`](template/kit.json) binds one model provider, OpenAI: it omits the
three workers that use other providers and gives Jett the two that remain.

An existing repository opts in from its own flake instead. `src` needs a
`factory.yaml`:

```nix
dispatch.lib.mkAgentRelease {
  inherit system;
  name = "company-agents";
  src = source;
  revision = self.rev or self.dirtyRev or "uncommitted";
  withKit = true;
}
```

From a Dispatch checkout, `nix build .#checks.SYSTEM.kit-release` builds the
template, with `SYSTEM` such as `x86_64-linux`.

## First conversation

A conversation needs model access, which belongs to the host and not to the
repository. With one OpenAI API key, write the host's configuration and keep the
key in the environment of the command that uses it:

```sh
mkdir -p .local/work
cat > host.json <<JSON
{ "stateRoot": "$PWD/.local/state", "cwd": "$PWD/.local/work", "namespace": "my-agents",
  "modelProviders": [{ "module": "@dispatch/runner/environment-provider",
    "export": "environmentProvider", "args": ["openai"] }] }
JSON
read -rs OPENAI_API_KEY && export OPENAI_API_KEY
./result/bin/my-agents run --config host.json --session first \
  --prompt "Which agents can you hand work to, and when would you use each?"
```

`read -rs` takes the key without echoing it or writing it to shell history.
Jett answers through OpenAI and bills that key. `cwd` is where its file and
shell tools work; the conversation is saved under `stateRoot`, and the same
`--session` continues it. `host.json` holds paths, not secrets, and the
template's `.gitignore` leaves it out of the repository.

[`environmentProvider`](../runner/docs/service.md#local-model-providers) binds
one of Pi's built-in providers by name and reads only that provider's key. To
use Anthropic instead, pass `"anthropic"`, export `ANTHROPIC_API_KEY`, and set
the roles' models in `kit.json` (see [Company changes](#company-changes)). A
shared or supervised installation binds a gateway or its own provider module in
the same file.

## Company changes

The builder lays the kit down first and the company tree on top.

- **Add.** Any company path the kit does not use is copied as is.
- **Addendum.** `agents/ROLE/company.md` is appended to that kit role's
  `agent.md` under a heading naming its source. `DIR/NAME.company.md` does the
  same for any other kit Markdown file, such as
  `agents/development/operations.company.md`. Plain Markdown, no frontmatter.
- **Model.** `kit.json` can set a kit role's model without replacing its
  `agent.md`; `thinking` is optional:

  ```json
  { "models": { "developer": { "provider": "anthropic", "id": "claude-opus-5-5", "thinking": "high" } } }
  ```

- **Role.** `kit.json` can change whom a kit role messages, whom it delegates
  to and which extensions (tools) it carries, without replacing its `agent.ts`:

  ```json
  { "roles": {
      "jett": { "messages": { "add": ["researcher"] }, "delegates": ["assistant-sol"] },
      "development": { "extensions": { "add": ["src/wiki-tools.ts#WikiTools"] } },
      "developer": { "extensions": ["src/workspace.ts#WorkspaceTools"] }
  } }
  ```

  A list is the whole list. `{"add": [...], "remove": [...]}` changes the kit's
  own list and keeps receiving the kit's later additions. An extension is
  `MODULE#EXPORT`, a company module's path from the repository root and the
  extension it exports. A kit extension is named by its extension name, such as
  `coding-tools`, `kit.repo-inspection` or `dispatch.request-completion`: in
  `remove`, or in a whole list to keep it. A name the role does not have fails
  when the release is built.
- **Omit.** `kit.json` can leave out a kit agent or skill, by file or
  directory, with a reason:

  ```json
  { "omit": { "skills/development": "Uses its own cleanup skill" } }
  ```

  The shared MIT notice is retained as `kit/LICENSE` and cannot be replaced.
  Nothing under `kit/` can be omitted; kit agents import and link it.
- **Replace.** A company file at a kit path fails the build unless `kit.json`
  declares it with a reason:

  ```json
  { "replacements": { "agents/developer/agent.md": "Uses the company's own delivery stages" } }
  ```

  A declaration that matches no kit file, or no company file, also fails. A
  replaced file no longer receives the kit's changes, so prefer the forms above
  and [record the kit](#moving-to-a-new-kit) a replacement was written against.

`release.json` records the kit's revision and version under `kit`, and
`share/NAME/kit.json` lists the replacements, omissions, model and role changes
and addenda that were applied.

## Moving to a new kit

A kit role's instructions change with the pinned Dispatch release. Move the tag
in `flake.nix`, run `nix flake update dispatch`, and ask what the new kit
changes for this repository:

```sh
nix run --inputs-from . dispatch#kit -- status
```

`status` lists the kit files the repository receives that changed, new and
removed kit files, and each replaced file whose kit original changed. The last
list is the one to act on: compare `packages/kit/PATH` between the two Dispatch
versions and carry over what applies to the replacement. Then record the kit:

```sh
nix run --inputs-from . dispatch#kit -- accept
git add kit.lock.json
```

`accept` writes `kit.lock.json`, the digest of every kit file at this version.
Commit it with the change that moves the tag. A build whose replaced file has
changed in the kit since that record, or has no record, still succeeds and
prints a warning; `NAME catalog` repeats it and `share/NAME/kit.json` carries
it under `review`. `--inputs-from .` makes `dispatch` mean the release this
repository pins.

Apply changed definitions through the ordinary idle definition update.

## Composing without the Nix builder

An installation that packages a checkout or an archive itself runs the same
composition as one step and points Runner at the result:

```sh
node packages/kit/scripts/compose.mjs packages/kit COMPANY_CHECKOUT DESTINATION [SUMMARY.json]
node packages/kit/scripts/compose.mjs status packages/kit COMPANY_CHECKOUT
node packages/kit/scripts/compose.mjs accept packages/kit COMPANY_CHECKOUT
```

`DESTINATION` is the definitions root. A company checkout that has adopted the
kit is not a loadable root by itself: its kit roles and skills exist only after
composition. `kit.json`, `kit.lock.json` and applied addendum files are build
inputs and are not copied into the result. Warnings go to standard error.

## Models and tools

Each agent's `agent.md` names a provider and model. The host binds those names
to real model access through its `gateway` or `modelProviders`
[configuration](../runner/docs/service.md#local-model-providers); the kit holds
no route or credential. A company that wants another model for a role sets it
under `models` in `kit.json`.

The kit agents use only Runner's coding, read and shell tools. A role that
needs a company tool (a wiki, a tracker) or other message recipients gets them
under `roles` in `kit.json`.

## Limits

- A raw checkout or archive of a company repository that adopted the kit does
  not load. Compose it first, with the Nix builder or the script above.
- A kit skill's text is part of the definition fingerprint of every agent that
  loads skills, so moving the kit pin can require an idle definition update
  for company agents too.
- Development hands off with `reply: false` and waits with `wait_for_agent` in
  the same turn. A host built around `reply: true` handoffs keeps its own
  `agents/development/operations.md` as a declared replacement.
- An addendum adds instructions. A role change sets recipients, delegates and
  extensions. A role's trigger, input, schedules or anything else in its
  `agent.ts` still takes a declared replacement.
- A changed role is composed as `agents/ROLE/agent.ts` beside the kit's own
  definition, `agents/ROLE/agent.kit.ts`. Its fingerprint covers the kit's file
  and the change, so either one changing calls for an idle definition update.
- The kit's Jett messages only `development` and delegates to the five workers.
  Its guide points at the company's other workflows; list them under
  `roles.jett.messages`.
- Adopting the kit in a repository that already had these roles renames the
  read/shell inspection extension to `kit.repo-inspection`. A stored
  conversation keeps the old name until its idle definition update, and runs
  without those tools until then. Select the release while those roles are idle.
- The security-remediation mode in
  [Development's protocol](agents/development/operations.md) expects a security
  role and finalized report that a company supplies.
- `status` compares digests. It names the files that changed, not what changed
  in them.

## Checks

`npm run build --workspace @dispatch/kit` runs
[scripts/check.mjs](scripts/check.mjs), which fails when a kit file contains a
home path, an email address, a host outside the reserved example domains, an IP
address, an account or workspace identifier, or a credential.
`npm run typecheck --workspace @dispatch/kit` checks the definitions against
Runner. `nix flake check` runs the content check and builds the template.

Kit text is public. Follow the
[public information boundary](../../OSS.md#public-information-boundary) and
read a change in full; the check matches shapes, not names.
