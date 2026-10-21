# Inference gateway use cases

The inference gateway provides centrally managed model connections while keeping
provider credentials on the trusted service. This inventory records actor goals
for development and behavior preservation. IGW-001–IGW-014 have source
implementations; source presence does not establish deployment or client qualification.
Setup, contracts and verification limits remain in the [README](README.md),
[HTTP contract](docs/openapi.yaml), [ECS guide](docs/ecs.md) and
[employee access guide](docs/employee-access.md) and historical
[experimental Codex qualification](docs/codex-coding-qualification.md).
The browser workspace has its own [Dispatch inventory](../web/USE_CASES.md).

Workloads run agents and tools in their own execution environments. Operators
manage provider connections, access grants and the gateway installation.
Employees are people using compatible clients with company-funded inference.
The gateway handles inference, credentials and access; it does not own clients'
agent execution or conversation databases.

## 1. Provider access

- **IGW-001 — Connect model providers centrally.** An operator enrolls separate API-key or OAuth connections supported by native Pi providers so callers can use inference without receiving upstream provider credentials.
- **IGW-002 — Discover and select authorized models.** A caller lists models available through its granted connections and deliberately selects the connection and model for its work.
- **IGW-003 — Control workload access.** An operator grants or denies connections and models for a workload identity, including broad grants where intended, and the gateway enforces that scope on requests.

## 2. Workload integration

- **IGW-004 — Authenticate a workload.** A workload proves an authorized AWS role identity and obtains a short-lived gateway credential for its permitted inference operations.
- **IGW-005 — Run native Pi inference.** A compatible Pi client streams model output, executes tools locally, submits their results and continues its conversation through the gateway while retaining its own runtime and durable state.
- **IGW-006 — Use supported provider operations.** A compatible client requests image generation, classification or deferred results when the selected native provider and model support that operation.

## 3. Operation and recovery

- **IGW-007 — Maintain provider credentials.** An operator enrolls or replaces credentials, and the gateway persists native OAuth refreshes so subsequent requests and restarts use the current credentials.
- **IGW-008 — Diagnose inference and account for usage.** An operator correlates a request with its caller identity, connection, model, status and reported usage without recording prompt/response content or credential values.
- **IGW-009 — Operate and replace the gateway.** An operator deploys compatible images and configuration, drains or replaces tasks and recovers provider service while preserving credentials and exclusive provider ownership.

## 4. Employee and client access

- **IGW-010 — Use a Responses-compatible client directly.** A person configures a compatible client, including local Codex, to use the gateway's public HTTPS Responses endpoint for streaming inference, tools and conversation continuation, without another workstation or an SSH bridge.
- **IGW-011 — Sign in as an employee.** An employee signs in through the organization's Google Workspace identity and obtains renewable, individual gateway credentials for authorized clients while upstream provider credentials remain central.
- **IGW-012 — Authenticate other compatible clients.** A person or operator provisions a scoped, individually owned gateway API key for a client where interactive employee sign-in is impractical; the client receives no upstream provider credential.
- **IGW-013 — Manage employee and client access.** An administrator grants or removes access and revokes employee sessions or client credentials consistently across gateway replicas, including already issued credentials.
- **IGW-014 — Attribute and control company-funded usage.** An administrator attributes inference usage to employees or client identities and applies configured spending controls across supported interfaces.

Employee and company spending limits are optional and unset by default. Direct
Responses currently supports native OpenAI Responses/OpenAI Codex connections;
the Pi interface remains available for other configured providers. See the
employee guide for stateless continuation, revocation and cost-estimate boundaries.
