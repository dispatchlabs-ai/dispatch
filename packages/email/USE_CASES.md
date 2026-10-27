# Email use cases

## Intended behavior

These approved requirements describe email as a communication channel for any
selected agent, not a separate agent runtime. They are not a claim that the
current Gmail adapter implements every requirement.

- **EMAIL-001 — Expose any agent:** configure email access for any existing agent
  without hardcoding agent names, roles or organization-specific behavior.
- **EMAIL-002 — Trigger work from incoming mail:** receive email addressed to a
  configured agent and admit it as work in that agent's existing durable runtime.
- **EMAIL-003 — Communicate by email:** let configured agents send email and
  respond to received messages, not only return one final answer to the original
  sender. Email is a channel, not a prescribed task workflow.
- **EMAIL-004 — Enable responses deliberately:** keep outbound sending disabled
  until explicitly configured and enabled for that agent. Receiving work and
  permission to send are separate; exposing an inbox must not automatically
  enable responses.
- **EMAIL-005 — Exchange rich content:** receive and send plain text, HTML and
  attachments without invented attachment-size, file-count, filename-length or
  content-truncation limits.
- **EMAIL-006 — Retain native state:** use the existing SQLite-backed
  conversations, task ownership and recovery rather than introduce another
  source of agent state. Email presentation need not mirror every event shown
  in other channels.
- **EMAIL-007 — Keep mail organized:** file every received and sent message under
  the appropriate folder or label, including mail not routed to an agent.

## Boundaries

The setup/enablement gate is the intended rollout restriction. Do not make
sender allowlists, single-agent addressing, sender-only replies or reply-only
sending mandatory product restrictions. Preserve existing agent permissions,
credential protection and file integrity. Actual provider and host constraints
must be reported accurately, not replaced with arbitrary application caps.

## Implementation status

The [Gmail adapter](docs/gmail.md) implements these channel contracts in this
package, using Runner's native owner. The former Runner entry point remains a
compatibility forwarder. Live installation qualification and provider-specific
constraints are separate from source/build checks; see the guide's qualification
section. No deployment or sending activation is implied by these requirements.
