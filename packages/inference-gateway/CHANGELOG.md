# Changelog

## [Unreleased]

- Add direct HTTPS Responses streaming/JSON and model discovery through native Pi provider hooks, retaining tools, reasoning items, structured-output requests and explicit route metadata.
- Add Google Workspace employee sign-in, renewable CLI/SDK credentials, scoped client keys and revision-checked administration with per-request revocation across replicas.
- Allow employee sign-in with `--no-browser` when choosing a browser manually.
- Accept Codex client telemetry without forwarding it to the inference provider.
- Attribute Pi and Responses requests to employee/client/company totals in DynamoDB, with recoverable usage receipts and optional monthly warning/block policies. No spending limits are enabled by default.

- Sanitize public documentation and examples; replace the public Git history with a fresh snapshot and withdraw earlier tags/releases. Preserve private engineering records separately.

- Add a package use-case inventory covering current workload access and approved Responses, employee sign-in, scoped client credentials and usage-control additions.
- Extend the temporary Codex adapter to translate native tool calls and results; verify macOS coding, follow-up edits and task resume after app restart. Document the automatic-title failure and remaining compatibility gaps.
- Add a temporary, authenticated loopback adapter and a verified ChatGPT Mac app text-routing experiment through the existing gateway.

- Add a digest-pinned distroless container build and ECS ingress replicas with a single fenced provider owner, durable task-stop evidence, authenticated peer forwarding, and graceful draining.
- Load immutable gateway configuration from S3 with SHA-256 verification. Preserve refreshed OAuth credentials even when the initiating request is cancelled.

- Add a standalone Pi inference gateway and shared agent client, keeping provider authentication on the gateway.
- Support all configured connections with a wildcard grant and discover Fireworks models from the account's live catalog.
