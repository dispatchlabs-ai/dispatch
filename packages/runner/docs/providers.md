# Connect providers and choose models

**Unreleased source feature; not included in the v0.19.0 archives.** The existing
[sign-in commands](sign-in.md) remain supported. Use a build of this source until
a release containing provider setup is published.

Run setup in your agents application, on the computer that will run its host:

```sh
npx dispatch providers add
npx dispatch serve
```

The picker comes from Pi's native provider registry. Provider metadata supplies
login choices, subscription labels and prompts. Setup authenticates, discovers
models, lets you choose one, and checks an actual response before saving the
connection in `host.json`. A listed model alone is not proof of account access.
You can assign the checked model to an existing agent immediately or choose later.

In another terminal, `npx dispatch chat` connects to the host. `serve`, `chat` and
the default Web client read the project's `host.json`. Use `--config PATH` for a
different file. Credentials stay in the private [sign-in store](sign-in.md#accounts-storage-and-recovery),
outside the application; `host.json` contains non-secret settings.

## ChatGPT and Claude

```sh
npx dispatch providers add openai
npx dispatch providers add anthropic
```

Choose the provider's subscription sign-in or API-key method. The terminal
renders Pi's browser, device-code, secret and selection prompts. For ChatGPT,
select the account and personal/work workspace whose allowance you intend to
use. Claude's native flow may require email verification or a CAPTCHA; complete
those in the browser. The browser controls which permissions you authorize.
Account eligibility and usage limits remain the provider's responsibility.

`--api-key` selects hidden API-key input. `--no-browser` leaves the sign-in URL
for you to open. Already configured access can be reused or replaced by signing
in again. Environment-only providers use their native credential checks.

The saved connection is small:

```json
{
  "modelProviders": [
    { "provider": "openai" },
    { "provider": "anthropic" }
  ]
}
```

Existing gateway and module bindings remain supported. Setup preserves unrelated
host settings and detects edits made while you were signing in. Adding an
existing provider replaces its connection settings after successful verification.
It does not silently substitute another account after an authentication failure.

## Apple local and managed `fm serve`

On a Mac with Apple's `fm` CLI and its on-device model available:

```sh
fm models
npx dispatch providers add apple-local
```

Choose **Let Dispatch start and stop it**. Setup starts a temporary `fm serve`,
checks availability and a real response, then stops it. The saved configuration is:

```json
{
  "modelProviders": [{
    "provider": "apple-local",
    "process": {
      "command": "fm",
      "args": ["serve", "--host", "127.0.0.1", "--port", "{port}"],
      "baseUrl": "http://127.0.0.1:{port}/v1",
      "readyUrl": "http://127.0.0.1:{port}/health"
    }
  }]
}
```

When you start `dispatch serve`, the host starts one server for that connection,
waits for readiness, and shares it across agents and channel adapters. `{port}`
is allocated on loopback for this host lifetime. Closing a chat client leaves the
server running. Stopping or losing the host cleans up the owned process group.
If the server exits, the next request starts it again; Pi owns inference retry
and durable recovery. Startup waits are cancellable and have no fixed deadline.

Dispatch does not install `fm`, enable Apple Intelligence, download Apple's model,
or create a machine daemon. Check `fm models` if Apple's `system` model is
unavailable. Only `system` is offered: this connection does not select PCC or fall
back to cloud inference. The integration uses Pi's native OpenAI-compatible
transport. AFM 3's 8,192-token context was checked through Apple's native API;
`fm` does not currently advertise the limit in `/v1/models`. A custom factory can
call `appleLocalProvider({ contextWindow })` when a different installed model
has a verified limit.

Alternatively choose **Connect to a server I manage**, or supply
`--base-url http://127.0.0.1:PORT/v1`. Dispatch uses that endpoint and never starts
or stops the external server. `process` and `baseUrl` are mutually exclusive.
Managed process groups require POSIX; Apple local itself requires a compatible
Mac. Command arguments and endpoints must not contain credentials.

## Models and agent defaults

```sh
npx dispatch providers list
npx dispatch models list
npx dispatch models list --provider openai --json
npx dispatch models use --agent developer
npx dispatch models use --agent developer --provider apple-local --model system
```

Provider listing reports configured connections and saved credential types; it
does not prove that a running host has loaded them. Model listing refreshes the
configured providers using Pi and may temporarily start a managed server. All
resources opened by these commands are closed when the command ends. Filter by
`--provider` to inspect one connection independently.

`models use` edits only an existing agent's model frontmatter. It preserves its
instructions and other settings, and resets an incompatible thinking level to
`off`. Restart the host to load changed connections and definitions. Existing
conversations keep their model unless you deliberately apply definition updates;
see [editing agents](create-agents.md#edit-or-add-an-agent).

For models whose context cannot fit Pi's usual reserve and recent-history
budgets, the service supplies native per-model compaction defaults: up to one
eighth of the context for the response reserve, half for recent history, and
one quarter for the background-compaction reserve. Explicit host budgets and
native conversation model overrides take precedence. Compaction remains Pi's
implementation; these defaults do not enlarge the model's actual context or
establish quality for long or complex tasks.

## Add a native Pi provider without changing Dispatch

Your trusted module exports a factory returning a native Pi `Provider`:

```sh
npx dispatch providers add --module ./providers/example.ts --export exampleProvider
```

The same picker, `AuthInteraction`, `CredentialStore`, discovery and response
check apply to that provider. Use Pi's `createProvider` and transport interfaces;
there is no Dispatch model protocol to implement. Setup saves a relative module
path and `credentials: "local"`. Module paths are resolved from `host.json`;
the CLI's `--module` path is relative to your terminal's working directory.
Advanced bindings can supply factory `args`, an identity override, and an
optional session cleanup export. Existing custom factories keep ownership of
their credentials unless `credentials: "local"` is explicitly selected.

Any provider binding can include the same declarative `process` settings shown
above. Its executable, argument vector, API endpoint and readiness URL define
the local server lifecycle; the supervisor has no provider-specific branches.
The native provider owns model discovery and protocol compatibility. Trusted
module code and launch commands run with the host account's authority.

## Cancellation and recovery

Ctrl-C cancels setup and closes its temporary server. A failed response check
does not write the host connection or agent model. A completed sign-in is saved
independently: retry setup to reuse it, or run `npx dispatch logout PROVIDER` to
remove it. Logout does not revoke access at the provider or stop a running host.

Use `providers add` again to change credentials or an endpoint. Setup is local
administration: it edits files and checks providers without opening the durable
conversation store or replacing a running host. The conversation HTTP/MCP
contract is unchanged. Restart the explicit owner to apply saved settings.
