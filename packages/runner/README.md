# Dispatch Runner

`@dispatch/runner` runs directory-defined company agents with stock Pi Durable
1.3.0. It loads trusted definitions, owns each SQLite session, schedules native
tasks and exposes persistent shared conversations without a web server.

This is a source-alpha package. Its current 0.6.0 manifest follows the repository
version; it is not published to the npm registry.
Build and install packed archives from a reviewed source revision. See the
[use cases](USE_CASES.md) and [changes](CHANGELOG.md).

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

## Persistence and boundaries

`createRunner({ namespace })` derives native document/task identities. Keep the
namespace stable for existing stores. Definition fingerprints hash the original
Markdown, TypeScript and delegated definition bytes. An idle
`updateDefinitions` migration updates ownerless conversations and their private
handoff children; applications with pinned domain configurations use the
`updateConversation(tx, id, setup)` callback to preserve or migrate their profiles before changing those definitions. Imported tool
code is not transitively hashed.

Closing suspends unfinished native work; reopening with compatible definitions
and adapters resumes it. State directories hold private transcripts and tools'
results. Back up the complete store; do not copy a live SQLite file in isolation.
A directory lock enforces Pi SQLite's single-owner contract without limiting
independent native tasks. Status JSON is an observation, not durable authority.

Optional handoffs create a private child per parent conversation and publish
results/progress through a supplied reply sink. The inherited local coding
adapter uses private Git worktrees, protects `USE_CASES.md` and the definition
repository, and supports shell execution only through macOS `sandbox-exec`.
It is not a portable sandbox or a multi-tenant security boundary. Domain-specific
read-only tools can run on Linux without the coding adapter.
