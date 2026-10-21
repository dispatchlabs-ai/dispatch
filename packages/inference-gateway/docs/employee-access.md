# Employee access and Responses clients

Employees use the public HTTPS gateway without AWS credentials or a workstation
bridge. Operators retain provider credentials in Secrets Manager. Native Pi and
Responses clients share identity, grants, revocation and usage accounting.
This is source-alpha functionality; qualify the actual client and provider before
rollout. The earlier [desktop probe](codex-probe.md) is a separate experiment.

## Installation and first sign-in

Build and install the package using the [README](../README.md), or use its Nix
executable. An administrator must first configure Google Workspace authentication
and enroll your email as described below. Then run:

```sh
dispatch-inference-gateway auth login https://inference.example.com "My workstation"
dispatch-inference-gateway auth request https://inference.example.com GET /v1/me
```

The first command opens Google sign-in and receives a one-time code on a random
loopback port. It prints the authorization URL if opening the browser is
unavailable. Use a browser on the same machine as the CLI. Successful sign-in
prints credential metadata; `/v1/me` returns your identity and current grants.
Add `--no-browser` to choose the browser yourself. A login is bound to the first
browser that opens its URL; start a new login to switch browsers.
On Windows, open the printed URL manually. Windows has not been qualified.

Access tokens last up to ten minutes. The thirty-day session refresh credential
rotates whenever it renews access; after thirty days, sign in again. The CLI keeps
credentials in an origin-specific file under `~/.config/dispatch-inference-gateway`
with mode `0600`, uses atomic replacement and serializes concurrent refreshes
across processes. A failed refresh requires retry or sign-in; it never silently
switches accounts. Refresh-token rotation lost to a network interruption may
require a new sign-in. Use `auth logout URL` to revoke the saved session.

For native Pi:

```ts
import { createGatewayModels } from "@dispatch/inference-gateway";
import { employeeGatewayAuthorization } from "@dispatch/inference-gateway/employee";

const url = "https://inference.example.com";
const models = await createGatewayModels({
  url,
  authorize: employeeGatewayAuthorization(url),
});
```

For a client that supports a bearer-token helper, run
`dispatch-inference-gateway auth token URL`. Its stdout is only the token; treat
it as a secret. Invoke the helper again when access expires. Clients accepting
only a fixed API key should use an individually owned key below.

### Codex configuration

For a Codex version that recognizes `gpt-6.1-sol`, configure a gateway alias with
that exact name pointing to the intended model. After employee sign-in, merge
this into the client's configuration, using the installed executable's absolute
path from `command -v dispatch-inference-gateway`:

```toml
model = "gpt-6.1-sol"
model_provider = "dispatch_gateway"
web_search = "disabled"

[model_providers.dispatch_gateway]
name = "Dispatch gateway"
base_url = "https://inference.example.com/v1"
wire_api = "responses"
supports_websockets = false

[model_providers.dispatch_gateway.auth]
command = "/absolute/path/to/dispatch-inference-gateway"
args = ["auth", "token", "https://inference.example.com"]
timeout_ms = 30000
refresh_interval_ms = 300000
```

Keep top-level keys before TOML tables and preserve existing unrelated settings.
Do not combine command authentication with `env_key` or `requires_openai_auth`.
For a fixed client key, replace the auth table with an `env_key` in the provider
table and deliver its value through the client's environment. Unknown aliases
need matching Codex catalog metadata; `/v1/models` is an OpenAI-style list, not a
Codex-native catalog. Check model metadata against the deployed Codex version.
Restart the client, verify its selected provider, and correlate a real tool
conversation with gateway receipts. See OpenAI's
[gateway setup](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway)
and [compatibility requirements](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility).

## Responses contract

Set the client's OpenAI-compatible base URL to `https://inference.example.com/v1`
and use bearer authentication. `GET /v1/models` returns granted Responses routes.
Select `connection/model`, such as `openai/gpt-6.1-sol`, or an operator-configured
alias. `POST /v1/responses` supports SSE (`stream: true`, the default) and a JSON
final response (`stream: false`). For example:

```json
{
  "model": "openai/gpt-6.1-sol",
  "input": "Reply with one short greeting.",
  "stream": true,
  "store": false
}
```

Pi's native OpenAI Responses and OpenAI Codex providers own authentication,
credential refresh, inference and usage extraction. Native Responses input items,
reasoning signatures, function/custom tools, namespaces, client-side tool search,
structured-output options and SSE events cross the gateway without a second
provider implementation. The client executes tools and replays full conversation
items with their results on the next request. The gateway never runs those tools.
Actual model support still depends on the chosen provider/account.
Codex's `client_metadata` telemetry field is accepted and discarded; it does not
affect authorization or enter the provider request or usage records.

The endpoint is stateless: stored responses, `previous_response_id`, item
references, provider-hosted file IDs, background requests, hosted tools, remote
MCP tools and WebSocket transport are unsupported. Inline file/image content is
passed to the provider. Unknown top-level fields and unsupported tools receive
400. A model on another native protocol receives `responses_not_supported_for_model`;
the service does not change providers or models automatically. Pi transport
remains available for other configured providers and its ancillary operations.

`x-request-id` identifies the admitted request. `x-dispatch-connection` and
`x-dispatch-model` report the resolved route. SSE ends with a native completion
or sanitized failure; a disconnect cancels provider work. Provider HTTP 429 is
retained before SSE starts; other provider failures use 502. Once streaming has
started, failure is an SSE event or interrupted stream. Clients must not assume
that retrying an interrupted request is free or that it resumes the old request.
Neither transport automatically replays admitted inference.

## Configure the service

Create a Google OAuth **web application** client in the organization's Google
Cloud project. Register exactly `https://inference.example.com/v1/auth/google/callback`
as its redirect URI. Store its client secret as a plain Secrets Manager string;
the gateway needs read access only. Do not reuse provider OAuth refresh tokens.

Add the following to the gateway configuration:

```json
{
  "access": {
    "table": "example-gateway-access",
    "google": {
      "clientId": "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
      "clientSecretId": "/example/gateway/google-client-secret",
      "hostedDomains": ["example.com"]
    }
  },
  "responsesAliases": {
    "coding": { "connection": "openai", "model": "gpt-6.1-sol" }
  }
}
```

The access table has string partition/sort keys `pk`/`sk`, TTL attribute
`expires`, encryption, point-in-time recovery and deletion protection. The
[AWS module](https://github.com/dispatchlabs-ai/terraform-aws-inference-gateway)
can create it with `enable_employee_access = true`; supply the Google secret ARN
through `authentication_secret_arns`. The task needs GetItem, PutItem, UpdateItem
and Query on this table. Values and tokens never enter Terraform. Keep access
records in the deployment's backup and regional recovery plan.

Google ID tokens require the configured client ID, issuer, signature, expiry,
nonce, verified email and an allowed `hd` Workspace claim. An email suffix alone
does not establish organization membership. Enrollment binds the employee to
Google's immutable subject at first sign-in. Reassigning the email to a different
Google identity cannot take over that employee's account.

Set `admin: true` only on the configured AWS operator principal. Employee
sessions and API keys never become administrators. Configuration changes still
require deployment; employee policy and credential changes use the live API.
Every replica reads current employee and credential records consistently on
every request. A grant reduction, disable or credential revocation affects
already-issued tokens on their next request. Work already admitted may finish.
Access-store failure fails closed; there is no cached authorization fallback.

## Enroll and manage employees

With the configured AWS operator identity, save this non-secret input as
`employee.json`:

```json
{
  "email": "person@example.com",
  "enabled": true,
  "grants": { "openai": ["gpt-6.1-sol"] }
}
```

```sh
dispatch-inference-gateway auth admin https://inference.example.com PUT /v1/admin/principals/example-person employee.json
dispatch-inference-gateway auth admin https://inference.example.com GET /v1/admin/principals/example-person
```

No one is admitted solely by joining the Workspace. Principal IDs and enrollment
emails are unique; existing enrollment emails cannot be reassigned. To update a
record, include its current `revision` and the complete email/enabled/grants
fields. A stale revision returns 409. Use `enabled: false` to disable the person;
reenabling does not restore their old credentials. `revokeCredentials: true`
invalidates all existing sessions/keys while leaving the person eligible to sign
in again. Read endpoints paginate with an opaque `cursor`.

## Individually owned client keys

An employee session or AWS administrator can create a key. Save `key.json`:

```json
{
  "clientName": "My compatible client",
  "grants": { "openai": ["gpt-6.1-sol"] }
}
```

```sh
dispatch-inference-gateway auth request https://inference.example.com POST /v1/credentials key.json
dispatch-inference-gateway auth request https://inference.example.com GET /v1/credentials
dispatch-inference-gateway auth request https://inference.example.com DELETE /v1/credentials/CREDENTIAL_UUID
```

Creation returns the secret once. Store it in a password manager and supply it
only to the intended client; the gateway stores its hash. Keys expire after
ninety days by default, or at an explicit `expiresAt` in Unix milliseconds.
They are limited by both their own scope and the owner's current grants. Keys
cannot create more keys, manage credentials or call administrative endpoints.
Admins use `/v1/admin/principals/PRINCIPAL/credentials` for an employee's keys.

## Usage and optional spending controls

`GET /v1/usage?month=2026-01` returns your UTC calendar-month totals. Administrators
use `/v1/admin/usage` for company totals, adding `principal` and optionally `client`
to select a person or credential. A key can inspect only its own totals. Totals
include requests, input/output/cache/reasoning tokens, estimated USD and unpriced
requests (including zero estimates, which some providers use for unknown
pricing). `/v1/admin/requests?month=2026-01` lists metadata-only request receipts.

An admission receipt is durable before provider work. Completion updates the
receipt and atomically settles all three totals once. Retrieval of the same
deferred result does not charge its usage twice. A provider result with failed
aggregate settlement remains visible with `accounted: false`; an administrator
can reconcile a known result with
`POST /v1/admin/requests/MONTH/REQUEST_UUID/reconcile`. A pending receipt means
the provider outcome is unknown and cannot be reconciled by assuming zero cost.
The gateway never records prompts, response content, keys or refresh tokens in
receipts or logs.

There are **no spending limits by default**. To add an employee limit, include
`"budget": { "monthlyUsd": 100, "mode": "warn" }` in a revision-checked principal
update. Omit `budget` in that update to remove the limit. Company policy uses
`GET/PUT /v1/admin/budget` with `{ "budget": null }` to remove it, or a budget
object and the current revision to set it. `warn` returns
`x-dispatch-budget-warning`; `block` rejects new inference with 429 after recorded
estimated spending reaches the configured amount. Deferred retrieval/cancellation
remains available so an admitted result can be collected and accounted for.

These are admission controls against Pi's reported cost estimates, not invoice
caps. Concurrent or in-flight requests can exceed a threshold. Missing usage,
unknown model pricing, provider discounts, subscription charges and interrupted
requests can differ from the estimate. Inspect unpriced/pending receipts and the
provider bill separately. No concurrency cap or automatic provider fallback is
introduced by a spending policy.
