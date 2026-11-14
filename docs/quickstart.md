# Your first durable conversation

Install Runner, write one `agent.md`, start its host and talk to it. This
walkthrough uses synthetic replies so it needs no model account. It checks
storage and client interaction, not model quality. For real models, coding tools
and two agents communicating through MCP, follow [Build your own agents](../packages/runner/docs/create-agents.md).

## Install

Use Node **24.22.1 or newer** and npm on macOS or Linux. Nix is
optional. Choose a new directory:

```sh
mkdir dispatch-demo
cd dispatch-demo
npm init -y --init-type=module
npm install https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.18.0/dispatch-runner-0.18.0.tgz
```

Initialize `package.json` in this directory before installing. Otherwise npm can
[select a parent project](https://docs.npmjs.com/cli/v11/configuring-npm/folders/#more-information)
and change its dependencies. The archive is the installed library, not a source
checkout. npm records it in your package and lockfile; no scaffold, build step or
runtime service is installed.

## Define your agent

Create `agent.md` in this directory:

```markdown
---
description: A helpful assistant
model: { provider: openai, id: gpt-6.1-sol }
---
Answer clearly. Ask when you need more information.
```

This is the entire definition. No TypeScript or JSON configuration is required.
The root definition's ID is `agent`. Add `.state/`, `.demo/` and `node_modules/`
to your `.gitignore` before committing the application.

## Start and connect

Start a synthetic host, using separate demo state:

```sh
npx dispatch serve --demo --state .demo
```

Keep it running. In a second terminal, enter the same application directory:

```sh
npx dispatch chat --state .demo
```

Send `Hello from the quickstart`. The streamed response begins **Demo reply:**
and repeats your message. `/history` shows the retained messages; `/quit`
disconnects the client. A client disconnect leaves admitted work running.

The Pi terminal UI shows retained history immediately. Use Alt+Enter for a
newline, Ctrl+O for tool details, and `/chats` to find saved conversations.
[Commands and shortcuts](../packages/runner/README.md#interactive-terminal-ui).

Stop the **host** with Ctrl-C, then start it with the same command. Reconnect with
`npx dispatch chat --state .demo --history`: the same conversation must remain,
without another submission. Reconnect interactively and send a follow-up.
During a longer reply, `/stop` cancels the selected turn explicitly.

Report the installed Runner version (`npm ls @dispatch/runner`), Node version,
OS/architecture, observed reply/restart results and any intervention needed.
A successful install alone does not verify conversation behavior.

## Use a real model

Stop the demo host and any demo Web process. Set the API key for the provider
selected in `agent.md` in the host's environment. For this example:

```sh
export OPENAI_API_KEY='replace-with-your-api-key'
```

Supply a real key with access to the selected model. The host uses your provider
account for model requests. Keep credentials out of source files and Git; a
`.env` file is not automatically loaded.

For ChatGPT subscription access, use the new `dispatch login openai` path in
[Sign in and choose a model](../packages/runner/docs/sign-in.md). It is available
in the source preview, awaiting release; the 0.18.0 archive above uses API keys.

Start with ordinary state:

```sh
npx dispatch serve
```

Connect with `npx dispatch chat`. The live host uses `.state/`; your earlier
synthetic history remains in `.demo/`. Model providers and tools are explicit
choices. The initial definition grants no tools. Other clients can connect to
the same [host/client contract](../packages/runner/docs/service.md).

## Failure and recovery

- **Unsupported Node:** install Node 24.22.1 or newer using your normal
  Node installation method. No Nix installation is required.
- **Missing or invalid definition:** the launcher identifies the Markdown problem
  before opening an execution owner.
- **Missing credentials:** the live launcher reports the unconfigured provider.
  Supply that provider's API key, or use `--demo` with separate state.
- **No host listening:** start the host explicitly; clients never start one.
- **Host already running:** reconnect to it or stop the process you started before
  restarting. The launcher never takes over another writer.
- **Changed definition or execution mode:** preserve the current store and follow
  the explicit [definition update guidance](../packages/runner/docs/create-agents.md#edit-or-add-an-agent).
  Demo and live execution must not share the same state directory.

Stop only the host you started when finished. Keep its state directory to reopen
history. No machine service, profile or deployed installation was changed.

## Continue

Use [Build your own agents](../packages/runner/docs/create-agents.md) for a
complete `host.json`, two definitions, coding tools, automatic MCP replies and
`npm start` / `npm run chat` / `npm run web`. Use
[Runner's library API](../packages/runner/README.md) for custom application code.
Upgrade by installing matching newer archives and restarting the host and
clients; definitions remain application-owned.

The [browser walkthrough](web-quickstart.md) installs the prebuilt Web package
and connects it to this same host, including the `.demo/` state used above.
