# Codex desktop gateway probe

This experiment proves that a local Codex task in the ChatGPT Mac app can use
the existing Dispatch inference gateway. The temporary `src/codex-probe.ts`
adapter translates a subset of Responses streaming into the gateway's native Pi
client. The original text proof is recorded below; the later
[coding qualification](codex-coding-qualification.md) covers native shell and edit
tools, follow-up work and resume after app restart. This remains a diagnostic
program, not a production Responses endpoint.

The probe binds only to `127.0.0.1`, requires a random local bearer token, and
authenticates upstream with an already authorized AWS identity. Provider keys
stay on the gateway. The protocol helper forwards text, the requested reasoning
effort, function/custom tool definitions, calls and results, including Codex's
`additional_tools` input item. It translates namespaces to stable Pi tool names
and restores the original names and call IDs in Responses events. Live coding
exercised the custom `functions.exec` path. Function-call translation and
encrypted reasoning replay are implemented but unqualified. Structured output
is rejected, including the app's automatic-title request. Images, compaction and
other app features are unqualified. There is no direct-provider fallback.

## Reproduce the experiment

Use an idle app session and preserve its model, reasoning, permission and
approval settings. The example uses an operator Mac with a working gateway AWS
profile and an SSH connection to the app's Mac; both can be the same machine
when its AWS identity is already enrolled.

From the Dispatch repository, build the package and create a private token:

```sh
nix develop --command npm run build --workspace @dispatch/inference-gateway
umask 077
mkdir -p .local
python3 -c 'import secrets,pathlib; pathlib.Path(".local/codex-probe-token").write_text(secrets.token_hex(32))'
```

Replace the example gateway URL, AWS profile and SSH host alias with your own installation values. Run the adapter in the foreground with an approved AWS profile:

```sh
AWS_PROFILE=approved-profile \
DISPATCH_INFERENCE_GATEWAY_URL=https://inference.example.com \
CODEX_GATEWAY_PROBE_TOKEN_FILE=.local/codex-probe-token \
nix develop --command node packages/inference-gateway/dist/codex-probe.js
```

The default connection/model is `openai/gpt-6-astra`; override with
`CODEX_GATEWAY_PROBE_CONNECTION` and `CODEX_GATEWAY_PROBE_MODEL` only when that
exact selection is available in the authenticated gateway catalog. `PORT`
defaults to `8789`.

When the app and adapter run on different Macs, use an ephemeral
SSH reverse forward:

```sh
ssh -o ExitOnForwardFailure=yes -N \
  -R 127.0.0.1:8789:127.0.0.1:8789 client-mac
```

Keep the same random token in a mode-600 file inside a private directory on the
app's Mac. Back up `~/.codex/config.toml` there, then temporarily select
`model_provider = "gateway_probe"` at the top level and add:

```toml
[model_providers.gateway_probe]
name = "Dispatch gateway probe"
base_url = "http://127.0.0.1:8789/v1"
wire_api = "responses"
supports_websockets = false

[model_providers.gateway_probe.auth]
command = "/bin/cat"
args = ["/absolute/private/path/to/probe-token"]
```

Use a real absolute path; TOML does not expand shell variables. The helper
returns only the local probe token, not an upstream provider credential. Do not
combine this authentication helper with `env_key` or `requires_openai_auth`.

Restart the ChatGPT Mac app to activate the provider change, create a fresh local
task in the intended saved workspace, and ask it to return a unique text marker
without using tools. A returned marker alone is insufficient: confirm the task's
provider is `gateway_probe`, preserve its effective permission settings, and match
the adapter's `gatewayRequestId` to a successful gateway log entry. Inspect the
reply in the app and confirm the task appears in its sidebar.

Finally remove the temporary provider selection and block, preserving concurrent
configuration edits. Restart the app again, verify its normal defaults, stop the
adapter and SSH forward, and remove the temporary token and backups. This
procedure installs no persistent service or fleet configuration. A lasting
installation would need its owning infrastructure configuration and a qualified
protocol adapter.

The activation and authentication fields follow OpenAI's
[gateway setup](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway) and
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Broader compatibility requirements are documented in
[gateway compatibility](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility).

## Original text result — October 21, 2026

The earlier text-only adapter completed one local app task using `openai/gpt-6-astra`.
The route used a temporary SSH tunnel between two Macs, the loopback adapter, an
enrolled operator AWS identity and the HTTPS gateway. Provider credentials stayed
on the gateway. The app's bundled Codex was `0.163.0-alpha.10.2`; the task retained
`xhigh`, Full Access and never-ask approval settings.

A unique text marker appeared in the app and the adapter request matched a
successful gateway log record for the selected principal, connection and model.
The gateway reported a 3,302 ms completion and 14,746 total tokens: 3 uncached
input, 14,729 cache-write input and 14 output tokens. The original usage projection
omitted cache-write input; the final source includes it in `input_tokens`.
Installation identities, task/request IDs, personal paths and log locations are
retained privately and are not needed to reproduce the procedure.

A control task before restarting the app used its normal provider and produced
no adapter request, so it was excluded. Early requests failed until the adapter
recognized `additional_tools`; those failures did not fall back to a direct
provider. The accepted task completed through the gateway and remained visible
in the task list.

This establishes text inference through a temporary operator-Mac hop. The later
[coding experiment](codex-coding-qualification.md) extends that scope. Direct
employee authentication, Google Workspace SSO, individual usage attribution,
budgets and routing of every ChatGPT feature remain unqualified. The deployed
ECS service was unchanged.

Temporary settings, tokens and forwarding processes were removed; concurrent
app configuration and the original model, reasoning and permission defaults were
preserved. TypeScript and workspace build checks passed. No automated tests were
added or run under repository policy.
