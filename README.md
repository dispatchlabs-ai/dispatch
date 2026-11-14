# Dispatch

Define AI agents in your own project. Give each one instructions, a model and the tools it needs. Run one host, talk to it in the terminal or browser, and let agents ask each other for help.

Dispatch is an npm dependency of **your agents application**. You do not need to clone Dispatch, build it, install Nix or generate a scaffold to use it. Pi Durable owns execution, recovery and saved conversations.

## Quickstart

Use Node **24.22.1 or newer** and npm on macOS or Linux. With a ChatGPT subscription, sign in once on the computer that will run your agents. No OpenAI API key, Dispatch source checkout or build is required.

**1. Install Dispatch in your own application.**

```sh
mkdir my-agents && cd my-agents
npm init -y --init-type=module
npm install \
  https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.19.0/dispatch-runner-0.19.0.tgz \
  https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.19.0/dispatch-web-0.19.0.tgz
```

**2. Write your agent, sign in and start its host.**

```sh
cat > agent.md <<'EOF_AGENT'
---
description: A helpful assistant
model: { provider: openai, id: gpt-6.1-sol }
---
Answer clearly. Ask for details when you need them.
EOF_AGENT

npx dispatch login openai
npx dispatch serve
```

Choose the ChatGPT account whose plan you want to use and approve access in the browser. Login reports `Signed in to openai`; the host then reports `Host ready`. Keep the host running. Model access and usage limits depend on your account and plan. [Sign-in, account selection and logout](packages/runner/docs/sign-in.md)

**3. Talk to the same agent from two clients.** Open each client in its own terminal from `my-agents`.

| Client | Command | Try it |
| --- | --- | --- |
| Terminal | `npx dispatch chat` | Send `Hello`. Use `/new` for a new conversation. |
| Browser | `npx dispatch-web` | Open the printed URL, select the CLI conversation and send a follow-up. |

Run `npx dispatch chat --history` to read the conversation from both clients. Stop and restart the host with the same command, then reconnect: the messages remain in `.state/`. Keep `.state/`, `.demo/` and `node_modules/` out of Git. If the web port is busy, add `--port 4329` to the Web command. [Browser walkthrough](docs/web-quickstart.md)

**Other authentication options:** supply `OPENAI_API_KEY` in the host environment, or save a key with `npx dispatch login openai --api-key`. For Claude, use `claude-sonnet-5-5` and follow the [Claude subscription and API setup](packages/runner/docs/sign-in.md#claude-subscription-or-api-account); account eligibility differs from ChatGPT.

**Try it without an account:** follow the [credential-free demo](docs/quickstart.md). It echoes messages locally, uses separate `.demo/` state and makes no model or tool calls.

## Run your own agents

**[Build your own agents](packages/runner/docs/create-agents.md)** is the complete manual setup for a researcher and developer. It includes every file, model credentials, a shared `host.json`, coding tools, MCP messaging, verification and later edits:

```text
my-agents/
  package.json                 # Dispatch dependencies and npm commands
  host.json                    # Shared model and MCP connections
  agents/researcher/agent.md    # Instructions and model
  agents/developer/agent.md
  agents/developer/agent.ts     # Optional coding and messaging capabilities
```

After that setup, run these from your application directory in separate terminals:

| Command | What it does |
| --- | --- |
| `npm start` | Starts the host. Wait for `Host ready` and leave it running. |
| `npm run chat` | Opens the Pi terminal UI. `/agents` or Ctrl+G switches agents; `/chats` or Ctrl+P opens saved conversations. |
| `npm run web` | Opens access through a browser at the printed local URL. Select the same conversation to continue it. |

Enter sends; Alt+Enter inserts a newline. Ctrl+O expands tool inputs and results. Provider-supplied thinking summaries appear when the model returns them; a greeting may have none. `/stop` stops the current work. `/quit` disconnects the terminal without cancelling it. [Terminal commands](packages/runner/README.md#interactive-terminal-ui) · [Browser guide](docs/web-quickstart.md)

Editing an agent's instructions, model, tools or skills is separate from upgrading Dispatch. The setup guide explains `updateDefinitions` and restarting the host while preserving history. Package upgrades replace matching release archives and the npm lockfile; your definitions stay in your application. [Editing agents](packages/runner/docs/create-agents.md#edit-or-add-an-agent) · [Upgrade guide](packages/runner/docs/upgrade.md)

## What you can give your agents

| Capability | How it works |
| --- | --- |
| Coding | Opt into Pi Durable's `CodingTools` in `agent.ts` for `read`, `write`, `edit` and `bash`. The starter grants these to Developer. [Setup](packages/runner/docs/create-agents.md#give-developer-coding-and-messaging-tools) |
| Knowledge and external tools | Connect an existing MCP server on the host, then select it with `mcp: [name]` in each agent. Connections can differ between agents. [MCP tools](packages/runner/docs/mcp.md) |
| Agent-to-agent messaging | Send an assignment through MCP and request an automatic reply. The sender can finish its turn and resume when the answer arrives. Each recipient uses its own tools. [Two-agent example](packages/runner/docs/create-agents.md#verify-coding-and-an-automatic-reply) |
| Shared guidance and skills | Put common instructions in `AGENTS.md`; opt into reusable `skills/` with `skills: true`. [Instructions and skills](packages/runner/docs/create-agents.md#shared-instructions-and-skills) |
| Scheduled work | Opt into calendar or interval schedules for an agent. Scheduling is not required for chat. [Schedules](packages/runner/docs/schedules.md) |

## Ways to connect

MCP works in both directions: agents can **consume external MCP tools**, and the optional **Dispatch MCP server exposes your agents** to other clients and agents. WebMCP is not implemented.

| Connection | What it provides |
| --- | --- |
| [Terminal](packages/runner/README.md#interactive-terminal-ui) and [Web](packages/web/README.md) | Talk to the same agents, see thinking/tool activity and reopen saved conversations. |
| [MCP server](packages/mcp/README.md) | Discover agents, create or resume conversations, send work, inspect progress/results, retrieve artifacts and stop work. Includes native messaging and automatic replies. |
| [Slack](packages/slack/README.md) | DMs and configured channels with threaded replies and Stop. Linked threads can receive public conversation updates from Web and CLI. |
| [Google Chat](packages/google-chat/README.md) | A Chat app for configured agents, with threaded replies, steering and Stop. Requires Google Workspace/app and Pub/Sub setup. |
| [Email / Gmail](packages/email/README.md) | Labeled incoming mail starts work. Replies and new outgoing messages require sending to be explicitly enabled. |
| [HTTP/HTTPS API](packages/runner/docs/service.md#authenticated-network-connections) | Let another application create conversations, submit work, stream progress and retrieve results. Remote access requires HTTPS and authentication. |
| [JavaScript/TypeScript client](packages/runner/docs/service.md#shared-clients-and-company-compositions) | Use `AgentClient` in your own application, in process or through a socket/HTTPS connection. |

Install only the optional packages you use. Channel credentials and routing belong in your host configuration; a working terminal agent does not automatically enable Slack, Google Chat or email.

## Packages and integrations

| Build or connect | Packages |
| --- | --- |
| Run agents and build clients | [Runner](packages/runner/README.md) · [Web](packages/web/README.md) · [Backend](packages/backend/README.md) |
| Add a channel | [MCP](packages/mcp/README.md) · [Slack](packages/slack/README.md) · [Google Chat](packages/google-chat/README.md) · [Email](packages/email/README.md) |
| Distribute execution or storage | [Remote](packages/remote/README.md) · [Workers](packages/workers/README.md) · [Fleet](packages/fleet/README.md) · [Postgres](packages/postgres/README.md) |
| Inspect history or evaluate agents | [Observer](packages/observer/README.md) · [Eval](packages/eval/README.md) |

Dispatch uses [Pi Durable](https://github.com/earendil-works/pi) for execution, recovery and stored conversations. Local Web binds to loopback. Hosted Web requires HTTPS and application-owned authorization. [Client contract](docs/interfaces.md) · [Web HTTP API](packages/web/openapi.yaml) · [Security](SECURITY.md) · [Verification](docs/qualification.md)

**Use it with your AI agent.** Ask an agent with shell access to run the walkthrough.

> Follow the [Dispatch quickstart](https://github.com/dispatchlabs-ai/dispatch/blob/main/docs/quickstart.md) in a fresh directory. Start the demo, send a message and verify the same conversation survives a host restart. Stop the host when finished.

Dispatch is pre-1.0 software created by Chris Reynolds, cofounder of Dispatch Labs AI, and distributed under the MIT license. [License](LICENSE) · [Contributing](CONTRIBUTING.md) · [Open-source standards](OSS.md) · [Package distribution](scripts/README.md)
