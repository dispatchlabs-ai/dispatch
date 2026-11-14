# Dispatch MCP

Let an MCP client talk to agents in an existing Dispatch host. Discover agents,
open conversations, send work, inspect progress and results, retrieve artifacts
and stop work. Web, the terminal and MCP use the same `AgentClient` contract and
native conversation history. This optional package does not start an agent host.

Starting from an empty directory? [Build your own agents](../runner/docs/create-agents.md)
provides a complete host configuration, two agents and an automatic-reply example.
To connect another server's tools **into** an agent, use the separate
[MCP tools guide](../runner/docs/mcp.md).

## First conversation

Use Node 24.22.1 or newer and an existing Dispatch application. Install the
matching MCP archive; it resolves its Runner dependency from the same release.

```sh
npm install https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.18.0/dispatch-mcp-0.18.0.tgz
npx dispatch serve --config host.json
```

Configure your MCP client to launch `node` with these arguments, using your
application directory as its working directory:

```json
{
  "command": "node",
  "args": ["node_modules/@dispatch/mcp/dist/cli.js", "--config", "host.json"]
}
```

Use absolute paths if your client cannot set a working directory. The executable
`dispatch-mcp --config host.json` is equivalent. Protocol messages use stdout;
diagnostics use stderr. Tool discovery works before the host starts listening.
The first tool call connects to the host and binds its stable identity.

**Use it with your AI agent.** After configuring the connection, ask:

> Follow the [Dispatch MCP guide](https://github.com/dispatchlabs-ai/dispatch/blob/main/packages/mcp/README.md).
> Discover my agents, create a new conversation with one of them, send “Hello
> from MCP”, and retrieve its result. Keep the conversation and submission IDs
> so I can continue it in Dispatch Web or the terminal.

Manual tool sequence (replace `researcher` with an ID from `list_agents`):

1. `list_agents {}` returns the configured catalog.
2. `create_conversation {"agent":"researcher","key":"mcp-intro","title":"MCP intro"}` returns a conversation.
3. `send_message {"conversationId":"<returned ID>","requestId":"intro-1","message":"Hello from MCP"}` returns a submission ID.
4. `get_result {"conversationId":"<returned ID>","submissionId":1,"wait":true}` returns that submission's receipt and current conversation snapshot. Use the actual returned submission ID.

Select the same conversation in Web's **Runs** tab or the terminal's `/chats`
picker to continue it. Web search covers both Chats and Runs. The host's
configured model and tools determine the answer and effects.

## Tools and continuation

| Tool | Behavior |
| --- | --- |
| `list_agents` | Read agent IDs, descriptions and authored models. |
| `list_conversations` | List retained conversations, optionally filtered by agent. |
| `find_conversation` | Look up an agent and stable key without creating work. |
| `create_conversation` | Create or return the conversation for an agent/key; no turn starts. |
| `send_message` | Admit input or steer active work; return a durable submission ID. Optional files carry name, MIME type and base64 bytes. |
| `get_conversation` | Read the full native snapshot, including history, thinking summaries when supplied, tool activity, live output, artifacts and errors. |
| `get_result` | Inspect a submission's receipt and the current snapshot; `wait:true` waits for settlement. |
| `get_artifact` | Retrieve a snapshot artifact ID as metadata and an embedded MCP resource containing base64 bytes. |
| `stop_conversation` | Explicitly stop work owned by the conversation; preserve history. |

Save conversation keys, conversation IDs, request IDs and submission IDs. Resume
by finding or reading a retained conversation, then sending new input. Reading
does not execute work. Retry an uncertain send with the **same request ID and
identical payload**. A new ID submits new work. An existing ID reattaches its
original admission; it must not be reused for different input. A rejected retry
does not disprove an earlier admission.

Results preserve native receipts rather than guessing completion from assistant
text. A snapshot is the current whole conversation, so use its native submission
turns to attribute an answer when multiple submissions share a conversation.
The tool result includes JSON text and structured content. Host failures return
`isError:true`, a diagnostic and a native service status when available. MCP
schema errors remain protocol errors. There is no second transcript database.

Closing MCP or cancelling a tool call stops observation, not admitted agent work.
Only `stop_conversation` requests Stop. Independent agents and completed external
effects are unaffected. Dispatch imposes no wait deadline; a client's own timeout
may end a wait. Call `get_result` again with the same IDs instead of resubmitting.
After a host restart, the connector retains the original host identity and never
automatically resends a mutation. A different installation requires a new connection.

## Agents calling agents

An agent can use this server through Runner's normal
[MCP connection configuration](../runner/docs/mcp.md). Add a named `agents`
connection to `host.json` using the command above, then select `mcp: [agents]`
in its definition. It can ask another agent by creating a conversation and
following the same send/result sequence. Discovery is independent of host startup,
so the MCP client and recipient can share one host. The recipient uses its own
configured tools; the caller does not receive those tools directly.
Runner leaves tool calls without a deadline unless that MCP connection explicitly
sets `timeout`. Long-running `get_result` calls therefore keep waiting, while
cancellation and `stop_conversation` remain available.

## Native messaging and automatic replies

For an assignment whose answer should arrive later, use native messaging through
MCP. The sender's `agent.ts` declares `messages: ["researcher"]` in
`defineAgent(...)`, and its Markdown frontmatter selects `mcp: [agents]`.
Both agents must be in the same Dispatch host. The recipient keeps its own tools
and instructions.

| Tool | Behavior |
| --- | --- |
| `agent_instances` | Discover the sender's identity, permitted agent types and addressable conversations; no transcript access. |
| `message_agent` | Send an assignment or correction; omit `instance` to create a recipient, or reuse a returned `to`. Returns `messageId`, `from`, `to`, `taskId` and `requestId`. |
| `message_status` | Inspect one of the sender's retained native message tasks. |
| `wait_for_agent` | Observe the message's related work, including native children and recorded peer handoffs; cancellation leaves recipient work running. |

Set `reply: true` on `message_agent` to have the answer delivered automatically
as a new input to the sender. The sender can continue other work or finish its
turn; the reply wakes it afterward. It should recognize the reply as an answer
to its earlier assignment and continue the original request without sending the
same question again. No result polling or open MCP wait is required. With
`reply: false`, use `wait_for_agent` when the caller wants to wait explicitly.
An idle result describes execution state, not whether the business goal succeeded.

For example, an operator with an existing sender conversation can call:

```json
{"from":"author:10","agent":"researcher","text":"Research the requested topic and cite your sources.","reply":true,"requestId":"research-1"}
```

Use the actual sender ID from your host. Ordinary external MCP clients supply
`from` and a stable `requestId`. Runner supplies them for an agent's own call:
the tools advertise `ai.dispatch/caller` metadata, and Runner injects a hidden
`caller` argument containing its conversation, state-root identity and native
tool-task request ID. The server rejects a different host or a conflicting
explicit sender. Private child conversations cannot impersonate independent
senders. This context is a trusted host binding, not another credential; an
authorized operator can still explicitly select a sender under its host-wide
authority. Custom embedded hosts without a state-root identity use the explicit
operator arguments.

Reuse the returned `requestId` and identical payload after an uncertain send.
`followUp` is the default delivery mode; `steer` forwards a correction to active
work. Native tasks retain delivery and reply identities across compatible host
restarts. Stopping the sender's background tracking does not stop an already
admitted recipient. See the [native messaging contract](../runner/docs/instance-messages.md).

Use it with your AI agent, after enabling the connection and recipient:

> Ask the researcher through the agents MCP native messaging tools to research
> the topic I supply and cite sources. Request an automatic reply, then finish
> your current turn. When that reply arrives, use it to answer my original
> question. Keep the returned message identity and do not poll for the answer.

## Streamable HTTP and authority

For clients that connect over HTTP, supply a private file containing a bearer
token. The CLI reads it on every request, so rotating it revokes future requests
without restarting the connector.

```sh
dispatch-mcp --config host.json --port 4330 --token-file /secure/mcp-token
```

This binds `http://127.0.0.1:4330/mcp`. All HTTP requests require
`Authorization: Bearer <token>`, including discovery. Host and browser Origin
headers are validated. Loopback HTTP is supported for local clients. To expose
it through a TLS reverse proxy, use `--host ADDRESS --origin https://agents.example.com`.
The proxy must enforce HTTPS and forward the configured Host. Non-loopback
listeners require that public HTTPS origin; TLS is terminated by the installation.

The MCP token grants access to the supplied host client's entire catalog and
conversations, including other channels. It is installation-level authority,
not a per-agent or per-user grant. Agent tool selection is not an operating-system
sandbox. Stdio inherits the launching account's local access. For a network host,
`--config` can name the same authenticated client configuration used by CLI/Web;
the upstream host credential and the inbound MCP token are separate credentials.
Token rotation affects new requests, not already admitted work or waits.

The SDK supports current MCP and older clients through its compatibility layer.
This package exposes conversation tools; it does not provide WebMCP, an OAuth
authorization server, model administration, arbitrary filesystem reads or
server-initiated sampling. File access comes from explicit attachments and
retained artifacts or from the tools granted to the selected agent.

## Embedding

```ts
import { connectClient } from "@dispatch/runner/client";
import { createDispatchMcpServer, serveMcpHttp } from "@dispatch/mcp";

const client = await connectClient({ socket: "/private/run/host.sock" });
const server = createDispatchMcpServer(client); // Connect your chosen SDK transport.
const token = process.env.MCP_TOKEN;
if (!token) throw new Error("Supply the MCP bearer token.");
const http = await serveMcpHttp({ client, port: 4330, authorize: request =>
  request.headers.authorization === `Bearer ${token}` });
// Later: await http.close(); await server.close(); await client.close();
```

Supply application-owned authorization that fails closed when credentials are
absent. Both helpers also accept an async client factory for deferred connection.
The caller owns that client and the host lifecycle. See the
[interface contract](../../docs/interfaces.md) and [verification record](../../docs/qualification.md)
for authority, observed compatibility and release qualification.
