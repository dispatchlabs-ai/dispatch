# Use-case conventions

The target's authoritative use-case catalog (for example, `USE_CASES.md`) is the behavioral contract: preserve product decisions, give agents development goals, and guide verification through the actual product. It is not an inventory of passing code.

## Catalog

- Group related workflows. Give each case a stable ID, short goal title, and one concise sentence naming the actor and intended outcome. Actors may be people, agents or other systems.
- Cover all meaningful intended workflows, including accepted but unimplemented goals. Preserve IDs and supported outcomes when implementations change.
- Distinguish supported, planned, excluded, undecided and retired scope. Track implementation and verification separately; a broken commitment remains a gap, not an automatic retirement.
- Keep rationale, history and verification evidence in the project's existing durable records, separate from the terse catalog. No particular service or new documentation hierarchy is required.

## Preservation

Current product decisions and the user's request establish intent. Code and historical discussions are evidence, not permission to redefine it. Resolve uncertain scope before deleting affected capabilities.

Before capability removal, inspect actual logs and telemetry; record environment, time window, attribution and coverage limits. Missing instrumentation, stale feeds or no hits alone do not prove disuse. Preserve supported workflows unless their removal is specifically authorized.
