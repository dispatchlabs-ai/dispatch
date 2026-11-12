# Your first durable conversation

Run a local synthetic agent, watch its reply, then reopen the same conversation
after restarting the service. This demonstrates storage and interaction without
a model account. It does not measure model quality or run real tools.

## Prerequisites and effects

- Git, access to public GitHub/Nix/npm downloads, and Nix with the
  `nix-command` and `flakes` features available. The pinned development shell
  supplies Node 24.22.1, npm and `lsof` for process status; no global Node
  installation is needed.
- A supported Nix platform: macOS Apple Silicon or Linux. See the
  [verification record](qualification.md) for the exact architectures observed.
  Intel macOS and native Windows are not qualified for this Nix walkthrough.
- A browser, or an agent with documentation, shell, file and browser access.
  An agent must report any step it cannot perform.

Use a fresh directory. Commands below write into that checkout and the normal
Nix/npm download caches. The demo binds loopback port 4319 and stores synthetic
state in `.local/chat-example/`. It installs no system service and needs no
provider credentials. Nix must already be installed; installing it is a separate
machine change.

## Download and build

Choose a parent directory in which `dispatch-demo` does not already exist:

```sh
git clone --depth 1 --branch main https://github.com/dispatchlabs-ai/dispatch.git dispatch-demo
cd dispatch-demo
git rev-parse HEAD
nix develop
npm ci
npm run build
node examples/chat/configure.mjs
DISPATCH_CONFIG="$PWD/.local/chat-example/native.json" npm start
```

Keep the printed commit with your result: `main` can advance, and a successful
walkthrough qualifies the commit you actually used. `npm ci` uses the committed
lockfile. Initial builds may download dependencies and take longer than a warm build.
`nix develop --command COMMAND ...` is the noninteractive equivalent for agents.
If these experimental features are not enabled by default, use
`nix --extra-experimental-features 'nix-command flakes' develop` (and add
`--command COMMAND ...` for noninteractive use). This enables them for that
invocation without changing machine configuration.

Leave the last command running. Open **http://127.0.0.1:4319**, using
`127.0.0.1` rather than `localhost`.

## Observe the result

1. Choose the `helper` agent and create a conversation if none is selected.
2. Send `Hello from the quickstart`.
3. Wait for the reply beginning **Synthetic native reply:**. It repeats your
   message and streams slowly. This is an explicitly synthetic provider.
4. Reload and reopen the same conversation from the sidebar. Confirm your
   message and reply remain, with no duplicate input.
5. After the reply finishes, stop your demo with Ctrl-C. Start the same
   `DISPATCH_CONFIG=... npm start` command again from the same checkout and shell.
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

- **Nix missing:** report the prerequisite. If Nix is already installed but not
  on PATH, load its existing shell profile; do not install another copy. Do not
  silently install system software or change the user's Nix configuration.
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

Stop only the foreground process you started. Keep `.local/chat-example/` to
reopen its history with the same source and command. Close any browser tab you
opened for verification. To remove the demo, stop it first and delete only your
new `dispatch-demo` directory; that also deletes its synthetic history. There
is no Nix profile or system service to remove.

## Next steps

- [Build a starter agent catalog](../packages/kit/README.md#first-result), then
  add your own instructions.
- [Run a synthetic evaluation](../packages/eval/README.md) before supplying a real
  rubric, target and OpenAI or other supported judge binding.
- [Run a terminal-only example](../packages/runner/README.md#try-it-without-credentials)
  or configure a [local service](../packages/runner/docs/service.md).

Real agents and hosted installations require their own model access, tools,
authorization and operational qualification. Read [security](../SECURITY.md) and
the [interface boundaries](interfaces.md).
