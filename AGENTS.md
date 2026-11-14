# Repository guidance

- Use [CONTRIBUTING.md](CONTRIBUTING.md) for startup, checks and publication,
  and [OSS.md](OSS.md) for public package standards. Keep private data out of
  source, history and artifacts; review staged and outgoing content before publishing.
- Work in a task worktree from the freshly fetched target. Safely synchronize the
  canonical checkout before work and after publication; preserve unrelated edits
  and commits and coordinate with active owners.
- Read affected package contracts when changing behavior. Historical handoffs are
  evidence, not current scope; label draft decisions and unresolved requirements.
  Keep code, specifications, guides and changelogs with their owning package.
- Use stock Pi Durable's public interfaces for durable execution and recovery.
  For package structure or publishing changes, inspect the pinned Pi source using
  [the packaging reference](CONTRIBUTING.md#pi-as-the-packaging-reference).
- Follow the [testing policy](CONTRIBUTING.md#testing-policy): no automated tests.
  Use the source/type/build checks and real interactions appropriate to the change.
  Record observed results and gaps in the task report, not a separate validation plan.
- For browser UI changes, use the affected package's design guide and
  [browser verification procedure](.pi/skills/interactive-testing.md).
  Web's current guide is [packages/web/DESIGN_GUIDE.md](packages/web/DESIGN_GUIDE.md).
- Before completing an implementation, apply [deslop.md](.pi/prompts/deslop.md).
  Read other [workflow prompts](CONTRIBUTING.md#agent-workflows) only when relevant;
  the Markdown procedures also work outside Pi.
- For an authorized release, follow [release.md](.pi/skills/release.md) through
  publication and documentation without asking again at every step. Report specific
  access blockers and continue unblocked channels. Release authority does not
  itself authorize live deployment.
- When writing agent instructions, including `agent.md`, skills and runtime prompts,
  follow the [instruction authoring guide](packages/runner/docs/instructions.md).
