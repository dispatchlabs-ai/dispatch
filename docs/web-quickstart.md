# Use your agents in the browser

Web is an optional, prebuilt npm package for an existing Dispatch application.
It connects to the same host and conversations as the terminal. You do not need
to clone or build Dispatch. Use Node **24.22.1 or newer** and npm on macOS or Linux.

If you have no application yet, start with the
[credential-free demo](quickstart.md) or [two-agent setup](../packages/runner/docs/create-agents.md).

## Install Web

In your application's directory, beside its `package.json`:

```sh
npm install https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.19.0/dispatch-web-0.19.0.tgz
```

Use the release matching your installed Runner. The two-agent setup already
installs Web and creates its npm command, so it can skip this installation step.

## Connect to your host

Choose the row matching how you started the host. Run the host first and leave
it running; launch Web in another terminal in the same application directory.

| Your host | Browser command |
| --- | --- |
| `npx dispatch serve` | `npx dispatch-web` |
| `npx dispatch serve --config host.json` | `npx dispatch-web --config host.json` |
| `npm start` from the two-agent setup | `npm run web` |
| `npx dispatch serve --demo --state .demo` | Create `demo.json` below, then `npx dispatch-web --config demo.json`. |

For the demo, create this client connection file in the application directory:

```sh
cat > demo.json <<'EOF_CONFIG'
{ "stateRoot": ".demo" }
EOF_CONFIG
npx dispatch-web --config demo.json
```

The file points Web at the same state-derived socket as
`npx dispatch chat --state .demo`. It does not start a host or open its database.
Web has no `--state` option; use the configuration file when selecting another
state directory. Stop demo Web before starting Web for your live host.

For an application with a complete `host.json`, you can save the command:

```sh
npm pkg set 'scripts.web=dispatch-web --config host.json'
npm run web
```

Open the printed URL, normally **http://127.0.0.1:4319**. If that port is busy,
add `--port 4329` to `npx dispatch-web`, or use
`npm run web -- --port 4329`. Keep any existing `--config` argument.

## Verify a shared conversation

1. Send a message through the terminal. For the demo, use
   `npx dispatch chat --state .demo` and send `Hello from the quickstart`.
2. In Web, open that conversation from the sidebar. Confirm the same message
   and answer. Demo answers begin **Demo reply:**; real answers use the authored
   model and tools.
3. Send a follow-up in Web and confirm that it also appears in the terminal.
   To start a separate chat, choose New conversation and select an agent.
4. When a real agent uses tools, expand their inputs and results. Thinking
   appears only when the model returns a summary; the echo demo produces neither
   real tool calls nor reasoning summaries.
5. Reload the browser and reopen the conversation. No message should be resent.
6. After work finishes, stop this host with Ctrl-C and restart it with the same
   host command. Reload Web and reconnect the terminal. Confirm earlier messages
   remain, then send a follow-up.

Use Stop to cancel the selected conversation's work. Closing Web or a browser
tab disconnects a client; it does not stop admitted work. Independently running
recipient agents have their own lifecycle. Chats created through MCP or other
sources may appear under **Runs**; sidebar search covers both Chats and Runs.

## Troubleshooting and hosting

- **Cannot connect / `host.sock`:** start the host first and wait for `Host ready`.
  Use the same application directory and configuration for host and clients.
- **Different or empty history:** check that both clients address the same host
  and state directory. Demo `.demo/` and live `.state/` are deliberately separate.
- **Uncertain send:** preserve the message's original identity and use the UI's
  explicit retry. Reconnecting does not automatically resend it.
- **Host already running:** reconnect to it or stop only your own process before
  restarting. Do not delete state to resolve an ownership error.

Local Web listens on loopback. Sharing it over a network requires an installation
with HTTPS and authorization; see [Web hosting](../packages/web/README.md) and
the [interface contract](interfaces.md#authority). The ordinary local walkthrough
installs no background service. Close the clients and stop the host you started
when finished; retain its state to reopen history.

Developing Dispatch itself is a separate path: use
[Contributing](../CONTRIBUTING.md) and the [source composition example](../examples/chat/README.md).
