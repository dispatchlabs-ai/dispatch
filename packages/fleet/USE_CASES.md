# Fleet use cases

This catalog records intended outcomes; package availability and installation
qualification remain separate from scope.

## 1. Existing fleet goals

- **FLEET-001 — Run independent durable workflows:** an installation admits complete
  native runs on replaceable workers while retaining company and transport authority.
- **FLEET-002 — Resume on another host:** fence the previous writer, retain native
  history/source/artifacts, and recover the same immutable application and image.
- **FLEET-003 — Change capacity:** add/remove workers based on observed pressure,
  move work to spare capacity, and gracefully release a terminating host.
- **FLEET-004 — Stop work:** distinguish suspension, durable cancellation and
  verified completion; uncertain release retains ownership until fencing.
- **FLEET-005 — Bind transports:** keep Slack or another transport's credentials
  on the coordinator and acknowledge remote events after retaining delivery receipts.

## 2. Portable deployment additions

Accepted November 9, 2026; these extend the current EC2 fleet's intended scope.

- **FLEET-006 — Consume reusable infrastructure:** An operator deploys an
  independent agent installation from its own infrastructure repository using
  centrally maintained, versioned Terraform/OpenTofu modules and selected
  Dispatch releases.
- **FLEET-007 — Choose execution providers:** An operator places complete durable
  runs on supported servers or sandbox providers while preserving the agent
  principal, durable work identity and recovery guarantees.

The [ownership direction](../runner/docs/definition-workspaces.md#accepted-portable-agent-direction)
keeps module implementations in shared infrastructure repositories and installation
configuration, state and credentials with each consumer.
