# Dispatch inference gateway

Run Pi inference in a trusted account while agents keep their native Pi Durable
execution, tools and recovery. Provider API keys and OAuth credentials remain in
the gateway's AWS Secrets Manager. Workloads receive a short-lived gateway token
scoped to their configured connections and models.

The [use-case inventory](USE_CASES.md) distinguishes current workload capabilities
from approved additions for direct Responses clients and employee access.

**Source alpha:** build from this repository with Node 22.19 or newer (the
repository development shell uses Node 24). The package is not published to npm.
After `npm run build --workspace @dispatch/inference-gateway`, run
`npm pack --workspace @dispatch/inference-gateway` and install that archive in the
agent project. Linux and macOS use the same Node client and server.

The server registers Pi 1.3's built-in providers without implementing separate
OpenAI, Anthropic or Fireworks protocols. Each connection has its own credential
store and native provider. For example, `openai` can use an OpenAI API key while
`openai-oauth` uses `openai-codex` and a separate OAuth credential. Other built-in
providers use the same configuration; a programmatic server may register custom
Pi providers. An inference provider's presence in the catalog does not prove
that a particular account can use every model.

A temporary [Codex desktop probe](docs/codex-probe.md) demonstrates local
ChatGPT Mac app inference through this gateway. A subsequent
[coding qualification](docs/codex-coding-qualification.md) verified native shell
and edit tools, follow-up work and resume after app restart. The loopback
Responses adapter remains experimental: automatic task titles fail, and broader
protocol compatibility and employee authentication remain separate work.

## Workload client

```ts
import { createGatewayModels } from "@dispatch/inference-gateway";
import { awsGatewayAuthorization } from "@dispatch/inference-gateway/aws";

const url = process.env.DISPATCH_INFERENCE_GATEWAY_URL!;
const models = await createGatewayModels({
  url,
  authorize: awsGatewayAuthorization(url),
});
// Supply models to the ordinary Pi Durable runtime.
```

The standard AWS credential chain uses an EC2 role in production and an approved
operator profile locally. The client signs a fixed STS GetCallerIdentity request
including the gateway's HTTPS audience. The server forwards only that fixed
request to regional STS, verifies the returned AWS account and immutable IAM role
ID, and issues a ten-minute token. The AWS secret access key never crosses the
wire. The proof is valid for sixty seconds and the gateway token for ten minutes;
both are bearer material during those windows. TLS is mandatory off loopback.

Model provider IDs in the returned collection are connection IDs. The original
model API, thinking metadata, usage, signatures, tool calls and final message
fields are retained. The server maps transcript identity back to its native
provider at dispatch. Pi's `pi-messages` SSE transport carries compact deltas; a
terminal extension preserves the complete final message. Requests propagate
cancellation. Only a pre-admission 401 triggers one authentication retry; an
admitted inference request is never automatically replayed by the gateway.

Image generation, classification and deferred operations delegate to the native
provider where available. Deferred handles are encrypted and bound to the
principal, connection and model. This prevents one workload from retrieving or
cancelling another workload's deferred work. These operations still require a
grant for the selected model.

## Server configuration

```json
{
  "audience": "https://inference.example.com",
  "sessionSecretId": "/dispatch/inference/session-key",
  "connections": [
    { "id": "openai", "provider": "openai", "secretId": "/dispatch/inference/openai" },
    { "id": "openai-oauth", "provider": "openai-codex", "secretId": "/dispatch/inference/openai-oauth" }
  ],
  "principals": [
    {
      "id": "example-agent",
      "aws": { "accountId": "123456789012", "roleId": "AROAEXAMPLE" },
      "grants": { "openai": ["gpt-6.1-sol"] }
    }
  ]
}
```

The session secret is 32 random bytes encoded as 64 lowercase hexadecimal
characters. Each connection secret stores a native Pi credential object:
`{"type":"api_key","key":"…"}`, optionally with provider-scoped `env`, or
the OAuth object returned by Pi. A JSON `null` represents a disconnected
connection. Install values separately from Terraform and never put them in
configuration, artifacts, logs or source control.

`region` defaults to `us-east-1`, the listen address to `127.0.0.1:8787`. Put a TLS
reverse proxy in front of the service. `/healthz` is public; `/v1/catalog`,
connection requests and ancillary operations require authorization. Grants are
exact model IDs or `*`; no grant means no access. Use `"grants": { "*": ["*"] }`
to allow all available models on every configured connection, including future
connections. An explicit connection entry overrides that default; an empty array
denies that connection. AWS identity authentication remains required. The server
resolves models from its own catalog and never accepts a client-provided endpoint, model object,
credential, provider environment or header override. Workload session IDs are
namespaced by principal and connection.

Only reviewed inference controls cross the boundary. `engine.ts` explicitly
allows native generation/reasoning options and sampling fields, rejecting
unrecognized options and routing overrides such as Azure deployment URLs and
OpenRouter fallback models. New Pi options need review before adding them.
Client `onPayload`, `onResponse` and stream observers inspect the gateway
protocol; executable callbacks and custom fetch implementations never run in
the server. Provider HTTP diagnostics and raw provider error text are not
returned. The service logs request IDs, principal, connection, model, operation,
status and usage, without prompts, outputs or credentials. Requests are bounded
to 32 MiB; there is no gateway concurrency limit.

Ambient credential lookup is disabled by default. Providers requiring AWS/GCP
ambient identity must explicitly set `allowAmbientAuth: true` and receive a
least-privilege service identity. Provider-specific configuration belongs in the
trusted connection credential/environment, never workload request options.

## OAuth and deployment

Run `dispatch-inference-gateway login CONFIG CONNECTION` from an authorized
operator environment to enroll a dedicated OAuth connection through Pi's native
flow. Do not copy refresh tokens from another active application. Stop the
gateway while changing an OAuth login. The store serializes refreshes and
persists each changed credential before using it, including when a request is
cancelled after a refresh. Standalone deployments must stop the old writer
before starting its replacement.

ECS deployments can run multiple ingress tasks with one provider-operation owner.
Use the [inference gateway Terraform module](https://github.com/dispatchlabs-ai/terraform-aws-inference-gateway)
and the [ECS operations guide](docs/ecs.md). A strongly consistent DynamoDB record
identifies the owner. Standby tasks authenticate and forward each request once;
only the owner initializes native Pi providers or refreshes credentials. A stale
heartbeat permits stopping the old task, but takeover requires actual ECS
`STOPPED` evidence. The module records that evidence durably through EventBridge.
There is no lease-only promotion, active-active credential refresh, or automatic
inference replay. Long streams may be interrupted during deployment or failure.
Stop **all tasks and verify STOPPED** before operator login or restoring state.

`nix develop --command npm run check` checks the repository. Follow the repository
policy: no automated tests. Verify real provider responses, tool round trips,
cancellation, denied models, invalid identity proofs and restart behavior before
cutover. OAuth needs an enrolled account and a refresh/restart check; API success
does not qualify OAuth.

The repository Nix package includes the `dispatch-inference-gateway` executable.
For the EC2 installation path, run the following from a committed checkout:

```sh
nix develop --command node packages/inference-gateway/scripts/bundle.ts
```

The archive includes freshly compiled gateway code, the root lockfile and both
workspace manifests. Install with `npm ci --workspace @dispatch/inference-gateway
--omit=dev --ignore-scripts`. The deployment repository owns TLS, IAM, DNS,
configuration, credential enrollment and the service unit. Gateway upgrades do
not change Pi Durable execution or migrate agent state.

The [versioned HTTP contract](docs/openapi.yaml) describes the wire operations.
The SDK is the ordinary workload interface. The local `login` command is
explicit credential-store administration and needs Secrets Manager write access.
Restart the gateway after enrolling a connection or changing configuration.
Fireworks uses its authenticated live model list at startup and each catalog
load, while Pi owns credentials and inference. Known model settings are retained;
new models use provider defaults, unknown pricing and fallback token budgets.
Muse Spark Open includes its documented reasoning levels. Failed later refreshes
retain the last list and emit a metadata-only warning. Other built-in providers
use the catalog bundled with the pinned Pi version. Recreate `createGatewayModels`
to reload a running client's catalog.
