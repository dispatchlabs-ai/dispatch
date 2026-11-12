---
name: development
description: Perform use-case-preserving repository cleanup under the target's removal policy; report size, dependencies and verification. Not routine feature development.
---

# Development cleanup

Preserve the product, not unnecessary scaffolding. Honor narrower scopes;
audit/count-only requests stay read-only.

- Establish intended workflows from authoritative requirements and decisions.
  Read [use-case conventions](references/use-cases.md) before changing a catalog;
  preserve the target's format and location rather than creating a parallel one.
- Establish the target's removal policy. Remove demonstrated obsolete or surplus
  code, artifacts and dependencies within scope. Assess tests, benchmarks and
  fixtures under the testing policy of `company/verification`;
  remove authorized low-value checks with their orphaned scripts, hooks and dependencies.
  Preserve required operational instructions, contracts, licenses, runtime data
  and evidence; fewer retained lines alone do not establish lower total cost.
- Count tracked physical lines by production, tests, docs, recorded artifacts,
  tooling/configuration and lockfiles; exclude installed dependencies/build output.
  Report remaining direct dependencies and purposes separately from transitives.
- Preserve supported interfaces and accepted decisions. Missing usage evidence is
  not permission to remove a capability. Do not rewrite version-control history.
- Maintain existing API contracts when affected. If OpenAPI work is required,
  read [OpenAPI guidance](references/openapi.md); do not introduce a new specification
  format just because this skill supports it.
- Verify setup and representative behavior in the target's supported environment.
  Only when Dev Containers are used or requested, read [container guidance](references/dev-containers.md).
  A repository without containers does not need one merely for cleanup.
- Run appropriate builds and behavioral checks under the target's test policy.
  Prefer focused disposable checks over new retained test machinery. Follow its
  publication policy, update affected decisions in its chosen store, recount
  consistently, and report verification gaps and remaining bulk.
