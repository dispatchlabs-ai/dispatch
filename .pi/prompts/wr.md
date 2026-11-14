---
description: Finish the current task with checks, documentation, commit, and verified publication
argument-hint: "[completion instructions]"
---

Finish the current task. Additional instructions: $ARGUMENTS

Use the conversation and current diff to establish scope. Carry forward existing
authorization for completion; this prompt adds no feature, release or deployment
scope. Follow [CONTRIBUTING.md](../../CONTRIBUTING.md) for checks and publication.

- Complete the agreed work and resolve in-scope failures. For implementation,
  apply [deslop.md](deslop.md). Update affected package documentation and changelogs
  where the change warrants it; historical handoffs are not a second specification.
- Run checks appropriate to the change. Documentation-only work needs whitespace
  and affected-link checks. Browser UI work uses the
  [interactive procedure](../skills/interactive-testing.md). Do not add or run
  automated tests. Retain actual results and unmet requirements in the task report.
- Inspect the full diff and staged/outgoing content for unrelated changes and
  private data. Commit explicit task paths, preserving other work. Fetch and
  reconcile the publication target under the repository's integration lock, then
  verify the resulting candidate and push normally. Use a PR when requested or
  required; never force-push over another update.
- Verify publication and safely synchronize the canonical checkout. When the task
  includes local application delivery, coordinate any required restart and verify
  the running revision and affected behavior. For UI delivery, inspect it in the
  browser. Keep source publication and deployment outcomes distinct.

Report the result, checks, published revision or PR, and remaining gaps. A source
push does not establish a release or deployment. External comments, issue changes,
merging a requested PR and deployment need authority for those actions; reuse any
already given. Do not infer issue closure merely from an issue being mentioned.
