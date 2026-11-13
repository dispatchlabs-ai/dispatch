# Host and client contract

A host owns execution and the conversation store. A client lists agents, creates
or finds conversations, sends input, observes changes, reads receipts and explicitly
stops work. Clients never start, replace, upgrade or reopen an execution owner.

## Start a host

For a local application with a root `agent.md` (or `agents/NAME/agent.md`), install
Runner and run `npx dispatch serve`. The launcher selects the definitions' built-in
Pi providers, reads their API keys from the host environment and saves native work
in `.state/`. `npx dispatch chat` connects from the same application directory.
Use `--state DIRECTORY` on both commands to select another store. No JSON file,
application entry point or Nix environment is required. See the
[quickstart](../../../docs/quickstart.md).

For explicit custom provider, MCP, channel or network bindings, use `run({root,stateRoot,models,...})` from application code, or keep a `host.json` beside the definition and start `dispatch serve --config host.json` or `dispatch-service host.json serve`.

```json
{
  "modelProviders": [{
    "module": "@dispatch/runner/environment-provider",
    "export": "environmentProvider",
    "args": ["anthropic"]
  }]
}
```

The CLI defaults `root` to the configuration file's directory, `cwd` to `root`,
`stateRoot` to `.state` beneath `root`, and the local socket to a private path
for that store. Use the same file with `dispatch chat --config host.json`.
An HTTP-only host opens only its configured network listener. Override `root`,
`cwd`, `stateRoot`, `socket` or `gateway.credentialFile` with a path relative to
the configuration file, an absolute path, or `~/` for the host account's home.
Programmatic callers of `startService` continue to supply explicit absolute paths.

Supply the selected provider's credentials in the host's environment or use your
own trusted provider binding. The host requires a provider, not a gateway.
The socket's directory must belong only to its account (0700); the socket is 0600.
Runner creates an absent directory with those permissions. Keep it outside shared
`/tmp` itself. `root` contains application-owned `agent.md` or `agents/`; `cwd` is explicit tool
authority, not a sandbox. Defaults discover all agents. `names` selects a subset.
One definition is the default; with several, clients choose an agent or the
optional `factory.yaml` selects `defaultAgent`.

For MCP tools, configure `mcpServers` here and select named connections with
`mcp: [name]` in each agent's Markdown frontmatter. The host connects them before
recovery; callers use the existing client contract. See [MCP connections](mcp.md)
for stdio/HTTP settings, authentication and lifecycle boundaries.

Start and stop this process with your application supervisor. SIGTERM/SIGINT
close it gracefully and preserve unfinished native work. Restart with the same
state and configuration to recover. Pi and the store owner lock prevent a second
writer. A failed connection never triggers replacement or writer takeover.

An application may call `serveService(host.service, socket, host.adapters,
{stateRoot})` after `run()`. Closing that listener disconnects clients only;
the application still closes its host. The JSON launcher uses these same APIs.

## Shared clients and company compositions

```js
import { connectClient } from "@dispatch/runner/client";
const client = await connectClient({ socket: "/srv/example/run/agent.sock" });
const chat = await client.create("helper", "custom-client", "thread-1", "Question");
const watch = await client.watch(chat.id, snapshot => console.log(snapshot));
const turn = await client.submit(chat.id, "Hello", "request-1");
const receipt = await client.wait(chat.id, turn.submissionId);
await watch.stop();
await client.close();
```

`run().client` uses this exact API in process. `connectInTerminal({client,agent})`
can display an embedded client without becoming a host. For a separate process:

```sh
dispatch-agent --socket /srv/example/run/agent.sock run --agent helper --session main
dispatch-agent --socket /srv/example/run/agent.sock run --session main --prompt Hello --request-id request-1
dispatch-agent --socket /srv/example/run/agent.sock run --session main --history
```

A session key finds the same conversation, including after a host restart or
a change to the default agent. `--agent` scopes that lookup. `--history` never
creates a conversation. One-shot CLI commands print request and submission
identities and return a nonzero exit status on failure. Untrusted terminal
control characters are rendered as visible escapes; stored text is unchanged.

Use `dispatch-web --config host.json` to connect Web to the same host as `dispatch chat --config host.json`. Both clients use the same socket or service URL. An HTTP host bound to loopback can use its own listener port and token file in this configuration.

Web's Backend connects with `openServiceRuntime({socket})`. Web does not launch
owners or import agent definitions. A channel adapter may map its external thread
key to the same chat. Sources are open strings; adding a client requires no Runner
source-code change.

### Interactive terminal UI

Runner 0.16.0 connects Pi's editor, Markdown, scrolling and pickers to
`AgentClient`. It runs as one foreground client; it does not start an execution
owner or use the separate storage observer.

| Command | Behavior |
| --- | --- |
| `/new` | Create a conversation with the selected agent |
| `/chats` | Search and open retained conversations |
| `/agents` | Choose an agent and open its terminal session |
| `/history` | Refresh the watch and scroll to the beginning |
| `/stop` | Cancel the selected conversation's owned work |
| `/reconnect` | Reconnect observation to the original host identity |
| `/retry` | Select an uncertain send and reuse its exact payload/request ID |
| `/help`, `/quit` | Show commands/shortcuts or disconnect |

Enter sends; Alt+Enter or Ctrl+J adds a newline. Up/Down browses input history.
F1 opens commands, Ctrl+P opens conversations and Ctrl+G opens agents without clearing the draft.
PgUp/PgDn and the mouse wheel scroll; Ctrl+Home/End jump to the beginning/latest.
Ctrl+O expands tool results and supporting details; individual tool headings are
clickable. Ctrl+Shift+F searches the transcript. Escape closes menus/search.
Ctrl+C copies a selection, closes autocomplete, or clears a draft, then exits
when empty. Ctrl+D exits from an empty editor. None of these keys sends Stop.

Full watch snapshots include retained history and messages from other clients.
Updates preserve the editor, scroll anchor and tool expansion; switching keeps
drafts and view positions per conversation. Tool completion/failure comes from
native results, not assistant narration. Retry/compaction errors and queued or
unanswered input remain visible. Catalog model metadata is not presented as the
effective configuration of an older conversation.

Reconnect never resubmits a mutation. A definite rejection restores the draft;
a lost acknowledgement retains the original request and payload for `/retry`.
A later rejection does not erase an earlier uncertain admission. On exit,
unresolved sends print their identities and text; inspect history before using
the same payload with `--request-id`. Quitting aborts client requests and watches,
while admitted host work continues. `connectClient(connection, signal?)` also
accepts cancellation during the initial connection.

One-shot prompts, `--history`, files, redirected input/output and `TERM=dumb`
use the existing plain path. Its interactive commands remain `/new`, `/history`,
`/stop` and `/quit`, and Ctrl+C disconnects.

## Authenticated network connections

A host may expose the same protocol behind HTTPS:

```json
"http": {"host":"127.0.0.1", "port":4320, "tokenFile":"/srv/example/secrets/client-token"}
```

Both HTTP token paths accept `~/`. Relative `http.tokenFile` paths use the host
working directory. A relative `tokenFile` in a URL client file uses the invoking
terminal's working directory.

Place TLS termination in front of this loopback listener. The token file contains
one private bearer token; it authorizes the installation's entire exposed catalog.
Rotate it by changing the file and restarting the host. It is not a per-user grant.
For custom authorization use `serveService(service,{host,port,authorize},...)`.

```js
const client = await connectClient({
  url: "https://agents.example.com",
  headers: async () => ({authorization: `Bearer ${await readPrivateToken()}`})
});
```

HTTPS is required for network clients; HTTP is allowed only on loopback for local
composition. Redirects are not followed. For the CLI use `--config CLIENT.json`
with `{"url":"https://agents.example.com","tokenFile":"/private/client-token"}`.
Only the client needs this token; it never receives model credentials or state paths
as filesystem access. Hosted Web's participant authorization remains its own layer.

## Operations and wire format

`AgentClient` exposes `info`, `agents`, `list`, `find`, `create`, `submit`, `snapshot`,
`watch`, `receipt`, `wait`, `artifact`, `stop` and `close`. `command()` exposes
additional host operations including status, schedules, compaction and instance
messaging. Exact inputs/results are the exported `ServiceCommand` and
`ServiceResults` types in `@dispatch/runner/client`.

- `POST /v1/commands` accepts `{command,expected?}` and replies `{result}` or
  `{error}`. `command.method` selects the operation. Artifact bytes use base64.
- `POST /v1/watch` accepts `{id,expected?}` and returns newline-delimited JSON,
  `Content-Type: application/x-ndjson`. Its first frame and subsequent native
  changes are `{snapshot}`. A terminal observation failure is `{error}`.
  The stream has no automatic reconnect or history polling. Reverse proxies must
  permit long-lived streaming and disable buffering.
- Both routes use the same operations and expectations on Unix sockets and HTTP.
  Unauthorized network requests return 401; changed owner expectations or rejected
  content/capabilities return 409; malformed commands return 400. Unknown routes
  return 404 and a starting host returns 503.

Every owner exposes a stable `identity` or `stateRoot`. `connectClient` binds to
that value (or checks your explicit `expected`) and includes it on every request.
A reused socket/URL serving another installation rejects commands before effects.
Custom facades must supply stable metadata. Identity comparison is not authorization.

## Admission, observation and recovery

Creation keys and request IDs are caller-owned identities. A retry with the same
key/ID reattaches to native work. If transport fails after a send, admission is
uncertain: retain the request ID, inspect the receipt/history, and deliberately
retry the same request if needed. No client automatically resends a mutation.
A 409 describes this attempt; it cannot disprove an earlier uncertain admission.

Human input steers active work at its next native boundary. Internal agent or
schedule input can select follow-up semantics. Validated attachment bytes and
source metadata are retained with that input. The host checks image support
against the agent's authored model. A snapshot is a projection of native records,
not a second transcript. A closed watch does not mean the agent finished.
`wait` resolves to the durable submission receipt; `done` and `unanswered` are
terminal outcomes, with failure/cancellation details retained by Pi.

`stop(id)` cancels that conversation's owned work; it does not undo external effects
or cancel independent recipient agents. Closing a client or stream never sends Stop.
Closing the host suspends work for restart. Do not change definitions beneath active
work; configure `updateDefinitions` explicitly when changing authored definitions.

## Optional channel extensions

Install `@dispatch/slack`, `@dispatch/google-chat` or `@dispatch/email` alongside
Runner and configure their account routing. `run({adapters})` registers delivery
extensions before starting recovery. The JSON launcher accepts
`adapters:[{module:"@dispatch/email",optionsFile:"/private/email.json"}]` for a
module exporting `createAdapter`. Slack, Google Chat and Email all expose that
factory. Relative module paths resolve from `root`; package names resolve in the runtime
installation through normal ESM imports.

These integrations retain native inbox/outbox tasks for durable delivery, stop
acknowledgements and channel-specific effects. Their input drafts go through
`ChatService.prepareInput`, also used by ordinary client sends, before native
transactional admission. Trusted workflow continuations retain their atomic
request check; they are recorded as runtime evidence, not new human authorization.
Email serializes per-thread handling to preserve reply identity and attachments.
Account credentials, routing and delivery formats belong to each connector.
New CLI, web or other interactive clients need only the public client contract.
