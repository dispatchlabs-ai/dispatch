---
description: Review a PR against its contracts, implementation, and validation
argument-hint: "<PR URL or number>"
---

Review: $ARGUMENTS

1. Read `AGENTS.md`, `CONTRIBUTING.md`, the PR description, discussion, commits, changed files, and relevant linked issues. Record the base and head revisions being reviewed.
2. Inspect the diff and full affected files, including related callers and implementation paths needed to judge behavior. Use fetched refs and `git show`/`git diff`, or a separate review worktree; do not switch or disturb a checkout owned by another task.
3. Compare the change with package specifications, the current authorized task's scope and acceptance criteria and relevant repo-local decisions. Check state ownership, failure/recovery behavior, and the boundary with stock Pi Durable where affected.
4. Assess tests against the outcomes they should prove. Identify a plausible broken implementation each important test should reject. Run appropriate existing checks when the review environment supports them; distinguish observed results from reported CI results and unrun checks.
5. Check whether package README, specification, linked supporting documents, usage examples, or changelog need corresponding updates. Flag unsupported claims and unresolved decisions presented as settled behavior.

Lead with concrete findings, ordered by impact, with file locations, a failing scenario, and why the behavior matters. Follow with a short account of the change, test coverage and gaps, and any decisions blocking acceptance. If no actionable findings exist, say so without inventing problems.

Return the review in the current conversation. Do not edit the implementation, post the review, change labels, merge, or close the PR unless separately authorized.
