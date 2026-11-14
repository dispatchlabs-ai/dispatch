# Supported operations and interfaces

Clients use one Runner command/watch contract over embedded calls, Unix sockets
or authenticated HTTPS. Web adapts that contract to browser routes and SSE.
Durable channel delivery tasks are optional extensions in the same owner.

| Operation | Web / HTTP | Runner local service / CLI | Other packages |
| --- | --- | --- | --- |
| List agents and histories | Agent, chat and source routes | `agents`, `chats`; same owner catalog | Observer reads configured stores; channel routing is installation configuration |
| Create | Stable conversation creation key | `create`, native Chats identity | Channels map external threads into native conversations |
| Send and steer | Retained `requestId` | `send`, native admission receipt | Each channel preserves its admission and delivery identities |
| Observe | Snapshot and SSE | `snapshot`, `receipt`, native event stream | Observer is read-only; channels publish their documented public response projection |
| Stop | Selected conversation's stop route | `stop CHAT` | Channel controls are adapter-specific; independent recipients keep their own lifecycle |
| Files | Validated native input blocks and artifact routes | Native attachments and retained artifacts | MIME types and delivery receipts depend on the channel |
| Evaluate | No Web grading endpoint | Separate `dispatch-eval` command | Retained evidence or an explicitly configured rerun target |
| Upgrade | Application deployment | Bump the package and restart the explicit host | No runtime version takeover or machine migration command |

The versioned [Web OpenAPI contract](../packages/web/openapi.yaml) defines exact
paths, schemas and errors. [Backend](../packages/backend/README.md) documents
in-process operations; the [service guide](../packages/runner/docs/service.md)
documents commands and receipts. [Remote](../packages/remote/README.md) owns the
separate storage transport contract.

[MCP](../packages/mcp/README.md) adapts the same conversation operations through
stdio and authenticated Streamable HTTP: `list_agents`, `list_conversations`,
`find_conversation`, `create_conversation`, `send_message`, `get_conversation`,
`get_result`, `get_artifact` and `stop_conversation`. Native request identities,
receipts, snapshots and artifact validation remain owned by the host. A model can
use this connector to ask another agent; it does not acquire that agent's tools.

Native messaging is also available through MCP's `agent_instances`,
`message_agent`, `message_status` and `wait_for_agent`. They call the same host
`agent-instances`, `message`, `message-status` and `message-wait` operations as
`AgentClient` and native tools. Recipient selection, attributed automatic replies,
durable tasks and independent cancellation remain owned by Runner/Pi Durable.
Runner binds its own calls to the executing top-level conversation; external
operators explicitly select a sender under their existing host-wide authority.
The caller context checks host identity; it is not an additional credential or
a per-agent authorization system.

The [Pi terminal client](../packages/runner/docs/service.md#interactive-terminal-ui)
uses the same catalog, conversation and watch operations for interactive chat.
Its pickers, draft retention, scrolling and tool expansion are client behavior;
no protocol or storage migration is introduced. One-shot and redirected commands
keep plain output. Available in Runner 0.16.0 and newer.

Provider setup (`providers add/list`, `models list/use`, sign-in and logout) is
local host administration, separate from conversation operations. It uses native
Pi providers and local file/credential authority; HTTP/MCP callers cannot install
provider modules or launch commands through this feature. Managed inference
servers belong to the explicit host, and client disconnect does not stop them.
See [provider setup](../packages/runner/docs/providers.md) for availability and
lifecycle details.

## Authority

- **Local-first use:** CLI and local Web act with the local account's filesystem
  authority. A maintained Runner service owns stores behind a private Unix socket;
  clients use it rather than opening a second writer. Local Web also enforces
  exact Host, Origin and Fetch Metadata.
- **Hosted Web:** the installation supplies HTTPS and authorization. Supplied
  cookie and Basic adapters authorize one participant for all configured runs.
  Cookie revocation closes that session's streams. These are not per-user grants.
  Custom adapters must document and preserve their authority on every surface.
- **Channels:** account permissions and recipient routing belong to the adapter.
  A Slack token grants no Web or Unix-socket access. Operators bind shared agent
  identity deliberately; identical display names do not establish shared authority.
- **MCP:** stdio inherits its launching account's host access. HTTP requires a
  separate bearer token on every request and validates Host and Origin. That token
  authorizes the connected host's entire catalog, not a per-agent or per-user
  subset. Rotation revokes future requests; admitted work and existing waits
  continue. Network exposure requires installation-owned HTTPS termination.
- **Observation:** browsing, reconnecting and retained-record inspection do not
  submit, resume or cancel work. Reading records does not grant execution authority.
- **Administration:** upgrade, backup and offline repair are explicit host
  operations, not alternatives to ordinary service authorization.

The network client uses installation-level bearer authorization and HTTPS.
Machine-principal enrollment and multi-human grants remain future work. MCP is an
optional connector package; WebMCP is not implemented.

## Errors and recovery

Native request identities survive uncertain sends. Retry the same request.
A 409 rejection describes the current attempt and does not disprove an earlier
uncertain admission. Reconnection observes without automatically resending.
Stop affects the selected ownership tree, not independent agents or completed
external effects.

The HTTP contract documents 400/401/403/404/409/415/500 outcomes. Status and native
receipts are stable categories; human-readable diagnostic text is not a separate
stable error-code API. CLI commands return structured native results and nonzero
exit status on failure. Provider errors, ownership and definition incompatibility
remain visible. No application-wide concurrency cap is imposed; provider,
platform and native ownership constraints still apply.

Browser sends have no revision-precondition parameter: native request IDs govern
admission and replay, and definitions update through the idle release procedure.
Document revision editing is not a supported Web operation.

The [verification record](qualification.md) separates source checks from observed
behavior. Production credentials, real tools and each channel installation need
their own acceptance evidence.
