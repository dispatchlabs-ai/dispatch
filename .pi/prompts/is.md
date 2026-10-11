---
description: Investigate an issue and propose a verified approach
argument-hint: "<issue URL, number, or description>"
---

Investigate: $ARGUMENTS

1. Read `AGENTS.md`, `CONTRIBUTING.md`, the full issue and discussion, and relevant linked issues or PRs. Identify the repository and current revision. Treat reported causes and proposed implementations as hypotheses.
2. Read the affected package's specification, handoff and relevant repo-local decisions. Separate an implementation defect from a proposed change to intended behavior. A draft or missing contract is not an accepted decision.
3. Read the relevant code and trace the actual execution path. Reproduce a reported defect with existing checks or the smallest useful example when possible. State when no implementation exists or reproduction is unavailable.
4. For a bug, explain expected versus observed behavior, the supported cause, and a focused correction. For a feature, describe the user outcome, affected contracts, simplest implementation approach, and unresolved product decisions.
5. Identify affected files, necessary acceptance checks, and any tests that would fail for the current defect or an incorrect implementation. Keep implementation work bounded to the agreed package.

Return the evidence, proposed approach, validation plan within the work package, and only the questions that require a new decision. This prompt requests analysis; implement only when the user has also authorized implementation. Do not post comments, assign issues, or change labels/state merely because an issue was supplied.
