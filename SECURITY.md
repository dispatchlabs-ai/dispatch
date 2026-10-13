# Security policy

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/dispatchlabs-ai/dispatch/security/advisories/new) for this repository. Sign in to GitHub, or open **Security → Advisories → Report a vulnerability**. Do not disclose vulnerabilities, exploit details, credentials or private application data in public issues or discussions.

Include the affected version or commit, impact and minimal reproduction steps using synthetic data. Remove tokens, enrollment links, passwords, recovery codes, personal information and private attachments from logs and screenshots. Share only what is necessary to reproduce the problem.

Dispatch is early `0.x` software. Maintainers review reports, but there is no guaranteed response time or maintained backport/support matrix. Use the latest published release and check its documented verification limits; a release is not a security certification.

## Execution and trust boundaries

Use trusted users, agents and tools. Coding tools run with the service account's filesystem, process and network authority. Working directories and separate agent contexts are not sandboxes. Native Muse execution disables its sandbox and approval prompts; optional Dispatch tool permissions do not confine native Muse access.

MCP connections can reach private-network hosts and the service host's loopback interface. Protect the service and restrict its host/network access where isolation is required. Permission revocation applies to later permission-checked uses; Stop is an interruption request, not an undo or secure-erasure mechanism. Neither revokes credentials already obtained through host access.

See [operating guidance](packages/web/docs/usage-guide.md) and [runtime boundaries](packages/web/docs/runtime.md) for supported behavior and qualification limits. Keep credentials and credential-bearing backups in restricted storage, not issue reports.
