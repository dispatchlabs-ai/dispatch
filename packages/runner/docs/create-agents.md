# Build your own agents

Create an application with two agents: **researcher**, which answers questions
using the context you supply, and **developer**, which can read/write files, run
commands and ask researcher for help through MCP. Both appear in the terminal and
browser, with the same saved conversations.

Use Node **24.22.1 or newer**, npm, and a model API key. The default example uses
Anthropic's `claude-sonnet-4-6`; the provider table below also gives an OpenAI
configuration. Model requests use your provider account. The
[credential-free demo](../../../docs/quickstart.md) lets you try conversation
storage and both clients first. These instructions use a POSIX shell on macOS or
Linux; no Dispatch source checkout, Nix or application build is needed.

## Install in your application

Choose a new directory, separate from the demo:

```sh
mkdir my-agents
cd my-agents
npm init -y --init-type=module
npm install \
  https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.18.0/dispatch-runner-0.18.0.tgz \
  https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.18.0/dispatch-web-0.18.0.tgz \
  https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.18.0/dispatch-mcp-0.18.0.tgz \
  @earendil-works/pi-durable@1.5.2
mkdir -p agents/researcher agents/developer
cat > .gitignore <<'EOF_IGNORE'
node_modules/
.state/
.demo/
.env
*.local.json
EOF_IGNORE
```

Initialize `package.json` before installing so npm cannot select a parent
project. The Dispatch packages are versioned GitHub archives, not npm-registry
packages. Pi Durable is a direct dependency here because `agent.ts` imports its
coding tools; use the same Pi version as Runner. Keep `package-lock.json`.

## Write the two agents

Create `agents/researcher/agent.md`:

```markdown
---
description: Research and design questions using the supplied context
model: { provider: anthropic, id: claude-sonnet-4-6, thinking: low }
---
Answer clearly and distinguish provided facts from suggestions. You initially
have no browsing or knowledge-base tools: ask for missing source material rather
than claiming to have searched it. When another agent asks for help, answer the
assignment directly so it can continue its work.
```

Create `agents/developer/agent.md`:

```markdown
---
description: Write and run code, with help from the researcher
model: { provider: anthropic, id: claude-sonnet-4-6, thinking: low }
mcp: [agents]
---
Implement the user's request in this application's working directory. Inspect
existing files before editing, and verify changes with the available tools.

For research or design help, use mcp__agents__agent_instances to discover the
researcher, then mcp__agents__message_agent with reply: true to send the assignment.
Use these MCP-prefixed tools instead of the unprefixed native messaging tools.
After sending an assignment with reply: true, finish your turn without
calling status or wait tools. The automatic reply will resume you; use it to
continue the original request rather than sending the same assignment again.
Report the result and what you actually verified.
```

The directory names `researcher` and `developer` are their IDs. Each agent chooses
its own model and connections. A single conversational agent needs only
`agent.md`; tools and other capabilities are explicit additions.

### Give Developer coding and messaging tools

Create `agents/developer/agent.ts`:

```ts
import { defineAgent } from "@dispatch/runner";
import { CodingTools } from "@earendil-works/pi-durable/tools";

export default defineAgent({
  extensions: [CodingTools],
  messages: ["researcher"],
});
```

`CodingTools` provides Pi Durable's stock `read`, `write`, `edit` and `bash`.
The host runs them with your account's authority and defaults their working
directory to `my-agents`. This is not a filesystem sandbox. Dispatch's separate
`coding: true` option adds repository selection and a private checkout; it is
not needed for these tools.

`messages` selects native messaging recipients. The MCP connection below also
exposes ordinary conversation operations with host-wide authority; this example
is a trusted local application, not an isolation boundary between agents.

## Configure the shared host

Create `host.json` in `my-agents`:

```json
{
  "updateDefinitions": "when-idle",
  "modelProviders": [{
    "module": "@dispatch/runner/environment-provider",
    "export": "environmentProvider",
    "args": ["anthropic"]
  }],
  "mcpServers": {
    "agents": {
      "command": "node",
      "args": ["node_modules/@dispatch/mcp/dist/cli.js", "--config", "host.json"]
    }
  }
}
```

The host discovers both agent directories. It owns model authentication, MCP
connections and `.state/`; all clients connect to it. `when-idle` lets a restarted
host apply edited definitions after existing work becomes idle. It does not
reload files while the host is running.

In the terminal that will run the host, set your actual API key:

```sh
export ANTHROPIC_API_KEY='replace-with-your-api-key'
```

Keep the key out of agent files, `host.json` and Git. You can supply it using your
secret manager instead. Creating a `.env` file alone does not load it into this
command's environment. Other client terminals do not need the model key.

For another provider, change `model.provider` and `model.id` in both Markdown
files, the corresponding `modelProviders` binding, and that provider's API-key
environment variable. For example:

| Provider | `model` in both Markdown files | Host binding `args` | Host environment |
| --- | --- | --- | --- |
| Anthropic (shown above) | `{ provider: anthropic, id: claude-sonnet-4-6, thinking: low }` | `["anthropic"]` | `ANTHROPIC_API_KEY` |
| OpenAI | `{ provider: openai, id: gpt-5.4, thinking: low }` | `["openai"]` | `OPENAI_API_KEY` |

For the OpenAI option, use `export OPENAI_API_KEY='replace-with-your-api-key'`
instead. Choose a model available to your account. Add a binding for each provider
used by your agents. An existing inference gateway can instead supply the shared
model connection;
see [host configuration](service.md). A gateway is optional.

## Add the npm commands

Run from `my-agents`:

```sh
npm pkg set 'scripts.start=dispatch serve --config host.json'
npm pkg set 'scripts.chat=dispatch chat --config host.json --agent developer'
npm pkg set 'scripts.web=dispatch-web --config host.json'
```

Your application now contains:

```text
my-agents/
  .gitignore
  package.json
  package-lock.json
  host.json
  agents/
    researcher/agent.md
    developer/agent.md
    developer/agent.ts
```

Run `npx dispatch catalog` to check the definitions. Expect IDs `developer` and
`researcher`; this checks loading, not model authentication or tool execution.

## Start the host and clients

In the terminal with your API key, run:

```sh
npm start
```

Wait for **Host ready** with both agent IDs. Leave this terminal open. In a
second terminal, change into `my-agents` and run:

```sh
npm run chat
```

Developer opens in the Pi terminal UI. Send a greeting to check a real model
response. `/agents` or Ctrl+G opens the agent picker; choose Researcher to talk to
it directly. `/chats` or Ctrl+P reopens a saved conversation, and `/new` starts
another. `/help` lists commands. Enter sends; Alt+Enter inserts a newline.

In a third terminal, in the same directory:

```sh
npm run web
```

Open the printed URL (normally `http://127.0.0.1:4319`). Select the terminal
conversation in the sidebar and send a follow-up. The terminal should show the
same new message and answer. New browser chats let you select either agent.
For a busy port, use `npm run web -- --port 4329`.

Tool headings show actual calls; Ctrl+O expands their inputs and results in the
terminal. Web has expandable tool activity. Thinking summaries appear when the
provider returns them. `thinking: low` requests reasoning; it does not guarantee
a visible summary on every reply. [Terminal reference](../README.md#interactive-terminal-ui)
· [Browser walkthrough](../../../docs/web-quickstart.md)

## Verify coding and an automatic reply

Choose Developer and send this in a new conversation:

> Use `mcp__agents__agent_instances` and `mcp__agents__message_agent` to ask
> researcher for two acceptance checks for a Node script that prints "Hello from
> Dispatch". Request an automatic reply with `reply: true`, then finish this turn
> without calling any status or wait tools. When its reply arrives, create
> `hello.mjs` in this application, read the file, edit the greeting to "Hello from
> my agents", and run it with bash.
> Report the observed output. Do not use the unprefixed native messaging tools
> for this check.

Look for these results:

1. Developer discovers the available recipient and calls
   `mcp__agents__message_agent`. It can finish its first turn before Researcher
   answers. The unprefixed `message_agent` also supports native messaging, but
   the prefixed tool verifies the MCP route used in this walkthrough.
2. Researcher's answer arrives as a new input to Developer, which continues
   without another human message. The recipient conversation is visible among
   saved runs; it keeps its own instructions and tools.
3. Developer's history contains successful `write`, `read`, `edit` and `bash`
   calls. The shell output is **Hello from my agents**. Inspect `hello.mjs` too.
4. Open this same conversation in Web and confirm its calls and final response.

MCP tool calls have no Dispatch-imposed deadline unless you configure a connection
`timeout`; an external client's own timeout can still end its wait. Automatic
replies need no open wait or polling loop. `/stop` cancels the selected
conversation's work; an independently admitted recipient keeps its own lifecycle.
[MCP continuation and authority](../../mcp/README.md#native-messaging-and-automatic-replies)

After the work finishes, use `/quit` to close the terminal client. Stop only this
host with Ctrl-C, restart it with `npm start`, then reopen `npm run chat` and Web.
Select the same conversation: its messages and results should remain. Reopening
history does not resend the assignment. Send a follow-up to verify continued use.

## Connect Researcher to a knowledge source

This is optional and requires an existing MCP server you are authorized to use.
The initial Researcher has no external knowledge connection. In `host.json`, add
a `wiki` entry **alongside** the existing `agents` entry under `mcpServers`:

```json
"wiki": {
  "url": "https://wiki.example.com/mcp",
  "headers": { "Authorization": "Bearer ${WIKI_TOKEN}" }
}
```

Replace the example URL, supply `WIKI_TOKEN` in the host environment, and add
`mcp: [wiki]` to Researcher's Markdown frontmatter. Update its instructions to
search the configured wiki, read supporting sources and cite them. Follow the
restart procedure below. The [MCP tools guide](mcp.md) includes complete HTTP and
stdio configuration examples and optional tool selection.

Developer can then ask Researcher for knowledge through MCP. Researcher uses its
own wiki connection; Developer does not receive those wiki tools directly.
The optional [Dispatch MCP server](../../mcp/README.md) can also connect an
external MCP client to this host. It is distinct from connecting a wiki's tools
into an agent. WebMCP is not implemented.

## Edit or add an agent

To edit an agent's instructions, model, tools or skills:

1. Finish existing work, or use `/stop` if you intend to cancel it. Stop this
   application's host with Ctrl-C.
2. Edit its `agent.md`, optional `agent.ts`, shared instructions or skill files.
3. Run `npm start` again. This guide's `updateDefinitions: "when-idle"` applies
   the new definition when saved work is idle, preserving conversation history.
   If unfinished work must recover first, the update waits for it to become idle.
4. Reconnect clients and verify the changed behavior in a new turn.

For another agent, add `agents/NAME/agent.md`, with a unique lowercase ID using
letters, digits and hyphens, beginning with a letter. Give it any optional
`agent.ts` capabilities and host connections it needs, then restart. Use `/agents`
or the Web agent selector to find it. A root `agent.md` has ID `agent`; it can
coexist with named agents but not with `agents/agent/agent.md`.

The npm chat command chooses Developer initially. Change its `--agent` value to
choose another initial agent, or use the picker. An optional `factory.yaml` can
select `defaultAgent` and enable [scheduled work](schedules.md); it is not needed
for this application.

## Shared instructions and skills

An application-root `AGENTS.md` supplies common guidance; an agent directory can
have its own `AGENTS.md` for more specific guidance. Your agent's Markdown still
holds its role instructions. See the [instruction authoring guide](instructions.md)
for choosing what belongs in shared rules, role instructions and skills.

To enable reusable skills for Developer, add `skills: true` to its existing
`defineAgent` options. Put shared skills at `skills/NAME/SKILL.md`, or that agent's
skills at `agents/developer/skills/NAME/SKILL.md`. For example:

```markdown
---
name: code-review
description: Review a code change and explain its verification
---
Read the changed code and its callers. Explain the behavior change and report
the checks actually performed. Identify unresolved issues clearly.
```

Save this as `skills/code-review/SKILL.md`, then restart with the edit procedure
above. The agent discovers it as `company/code-review` and reads it through
`read_skill`. Skills supply guidance, not additional execution authority.

## Keep and upgrade your application

Commit your definitions, nonsecret host settings, `.gitignore`, `package.json`
and `package-lock.json` to your own repository. Keep `.state/` separately backed
up: it holds conversations and durable work, not source code. Keep credentials
outside Git. Nothing here installs a background service; the host stops when its
process exits. Use your own supervisor when you want it to remain available.

To upgrade Dispatch, install matching published archives for the packages you
use, retain the updated lockfile, and restart your host and clients. Do not copy
new agent definitions over your own. See [upgrades](upgrade.md), the
[connection overview](../../../README.md#ways-to-connect) for channels, and
[verification scope](../../../docs/qualification.md) for observed platform limits.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Web/CLI cannot connect, or mentions `host.sock` | Start `npm start` first; wait for `Host ready`. Use the same application directory and `host.json` in each terminal. |
| Authentication or model error | Set the selected provider's key in the **host** environment and verify account/model access. Restart after changing the environment. |
| `host.json` not found | Create the complete file above and run the npm commands from `my-agents`. |
| `definition changed` | Set `updateDefinitions` in the host configuration and follow the edit/restart procedure; preserve saved state. |
| `demo/live mode changed` | Keep `.demo/` for synthetic work and `.state/` for real models. Do not switch execution mode on the same store. |
| No tools or thinking displayed | A greeting may invoke neither. Check `agent.ts`, the agent's `mcp` selection, host connections and actual tool results; summaries require provider-returned text. |
| Another process owns the store | Reconnect to that host, or stop the process you started before restarting. Do not start a second owner or delete its state. |
| Researcher cannot search the web/wiki | The starter has no search connection. Add the appropriate MCP tools and instructions, then restart. |

**Use it with your AI agent.** An assistant with shell/file access, a browser and
your authorized model credentials can follow this same manual guide:

> Follow the [Dispatch agent setup guide](https://github.com/dispatchlabs-ai/dispatch/blob/main/packages/runner/docs/create-agents.md)
> in a fresh directory. Create the researcher and developer, verify coding and an
> automatic MCP reply, open the same conversation in terminal and Web, and verify
> history after a host restart. Keep credentials out of files and stop the
> processes you started when finished. Report the actual results.
