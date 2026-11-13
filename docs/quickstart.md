# Your first durable conversation

Run a local synthetic agent, watch its reply, then reopen the same conversation
after restarting the service. This demonstrates storage and interaction without
a model account. It does not measure model quality or run real tools.

## Prerequisites and effects

- Git, Node 24.22.1 and public GitHub/npm downloads. If you use Nix, `nix develop`
  supplies the pinned toolchain; it is optional for application use.
- A browser, or an agent with documentation, shell, file and browser access.
- A fresh directory for synthetic state. No model account or database server.

The demo writes into its checkout and npm cache, uses a private Unix socket,
and exposes Web on loopback port 4319. It installs no system service.

## Download and build

Choose a parent directory in which `dispatch-demo` does not already exist:

```sh
git clone --depth 1 --branch main https://github.com/dispatchlabs-ai/dispatch.git dispatch-demo
cd dispatch-demo
git rev-parse HEAD
npm ci
npm run build
node examples/chat/configure.mjs
node packages/runner/dist/service-cli.js "$PWD/.local/chat-example/owner.json" serve
```

Keep the printed commit with your result: `main` can advance, and a successful
walkthrough qualifies the commit you actually used. `npm ci` uses the committed
lockfile. Initial builds may download dependencies and take longer than a warm build.
Keep the host running. In a second terminal, from the same checkout, start Web:

```sh
DISPATCH_CONFIG="$PWD/.local/chat-example/native.json" npm start
```

Open **http://127.0.0.1:4319**, using `127.0.0.1` rather than `localhost`.
Web connects to the explicit host. You can connect a terminal to it too:

```sh
node packages/runner/dist/agent-cli.js --socket "$PWD/.local/chat-example/agent.sock" run --agent helper --session main
```

For library use outside this checkout, follow [Runner's minimal application](../packages/runner/README.md#try-it-without-credentials).

## Observe the result

1. Choose the `helper` agent and create a conversation if none is selected.
2. Send `Hello from the quickstart`.
3. Wait for the reply beginning **Synthetic native reply:**. It repeats your
   message and streams slowly. This is an explicitly synthetic provider.
4. Reload and reopen the same conversation from the sidebar. Confirm your
   message and reply remain, with no duplicate input.
5. After the reply finishes, stop the **host** with Ctrl-C and restart the same
   `service-cli.js ... serve` command. Keep the Web process running.
6. Reload and reopen the same conversation. Its earlier messages must still be
   present. Send one follow-up to verify it remains usable.

While a reply streams, the empty composer exposes **Stop**. Sending another
message steers work at a native boundary; Stop interrupts the selected owned work.
Stopping the server suspends its work. Reopening history alone never submits a
replacement message or starts an owner.

Report the commit, OS/architecture, whether the reply and restart checks passed,
and any intervention needed. A build or a page loading does not verify these
interactions. The [full example](../examples/chat/README.md) also documents the
optional PostgreSQL/outbound-worker composition.

## Failure and recovery

- **Toolchain missing:** use an existing Node 24.22.1 installation or the optional
  `nix develop` shell. Do not change machine configuration without authority.
- **Port 4319 occupied:** leave its owner alone. Use
  `DISPATCH_PORT=4329 DISPATCH_CONFIG="$PWD/.local/chat-example/native.json" npm start`
  and open `http://127.0.0.1:4329`. Reuse that port when reopening browser state.
- **Configuration already exists:** `configure.mjs` deliberately refuses to
  overwrite it. Reuse your demo configuration or choose a new checkout.
- **Host/Origin denied:** use the exact `127.0.0.1` URL and port.
- **Build/startup failure:** retain the command, exit status and relevant error.
  Do not borrow another installation's dependencies, credentials or state.
- **Uncertain send:** preserve its original identity and use **Retry message**.
  Do not submit another copy just because the connection dropped.

## Stop, keep or remove the demo

Stop both foreground processes you started (Web and the host). Keep `.local/chat-example/` to
reopen its history with the same source and command. Close any browser tab you
opened for verification. To remove the demo, stop it first and delete only your
new `dispatch-demo` directory; that also deletes its synthetic history. There
is no Nix profile or system service to remove.

## Next steps

- [Define a minimal agent](../packages/runner/README.md#try-it-without-credentials)
  in your own application and customize its ordinary Markdown and TypeScript files.
- [Run a synthetic evaluation](../packages/eval/README.md) before supplying a real
  rubric, target and OpenAI or other supported judge binding.
- [Run a terminal-only example](../packages/runner/README.md#try-it-without-credentials)
  or configure a [local service](../packages/runner/docs/service.md).

Real agents and hosted installations require their own model access, tools,
authorization and operational qualification. Read [security](../SECURITY.md) and
the [interface boundaries](interfaces.md).
