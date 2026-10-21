# Dispatch Runner

`@dispatch/runner` runs directory-defined company agents with stock Pi Durable
1.3.0. It loads trusted definitions, owns each SQLite session, schedules native
tasks and exposes persistent shared conversations without a web server.

This is a source-alpha package. Its current 0.6.0 manifest follows the repository
version; it is not published to the npm registry. The
[agent scaffold](https://github.com/dispatchlabs-ai/agent-scaffold) provides a
complete terminal example with an integrity-pinned public runner archive.
For source builds, pack a reviewed revision as below. See the
[use cases](USE_CASES.md) and [changes](CHANGELOG.md).

The `runner-v0.6.0-alpha.3` GitHub prerelease is a runner-only source snapshot,
not a release or deployment of Dispatch Web. Its notes identify the exact source
commit and archive checksum. The archive retains the repository's 0.6.0 package
version; its tag and npm lockfile integrity distinguish the snapshot. Install it
without checking an archive into your own repository:

```sh
npm install https://github.com/dispatchlabs-ai/dispatch/releases/download/runner-v0.6.0-alpha.3/dispatch-runner-0.6.0.tgz
```

Keep the resulting lockfile. Snapshot updates use a new immutable tag and URL;
published assets are never replaced. This distribution does not change the
repository's lockstep version policy or publish private workspaces to npm.

## Try it without credentials

Node 22.19 or later is required. From the Dispatch repository's Nix shell:

```sh
npm ci
npm run build --workspace @dispatch/runner
npm pack --workspace @dispatch/runner --pack-destination /tmp
```

In a new directory, create a private ESM package and install the archive:

```sh
npm init -y
npm pkg set type=module
npm install /tmp/dispatch-runner-0.6.0.tgz
mkdir -p agents/helper
```

Create `agents/helper/agent.md`:

```markdown
---
description: A minimal helper.
model: { provider: faux, id: faux-1, thinking: off }
---
Answer the user's question clearly.
```

Create `agents/helper/agent.ts`:

```ts
import { defineAgent } from "@dispatch/runner";
export default defineAgent({ trigger: { mode: "manual" }, input: "Say hello." });
```

Create `factory.yaml` containing `agents: []`, then `main.mjs`:

```js
import { run, context } from "@dispatch/runner";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("Hello from a durable conversation.")]);
const models = createModels();
models.setProvider(faux.provider);
const app = await run({ models, demo: true });
try {
  const chat = await app.service.create("helper", "cli", "example", "Example");
  const { submissionId } = await app.service.submit(chat.id, "Hello", "hello-1");
  await (await app.service.host("helper").harness.submission(submissionId, context)).wait(context);
  console.log((await app.service.snapshot(chat.id)).messages);
} finally {
  await app.close();
}
```

Run `node main.mjs`. The supplied Pi Models catalog owns inference and credentials.
Use native provider setup or the separately installed inference gateway for live
models. The runner never requires a particular customer, provider, gateway or
web installation.

## Company application

An agent folder contains `agent.md` (instructions and model frontmatter) and
`agent.ts` (a `defineAgent` export). Definitions are trusted application code.
They can install native Pi extensions; no tools are granted by default.
The `model.thinking` value accepts Pi's `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max` levels. The chosen provider/model must support the selected level.
`factory.yaml` lists scheduled `agents`. Manual definitions remain available
for conversations. Interval schedules skip missed slots after an overdue turn;
continuous schedules wait their configured delay after each result.

`run({ root, stateRoot, models, adapters: [...] })` starts a service and returns
`service` and `close()`. Call `close()` on SIGTERM/SIGINT. The host application
owns process supervision. Optional adapters, including
[`@dispatch/slack`](../slack/README.md), start after hosts and any `beforeStart`
bindings are ready. No HTTP listener is started.

For existing domain workflows, use `open` to construct one host and return
`runner.ChatService.attach({ agents, hosts, initialize })`. The service takes
ownership of those hosts and closes them. `initialize(tx, chat, host)` configures
new discussions and mounts their domain documents in the creation transaction.
`chat.origin` is an application-supplied JSON reference. `service.create` uses a
stable external key and returns the same conversation on retry.

`openAgent` registers `extensions` in the root agent and `registryExtensions`
without granting their tools to the root. Domain initializers can select the
latter for conversations with a different activity. Workflows, conversations and
adapters share one native harness; never open a second writer to the same store.

## Terminal conversations

`chatInTerminal({ root, models, agent: "helper", stateRoot, session: "main" })`
starts the same headless service with a streaming terminal client. It selects one
agent, creates or resumes a named conversation and owns process signal cleanup.
`prompt` sends one turn and exits; `history` prints the selected history without
inference. `newChat` creates a fresh session and prints its key. Interactive
commands are `/new`, `/history` and `/quit`; Ctrl-C suspends unfinished work and
exits with status 130. A turn failure rejects the function for the caller to
report with a nonzero exit status. Model credentials remain the host's choice.

Terminal output renders C0/C1 control characters and DEL as visible `\xNN`
escapes, except for tabs and newlines. This also covers controls split across
streaming chunks, saved history, tool diagnostics and returned error messages.
The stored text is unchanged; other clients must apply their own display policy.

Use separate state roots for demo and live execution. The scaffold supplies
argument parsing, two direct providers and a clearly labeled scripted example;
the runner does not embed a provider credential or require an inference gateway.

## Local provider credentials

`UserCredentials.open({ root, providers })` supplies optional host-owned API-key
sources for Pi models: native OS storage, an existing vault helper, session-only
input and explicit environment compatibility. `credentialCommand` supplies setup,
metadata-only status, resolution checking and removal. No plaintext fallback or
automatic `.env` loading is provided. See [credential handling](docs/credentials.md)
for configuration, public methods, failure recovery and trust boundaries.

## Company and agent skills

Set `skills: true` in `defineAgent` to enable a read-only skill catalog. Existing
definitions are unchanged unless they opt in. The loader discovers
`skills/<name>/SKILL.md` and `agents/<agent>/skills/<name>/SKILL.md`. Each skill
requires YAML `name` (matching its folder), `description` and a nonempty body.
Company and local IDs are distinct: `company/<name>` and `agent/<name>`.

Only names and descriptions enter the initial instructions. `read_skill({ id,
path? })` returns `SKILL.md` by default, its content revision and the available
resource paths. Supporting UTF-8 text is read through the same tool. Resources
are startup snapshots; symlinks, special files and non-UTF-8 content are rejected.
The reader grants no shell execution or arbitrary filesystem access. Skills are
trusted author guidance and do not add permissions.

All skill files contribute to the owning definition fingerprint; changed skills
require the same explicit idle-state update as changed instructions. Saved tool
results retain the exact read content and revision. `loadSkills(root, agent)` and
`LoadedAgent.skillCatalog` expose this catalog to host applications. Skill
contents are loaded into process memory at startup and disclosed to the model
on demand, rather than hot-reloaded under a saved definition.

## Persistence and boundaries

`createRunner({ namespace })` derives native document/task identities. Keep the
namespace stable for existing stores. Definition fingerprints hash the original
Markdown, TypeScript, opted-in skill resources and delegated definition bytes. An idle
`updateDefinitions` migration updates ownerless conversations and their private
handoff children; applications with pinned domain configurations use the
`updateConversation(tx, id, setup)` callback to preserve or migrate their profiles before changing those definitions. Imported tool
code is not transitively hashed.

Closing suspends unfinished native work; reopening with compatible definitions
and adapters resumes it. State directories hold private transcripts and tools'
results. Back up the complete store; do not copy a live SQLite file in isolation.
On POSIX systems, startup sets the state root and each agent directory to `0700`,
and the database, existing SQLite sidecars and status files to `0600` before
opening storage. SQLite creates new sidecars inside the private agent directory.
Existing history is retained. State paths must be owned by the launching account;
symlinked state directories/files, hard-linked files and special files are
rejected. Startup stops if private modes cannot be established. Keep ancestor
directories under trusted control and review any extra filesystem ACLs separately.
Native Windows storage is unavailable until ACL enforcement is implemented;
use a Linux filesystem in WSL or run on Linux/macOS. These permissions do not
isolate trusted code running as the same account or protect earlier backups.

A directory lock enforces Pi SQLite's single-owner contract without limiting
independent native tasks. Status JSON is an observation, not durable authority.

Optional handoffs create a private child per parent conversation and publish
results/progress through a supplied reply sink. The inherited local coding
adapter uses private Git worktrees, protects `USE_CASES.md` and the definition
repository, and supports shell execution only through macOS `sandbox-exec`.
It is not a portable sandbox or a multi-tenant security boundary. Domain-specific
read-only tools can run on Linux without the coding adapter.
