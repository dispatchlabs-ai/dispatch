# Dispatch

Define an AI agent in Markdown. Run one host for its tools and conversation history. Start a conversation in the terminal and pick it up in the browser.

## Quickstart

Use Node 24.22.1 or newer and npm. The demo echoes your messages locally so you can try both clients without a model account.

**1. Install Dispatch in a new directory.**

```sh
mkdir dispatch-demo && cd dispatch-demo
npm init -y --init-type=module
npm install \
  https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.16.1/dispatch-runner-0.16.1.tgz \
  https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.16.1/dispatch-web-0.16.1.tgz
```

**2. Write your agent and start its host.**

```sh
cat > agent.md <<'EOF_AGENT'
---
description: A helpful assistant
model: { provider: anthropic, id: claude-sonnet-4-6 }
---
Answer clearly. Ask for details when you need them.
EOF_AGENT

npx dispatch serve --demo
```

**3. Talk to the same agent from two clients.** Leave the host running. Open each client in its own terminal from `dispatch-demo`.

| Client | Command | Try it |
| --- | --- | --- |
| Terminal | `npx dispatch chat` | Send `Hello from the CLI`. The reply begins with `Demo reply:`. |
| Browser | `npx dispatch-web` | Open the printed URL and select the CLI conversation in the sidebar. Send a follow-up. |

Run `npx dispatch chat --history` to see the conversation from both clients. Stop and restart the host with the same command to reopen that conversation. The host stores it in `.state/`. If the default web port is busy, run `npx dispatch-web --port 4329`.

## Run your own agents

In your own project, select a model in `agent.md`, set its provider credential, and run `npx dispatch serve`. For several agents, give each one a directory such as `agents/researcher/agent.md`. Its directory name is its ID. [Model setup and examples](docs/quickstart.md)

A shared `host.json` can supply a model gateway and named MCP connections. For example, add `mcp: [wiki]` to an agent's frontmatter to give it the wiki tools configured on the host. CLI and Web both connect to that host. You can give the commands short names in your application's `package.json`. [MCP configuration](packages/runner/docs/mcp.md) · [Host and client settings](packages/runner/docs/service.md)

```json
{
  "scripts": {
    "start": "dispatch serve --config host.json",
    "chat": "dispatch chat --config host.json --agent researcher",
    "web": "dispatch-web --config host.json"
  }
}
```

Run `npm start`, then `npm run chat` or `npm run web` in another terminal. To upgrade Dispatch, install matching release archives, commit the updated npm manifest and lockfile, and restart your processes. Your Markdown definitions belong to your application. [Releases](https://github.com/dispatchlabs-ai/dispatch/releases) · [Upgrade guide](packages/runner/docs/upgrade.md)

Dispatch 0.16.0 includes a [Pi terminal UI](packages/runner/README.md#interactive-terminal-ui)
for `npm run chat`, with streaming Markdown, multiline input and saved conversations.

## Packages and integrations

| Build or connect | Packages |
| --- | --- |
| Run agents and build clients | [Runner](packages/runner/README.md) · [Web](packages/web/README.md) · [Backend](packages/backend/README.md) |
| Add a channel | [MCP](packages/mcp/README.md) · [Slack](packages/slack/README.md) · [Google Chat](packages/google-chat/README.md) · [Email](packages/email/README.md) |
| Distribute execution or storage | [Remote](packages/remote/README.md) · [Workers](packages/workers/README.md) · [Fleet](packages/fleet/README.md) · [Postgres](packages/postgres/README.md) |
| Inspect history or evaluate agents | [Observer](packages/observer/README.md) · [Eval](packages/eval/README.md) |

Dispatch uses [Pi Durable](https://github.com/earendil-works/pi) for execution, recovery and stored conversations. Web and other clients share the host's conversation operations. Local Web binds to loopback. Hosted Web requires HTTPS and application-owned authorization. [Client contract](docs/interfaces.md) · [HTTP API](packages/web/openapi.yaml) · [Security](SECURITY.md) · [Verification](docs/qualification.md)

**Use it with your AI agent.** Ask an agent with shell access to run the walkthrough.

> Follow the [Dispatch quickstart](https://github.com/dispatchlabs-ai/dispatch/blob/main/docs/quickstart.md) in a fresh directory. Start the demo, send a message and verify the same conversation survives a host restart. Stop the host when finished.

Dispatch is pre-1.0 software created by Chris Reynolds, cofounder of Dispatch Labs AI, and distributed under the MIT license. [License](LICENSE) · [Contributing](CONTRIBUTING.md) · [Open-source standards](OSS.md) · [Package distribution](scripts/README.md)
