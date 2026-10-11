---
description: Simplify a completed work package without changing its intended behavior
argument-hint: "[work package or focus]"
---

Review the completed work package for avoidable complexity. Focus: $ARGUMENTS

Read `AGENTS.md`, the applicable package specification and relevant linked guidance. Use the current authorized task's agreed outcomes; historical handoffs are evidence, not current scope. Use the current task's diff to establish scope, then read the affected files and relevant callers, tests, and interfaces in full. Keep unrelated cleanup out of the task.

Look for simpler representations and direct code:

- Remove duplication, redundant state, and trivial indirection when their purpose can be expressed clearly in the existing design.
- Question generic machinery, configuration, adapters, and extension points with no accepted use case.
- Put validation at actual trust boundaries. Within trusted code, use precise types and established invariants instead of speculative fallbacks for impossible states.
- Preserve explanations of intent and constraints; remove comments that only narrate obvious code.
- For UI changes, keep routine UI copy concise: no long explanatory sentences or paragraphs in routine UI. Prefer concise labels and actionable status/error text; put detailed explanations in documentation. Preserve user-authored content.
- Keep stock Pi Durable responsible for durable execution and recovery. Simplification must preserve the specified application/runtime boundary.

Preserve supported behavior, public contracts, persisted data, security checks, and meaningful failure handling. Before removing something apparently unused, check its callers, documentation, generated entry points, and extension/compatibility role. Do not weaken tests to make a simplification pass or introduce an abstraction just to reduce line count.

Make routine behavior-preserving changes within the authorized scope. For a material removal or behavior change, use any explicit authorization already given; otherwise present the specific change, evidence, affected contract, and recommendation for Chris's decision before applying it. An uncertain purpose is a reason to investigate, not to delete.

Run the applicable checks from `CONTRIBUTING.md` and the current task's agreed acceptance criteria. Inspect the final diff for accidental changes. Report what became simpler, the invariants it relies on, validation results, and any unresolved decisions. Passing checks alone does not establish that the design is easier to understand.
