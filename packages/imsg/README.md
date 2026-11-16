# Dispatch Messages

Connect an agent to text conversations in the Mac Messages app. Texts from the same conversation share agent history. Each final answer goes back to its originating chat GUID, including group chats, using the service Messages associates with that chat.

Each Markdown table becomes a PNG in the original Messages conversation. Surrounding text and tappable links follow the answer’s order. Other clients can open the same conversation with its original Markdown.

## Use it with your AI agent

> Add the Messages channel to my Dispatch host using the [setup below](https://github.com/dispatchlabs-ai/dispatch/tree/main/packages/imsg#setup). Use my chosen agent and allowed family or team handles. Verify the original chat receives a reply.

## Setup

On the Mac, sign in to Messages and install [imsg](https://github.com/openclaw/imsg). The adapter uses protocol 1 with the v0.21.0 replay and chat lookup methods. Grant the process access to Messages history and permission to send with Messages. For carrier texts, configure forwarding on the iPhone and verify the Mac can send and receive in that conversation.

Install the matching `@dispatch/imsg`, `@dispatch/runner` and Pi Durable versions from the [Dispatch release](https://github.com/dispatchlabs-ai/dispatch/releases). Add this entry to `adapters` in the existing host configuration:

```json
{ "module": "@dispatch/imsg", "optionsFile": "imsg.local.json" }
```

In the private options file, choose an agent defined by the application and a stable name for this Messages database:

```json
{
  "connection": "team-mac",
  "agent": "assistant",
  "allowedHandles": ["+12025550101", "+12025550102"]
}
```

The default command is `imsg rpc`. For a remote Messages Mac, copy `node_modules/@dispatch/imsg/bin/dispatch-imsg-rpc` to that Mac and make it executable. It uses the system Perl to stage each PNG in a private temporary directory and runs the installed `imsg`. Add `"command": "ssh"` and `"args": ["-T", "-o", "BatchMode=yes", "messages-mac", "/path/to/dispatch-imsg-rpc /path/to/imsg"]`. Configure host-key verification and an unattended SSH identity. An RPC-only SSH key can use the same two absolute paths as its forced command.

Start the host as usual. After the first “Messages connection … ready” line, send a text from an allowed handle. Check for the reply in the same conversation. For a group, check that the other participant can see the reply there as well.

## Routing and recovery

Set `"allowedHandles": "users"` to require the host’s [shared roster](../runner/docs/service.md#shared-human-identities). This checks the sender and current group membership against the selected agent before admission and checks membership again at delivery.

With an `allowedHandles` list configured, the sender and all remote members of the current chat must be in the list. Use the exact phone or email handles Messages reports. With neither a roster nor a list, all participants are admitted. Incoming text is attributed to its sender. Outgoing echoes, reactions and attachment-only messages do not start a turn.

The first connection establishes a baseline at the current end of history. Subsequent connections replay from the saved database cursor. Use a new connection name if the Messages database is replaced or restored. Durable submissions and replies retain their incoming and outgoing identifiers. If the send result is lost, Dispatch checks fresh outgoing history in that chat. Ambiguous delivery leaves a failed task for inspection; review Messages before sending again.
