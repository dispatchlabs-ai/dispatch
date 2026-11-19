# Dispatch

Define AI agents in your own project. Give each one instructions, a model and the tools it needs. Run one host, talk to it in the terminal or browser, and let agents ask each other for help.

Dispatch is an npm dependency of **your agents application**. You do not need to clone Dispatch, build it, install Nix or generate a scaffold to use it. Pi Durable owns execution, recovery and saved conversations.

[How Dispatch works](docs/architecture.md) explains the application, shared host,
Pi Durable, agent messaging and optional execution environments.

## Quickstart

Use Node **24.22.1 or newer** and npm on macOS or Linux. With a ChatGPT subscription, sign in once on the computer that will run your agents. No OpenAI API key, Dispatch source checkout or build is required.

**1. Install Dispatch in your own application.**

```sh
mkdir my-agents && cd my-agents
npm init -y --init-type=module
npm install \
  https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.40.0/dispatch-runner-0.40.0.tgz \
  https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.40.0/dispatch-web-0.40.0.tgz
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

**On iPhone:** Build the native app in Xcode with your own Apple Account. Connect it to your agents repo’s authenticated HTTPS Dispatch Web address to pick up the same conversations. [Personal iPhone setup](apps/ios/README.md)

**Other authentication options:** supply `OPENAI_API_KEY` in the host environment, or save a key with `npx dispatch login openai --api-key`. For Claude, use `claude-sonnet-5-5` and follow the [Claude subscription and API setup](packages/runner/docs/sign-in.md#claude-subscription-or-api-account); account eligibility differs from ChatGPT.

**Try it without an account:** follow the [credential-free demo](docs/quickstart.md). It echoes messages locally, uses separate `.demo/` state and makes no model or tool calls.

## Preview an agent

Preview runs your existing agent with its usual instructions, model, skills,
MCP connections and environment. Tools declared in `agent.ts`, such as
`CodingTools`, are already available. **Tool actions are real.** File edits
change files in the configured working directory, and external services use
the host’s configured credentials.

From the quickstart application directory, start the preview host for `agent.md`
and leave it running.

```sh
npx dispatch preview --agent agent
```

Open a second terminal in the same directory to chat as the local user.

```sh
npx dispatch chat --preview agent
```

For `agents/developer/agent.md`, use `developer` in both commands. With a user
roster, choose a printed command such as `npx dispatch chat --preview developer --as riley`.
The agent sees Riley’s sender identity and current profile. Each person’s preview
history persists separately from their regular chats. [User rosters](packages/runner/docs/service.md#shared-human-identities)

With `@dispatch/web` installed, sign in at the printed URL (default port 4330)
and choose the same person to continue the conversation. Other Dispatch clients
can use that person’s printed connection file. Channel listeners and schedules
run on the regular host.

Use `--no-web` for a headless preview or `--port 4331` for another Web port.
To use sample data, supply replacement tools in an optional `preview.ts`.
[Preview settings and fixtures](packages/runner/README.md#preview-an-agent)

## Provider setup

Use `npx dispatch providers add` to choose a native Pi provider,
sign in, discover its models and verify a response before saving the connection.
`npx dispatch models use` assigns a model to an agent. Apple local can have the
host manage `fm serve`, including readiness, restart and cleanup.

See the [provider setup guide](packages/runner/docs/providers.md) for commands,
custom native providers and local-server ownership.

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
| Execution environments | Optionally build a Nix-defined desktop or attach an existing Cua Space. Keep the same npm application, host and clients. [Setup and prerequisites](packages/runner/docs/environments.md) |
| Agent-to-agent messaging | Send an assignment through MCP and request an automatic reply. The sender can finish its turn and resume when the answer arrives. Each recipient uses its own tools. [Two-agent example](packages/runner/docs/create-agents.md#verify-coding-and-an-automatic-reply) |
| Shared guidance and skills | Put common instructions in `AGENTS.md`; opt into reusable `skills/` with `skills: true`. [Instructions and skills](packages/runner/docs/create-agents.md#shared-instructions-and-skills) |
| Reviewed reminders | Declare a source, timing, eligibility and destination in the agent definition. Ask for a read-only check in live preview, or start reminders in a private chat. [Reviewed reminders](packages/runner/docs/reminders.md) |
| Scheduled work | Opt into calendar or interval schedules for an agent. Scheduling is not required for chat. [Schedules](packages/runner/docs/schedules.md) |

## Ways to connect

MCP works in both directions: agents can **consume external MCP tools**, and the optional **Dispatch MCP server exposes your agents** to other clients and agents. WebMCP is not implemented.

| Connection | What it provides |
| --- | --- |
| [Terminal](packages/runner/README.md#interactive-terminal-ui), [Web](packages/web/README.md) and [iPhone](apps/ios/README.md) | Talk to the same agents, see thinking/tool activity and reopen saved conversations. |
| [MCP server](packages/mcp/README.md) | Discover agents, create or resume conversations, send work, inspect progress/results, retrieve artifacts and stop work. Includes native messaging and automatic replies. |
| [Slack](packages/slack/README.md) | DMs and configured channels with threaded replies and Stop. Linked threads can receive public conversation updates from Web and CLI. |
| [Google Chat](packages/google-chat/README.md) | A Chat app for configured agents, with threaded replies, steering and Stop. Requires Google Workspace/app and Pub/Sub setup. |
| [Messages](packages/imsg/README.md) | Direct and group texts through an existing Mac Messages account, with incoming photos and screenshots for image-capable agents and replies in the original chat. |
| [Email / Gmail](packages/email/README.md) | Labeled incoming mail starts work. Replies and new outgoing messages require sending to be explicitly enabled. |
| [HTTP/HTTPS API](packages/runner/docs/service.md#authenticated-network-connections) | Let another application create conversations, submit work, stream progress and retrieve results. Remote access requires HTTPS and authentication. |
| [JavaScript/TypeScript client](packages/runner/docs/service.md#shared-clients-and-company-compositions) | Use `AgentClient` in your own application, in process or through a socket/HTTPS connection. |

Install only the optional packages you use. Channel credentials and routing belong in your host configuration; a working terminal agent does not automatically enable Slack, Google Chat, Messages or email.

## Packages and integrations

| Build or connect | Packages |
| --- | --- |
| Run agents and build clients | [Runner](packages/runner/README.md) · [Web](packages/web/README.md) · [Backend](packages/backend/README.md) |
| Add a channel | [MCP](packages/mcp/README.md) · [Slack](packages/slack/README.md) · [Google Chat](packages/google-chat/README.md) · [Messages](packages/imsg/README.md) · [Email](packages/email/README.md) |
| Distribute execution or storage | [Remote](packages/remote/README.md) · [Workers](packages/workers/README.md) · [Fleet](packages/fleet/README.md) · [Postgres](packages/postgres/README.md) |
| Inspect history or evaluate agents | [Watch](packages/runner/docs/watch.md) · [Eval](packages/eval/README.md) |

Dispatch uses [Pi Durable](https://github.com/earendil-works/pi) for execution, recovery and stored conversations. Local Web binds to loopback. Hosted Web requires HTTPS and application-owned authorization. [Client contract](docs/interfaces.md) · [Web HTTP API](packages/web/openapi.yaml) · [Security](SECURITY.md) · [Verification](docs/qualification.md)

**Use it with your AI agent.** Ask an agent with shell access to run the walkthrough.

> Follow the [Dispatch quickstart](https://github.com/dispatchlabs-ai/dispatch/blob/main/docs/quickstart.md) in a fresh directory. Start the demo, send a message and verify the same conversation survives a host restart. Stop the host when finished.

Dispatch is pre-1.0 software created by Chris Reynolds, cofounder of Dispatch Labs AI, and distributed under the MIT license. [License](LICENSE) · [Contributing](CONTRIBUTING.md) · [Open-source standards](OSS.md) · [Package distribution](scripts/README.md)
