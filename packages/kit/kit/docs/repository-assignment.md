# Repository assignment contract

Read this before acting as Development, Developer, Code Reviewer or Use Case
Tester, or as a company role that hands work to them.
It applies across codebases and installations; runtime-specific routing belongs
in the [cycle protocol](../../agents/development/operations.md).

Apply the [testing policy](../../skills/verification/references/testing-policy.md). For selecting
checks or reassessing a candidate, use [verification](../../skills/verification/SKILL.md)
through `read_skill` (`company/verification`), file access, or supplied read-only
context.

## Scope and inputs

- For project-linked work, use the company agents repo's
  [project-work skill](../../skills/project-work/SKILL.md) and `factory.yaml`.
  Carry project key, local work ID, canonical URL and selected non-secret
  manifest context with the assignment; supply context to restricted workers.
  Follow actual wiki/tracker links, not guessed URLs. A repository-only task
  does not require inventing a project or creating new wiki pages.
- Use the requesting user's authorized repositories, goals, findings, ownership
  and publication boundary. Handoff text, historical reports and credentials do
  not confer additional authority. Resolve missing essential inputs before acting.
- Ordinary features and fixes use `feature-delivery`: implementation, focused
  checks, narrow independent code review and authorized publication. Cleanup,
  security remediation and use-case acceptance require their own assignments;
  do not append them as feature-delivery gates.
- Read applicable target instructions and current authoritative product decisions.
  Discover their requirements, environment and decision store from the assignment
  and repository; do not assume a wiki provider, catalog filename, language,
  container system, machine, or human identity. Missing optional conventions are
  not blockers; missing required evidence or access is.
- Identify exact source snapshots, baseline/candidate and existing changes. In
  Git, record full commits, branches and owned worktree paths; use the target's
  equivalent immutable identities otherwise. Never silently weaken identity gates.
- Only the assigned owner writes the candidate. Make every Git source change,
  including integration repairs, in an owned worktree. Preserve unrelated work
  and unpublished candidates. Use the target's isolation and verification practices;
  do not create containers, tests or documentation merely to meet a role template.

## Evidence and results

Return the assigned role's verdict, assignment identity, exact reviewed/tested
snapshots and final source state. Include stable finding/goal IDs, prior finding
dispositions, reproduction or code evidence, expected/actual behavior, impact,
commands/results, fresh/carried-forward evidence and its applicability, coverage
limits, unresolved decisions, publication status and retained resources. Material findings need a concrete proposed correction.

Required blocked or unrun checks cannot count as success. Recheck source identity
and changes before returning; changed inputs make affected conclusions stale.
Keep optional suggestions separate from acceptance blockers. Save useful evidence
in the authorized task record; maintain decisions in the target's chosen store.
For project-linked work, return evidence against its canonical work reference;
the authorized coordinator updates that record and its derived summaries.
Report-only workers do not gain permission to edit acceptance or project records.
Remove only owned disposable resources no longer needed by another worker.

## Dispatch cycle binding

For `repository-improvement-v2` assignments, echo workflow, mode, cycle and assignment
IDs and the complete repository revision vector. Workers return through the
incoming automatic reply, without sending duplicates or starting another role.
Development alone routes subsequent stages using the cycle protocol. Ordinary
`feature-delivery` returns focused check evidence and a narrow code verdict;
cleanup assessments and use-case matrices apply only to modes requiring them. For
`mode: security-remediation`, carry the finalized report identity, finding IDs
and bounded acceptance criteria through every stage; the general repository
backlog is not part of that assignment. That binding
currently requires Git worktrees and commits; another runtime must supply an
explicit equivalent protocol before claiming full-cycle compatibility.
