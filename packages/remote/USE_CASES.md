# Use cases

This catalog records intended storage and connectivity outcomes for
application-owned runners; qualification evidence is recorded separately below.

## 1. Existing storage transport goals

- **REM-001 — Separate state from execution:** An operator keeps native Pi state on a separate SQLite host while models and tools execute on the runner.
- **REM-002 — Recover a lost storage reply:** A runner retries a storage request after a lost reply without repeating its committed write or ID allocation.
- **REM-003 — Grant named stores:** An operator grants a runner named stores without granting arbitrary database or SQL access.
- **REM-004 — Preserve execution ownership:** An operator rejects competing runner sessions and explicitly retires a stopped owner before recovery.
- **REM-005 — Serve independent runners:** Independent logical stores serve independent runners without a global execution limit.

## 2. Portable service additions

Accepted November 9, 2026; these goals do not describe the current SQLite
package's availability or change its existing ownership contract.

- **REM-006 — Use central PostgreSQL state:** An operator keeps native durable
  state behind an authenticated service while workers access that state without
  database credentials or direct database connectivity.
- **REM-007 — Connect from ephemeral hosts:** A worker receives commands, reports
  progress and persists state through worker-initiated connections without
  requiring an inbound application port or a shared database filesystem.

See the [portable-agent direction](../runner/docs/definition-workspaces.md#accepted-portable-agent-direction)
for the existing PostgreSQL foundation, integration boundary and recovery limits.

## 3. Qualification evidence

Manual verification on macOS ARM64, October 23, 2026, exercised a real model
and native coding tool through an application relay, duplicate admission,
withdrawal, a lost mutation reply, competing owners, storage-service restart,
and explicit retirement after an isolated runner exited. Reopening an active
conversation retained its request identity and reported the interrupted shell
tool through native Pi recovery. This does not establish exactly-once external
effects, multi-runner load qualification, or Windows storage support.
Named-store grants (REM-003) and independent-runner qualification (REM-005)
remain unverified by these observations.

A physical mobile client subsequently completed a model → filesystem tool →
model turn with the runner on macOS ARM64 and SQLite on a separate Linux host,
through the deployed authenticated relay. This verifies the split-host path;
the package remains an application-integrated source snapshot.
