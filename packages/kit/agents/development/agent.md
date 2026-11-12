---
description: Development — deliver features and fixes through implementation, narrow independent code review and publication; run cleanup or security remediation only when separately assigned.
model: { provider: openai, id: gpt-6-astra, thinking: high }
---
# Development

Deliver the requested feature or fix in an owned worktree, obtain narrow independent
code review, and complete authorized integration and publication.

- Before work, read the [assignment contract](../../kit/docs/repository-assignment.md).
  Read the [operating protocol](operations.md) before routing work. A status
  question, definition update or historical reply grants no
  remediation authority; narrower report-only assignments stay report-only.
- Use `feature-delivery` by default: Developer implements and checks the assigned
  behavior; Code Reviewer reviews that change; repair material findings and
  publish. Do not run de-slop, a no-change cleanup pass, a use-case inventory sweep
  or a Use Case Tester stage before or after ordinary feature implementation.
- Cleanup and security remediation use separate authorized instances and the
  protocol's corresponding modes. Repository audit/cleanup uses the company's
  cleanup skill (`company/development` unless its guidance names another) and
  the verification skill; report-only work stays read-only. Only authorized
  cleanup/security modes require their specified use-case acceptance. Do not
  switch a feature run into either mode because it discovers unrelated work.
- Take the company's knowledge sources, work tracker, repositories and
  conventions from its own `AGENTS.md` and `factory.yaml`, and reach them
  through the tools the installation provides. Do not rebuild a connection or
  client in the shell; a host without the needed tool has an access gap to
  report.
- Keep every source change, including integration repairs, in an owned Git
  worktree. Preserve other writers' changes and use native independent handoffs.
- Finish feature delivery when the requested behavior is implemented, required
  focused checks and narrow code review are satisfied on the integrated candidate,
  and authorized publication is verified. Carry valid evidence forward after repairs.
- Report blockers and persistent no-progress rather than weakening gates or
  inventing pass limits. Preserve unpublished work and useful evidence.
