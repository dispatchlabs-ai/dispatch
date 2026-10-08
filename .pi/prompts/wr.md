---
description: Finish the current task with checks, documentation, commit, and verified publication
argument-hint: "[completion instructions]"
---

Finish the current task. Additional instructions: $ARGUMENTS

Use the conversation and current diff to establish the authorized scope and any existing issue or PR context. Read `AGENTS.md` and `CONTRIBUTING.md`; carry forward existing authorization instead of asking again for routine completion steps.

1. Complete the agreed work and resolve actionable blockers. For an implementation package, apply the behavior-preserving review in [deslop.md](deslop.md).
2. Update affected package specifications, handoff status, usage documentation, and changelog where appropriate. Keep maintained wiki decisions aligned with authorized behavior changes. Record unresolved decisions honestly; do not mark acceptance criteria satisfied without evidence.
3. Run the documented checks and inspect the full diff. At the documentation-only stage, use the whitespace and local-link checks in `CONTRIBUTING.md`; do not invent application test results. Use the [interactive-testing procedure](../skills/interactive-testing.md) only when the package testing policy explicitly authorizes the affected browser checks.
4. Stage explicit task-related paths and commit all task changes. Preserve unrelated edits and other tasks' work. Apply the repository's worktree and serialized-integration policy.
5. Fetch the latest publication target, reconcile the candidate, and validate the resulting revision. Follow an explicitly requested PR route; otherwise push the task candidate normally to remote `main` as `CONTRIBUTING.md` specifies. A moving target requires reconciliation and validation, never a force push.
6. Verify the published commit or PR. Fast-forward a clean canonical checkout when it can be synchronized safely; preserve dirty or unpublished work. Keep pushed, merged, synchronized, and deployed outcomes distinct.
7. Report the result, validation, published revision or PR, and remaining blockers. Present the completed package for Chris's review before starting the next one.

Git publication is covered by the repository workflow. Post external comments, change issue state, merge a requested PR, or deploy only when those actions are also authorized. Never infer an issue-closing commit message solely from an issue being mentioned. Do not claim release or deployment from a successful source push.
