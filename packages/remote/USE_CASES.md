# Use cases

This package provides an optional storage transport for application-owned runners.
Check marks require runtime evidence in addition to source/build checks.

- [x] REM-001 — An operator keeps native Pi state on a separate SQLite host while models and tools execute on the runner.
- [x] REM-002 — A runner retries a storage request after a lost reply without repeating its committed write or ID allocation.
- [ ] REM-003 — An operator grants a runner named stores without granting arbitrary database or SQL access.
- [x] REM-004 — An operator rejects competing runner sessions and explicitly retires a stopped owner before recovery.
- [ ] REM-005 — Independent logical stores serve independent runners without a global execution limit.

Manual verification on macOS ARM64, October 23, 2026, exercised a real model
and native coding tool through an application relay, duplicate admission,
withdrawal, a lost mutation reply, competing owners, storage-service restart,
and explicit retirement after an isolated runner exited. Reopening an active
conversation retained its request identity and reported the interrupted shell
tool through native Pi recovery. This does not establish exactly-once external
effects, multi-runner load qualification, or Windows storage support.

A physical mobile client subsequently completed a model → filesystem tool →
model turn with the runner on macOS ARM64 and SQLite on a separate Linux host,
through the deployed authenticated relay. This verifies the split-host path;
the package remains an application-integrated source snapshot.
