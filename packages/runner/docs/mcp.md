# MCP tools

This guide connects **tools into an agent**. To expose Dispatch agents as MCP
tools for another client or agent, use the optional [MCP connector](../../mcp/README.md).

Connect an agent to an existing MCP server with its Markdown definition and host
settings. Dispatch uses `@earendil-works/pi-mcp` for the connection and Pi Durable
for tool execution, stored results, cancellation and recovery. Pi coding agent is
not a runtime dependency.

## Configure and use a server

Supply a reachable, authorized MCP server and the credentials it requires. Add
its connection name to `agent.md`:

```markdown
---
description: Research assistant
model: { provider: anthropic, id: claude-sonnet-4-6 }
mcp: [wiki]
---
Research questions using the wiki. Read supporting sources and cite their links.
```

Put the matching connection in a `host.json` alongside the definition. This example uses an
HTTP server and a token supplied through the host's environment:

```json
{
  "modelProviders": [{
    "module": "@dispatch/runner/environment-provider",
    "export": "environmentProvider",
    "args": ["anthropic"]
  }],
  "mcpServers": {
    "wiki": {
      "url": "https://wiki.example.com/mcp",
      "headers": { "Authorization": "Bearer ${WIKI_TOKEN}" }
    }
  }
}
```

Set the server URL. Set `ANTHROPIC_API_KEY` and `WIKI_TOKEN`
in the host environment, then run:

```sh
npx dispatch serve --config host.json
```

In another terminal, run `npx dispatch chat --config host.json` and ask a
question covered by that wiki. The agent receives the server's discovered tool
descriptions and schemas; inspect its returned sources and tool results. No
`agent.ts` or server-specific adapter is required.

Use it with your AI agent:

> Follow Dispatch's [MCP guide](https://github.com/dispatchlabs-ai/dispatch/blob/main/packages/runner/docs/mcp.md)
> to connect my agent to my existing MCP server. Keep credentials in host-owned
> settings, retain my model connection, and verify a real read through the agent.

## Connection settings

`mcpServers` is a map of names to Pi MCP server settings. An agent's `mcp` list
selects its connections; merely configuring a server does not grant its tools
to every agent. Named delegates use their own selections. Native clones inherit
their parent's configured tools.

For a local stdio server, replace the HTTP entry with:

```json
{
  "command": "node",
  "args": ["/srv/example/wiki/server.mjs"],
  "env": { "WIKI_TOKEN": "${WIKI_TOKEN}" },
  "cwd": "/srv/example/wiki"
}
```

The command is an executable with separate arguments, not a shell command.
Relative `cwd` resolves from the host's working directory. Environment references
such as `${WIKI_TOKEN}` are expanded in stdio command/arguments/environment/`cwd` and
HTTP headers; unset variables fail startup. A leading `~/` in stdio paths names
the host account's home directory. Keep actual credentials and local settings
out of source control. Stdio servers are trusted programs: they inherit the host
process environment, with configured `env` entries adding or overriding values.

Both transports accept these settings:

| Setting | Meaning |
| --- | --- |
| `tools` | Optional list of exact server tool names. Omit it to expose all discovered tools from that connection; an empty list exposes none. |
| `enabled` | `false` prevents use. An agent requesting a disabled server fails startup. |
| `timeout` | Optional positive request timeout in seconds. Omit it for tool calls without a deadline; connection initialization and discovery retain Pi's 30-second default. |

Tool names exposed to the model use Pi's `mcp__<server>__<tool>` naming helper.
Configuration `tools` entries use the original names advertised by the server.
Invalid configurations, unknown requested servers and tools missing from an
explicit selection fail startup with an error.

Streamable HTTP supports unauthenticated servers and configured headers. This
integration does not implement interactive OAuth sign-in or an OAuth credential
store; selecting a server with `oauth` settings fails at startup. For a server requiring another
authentication mechanism, configure an authenticated stdio helper or authorized
HTTP headers. MCP resources, prompts and server-initiated sampling are not exposed
by this initial tools integration.

## Execution and lifecycle

The host connects selected servers and discovers tools before starting recovery.
Tool calls wait until completion, cancellation or a connection error unless the
server configuration explicitly sets `timeout`. This allows research and
agent-to-agent work to outlast 30 seconds without repeated polling or resubmission.
The caller's cancellation signal still interrupts its wait; it does not imply
that a remote agent's admitted work has stopped.

The discovered tool list is a startup snapshot: restart the host after changing
server settings or its available tools. Closing the host closes its MCP clients
and subprocesses after suspending Durable work. CLI, web and messaging clients
use the same tools through the host. Connection credentials remain with the host.

Server schemas remain authoritative. Pi handles model-facing constrained
sampling while Durable validates tool arguments. Tool errors, structured results
and original MCP content are retained; this integration adds no text truncation.
Model-visible text and image conversion uses Pi MCP's content helper. Other
content blocks remain in the stored tool details.

Cancellation passes to the MCP call. Generic remote tools retain Durable's
default unsafe replay policy: an interrupted call is not automatically repeated.
A later call can reconnect after a disconnected or expired session; the failed
call itself is not retried because its external outcome may be uncertain.

## Application code

`run({ root, stateRoot, models, mcpServers })` and `startService(config)` use the
same integration. `run` owns its connections and closes them with the host.
For a custom `run({ open })` composition, forward the callback's `prepareAgent`
to `ChatService.open` so each definition receives its selected tools.

`connectMcpServers(servers, { cwd, names })`, exported from `@dispatch/runner`,
provides a lower-level composition API. It returns `extensions`, a map of server
names to native Durable extensions, and an asynchronous `close()`. The caller
installs only the intended extensions and owns their connection lifetime. It
does not create conversations or another store owner.
