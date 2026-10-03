# Repository guidance

- This is a design-stage Dispatch Web rebuild using stock Pi Durable. No build, application, or test commands exist yet.
- Before changing behavior, read the affected package's `docs/spec.md` and `docs/handoff.md`, and the relevant use cases and decisions linked from the [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/).
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for development and publication. Implement the current agreed work package, verify its acceptance criteria, then review with Chris before proceeding to the next.
- Use the [agent workflow index](CONTRIBUTING.md#agent-workflows) to find reusable prompts and procedures. Read only those relevant to the current task; agents outside Pi can follow the same Markdown files directly.
- Before completing an implementation package, apply the behavior-preserving review in [.pi/prompts/deslop.md](.pi/prompts/deslop.md). Use the linked interactive-testing procedure for browser acceptance checks and the release procedure for release work.
- Keep specifications, handoffs, usage guides, changelogs, code, and tests with their owning package. Root files contain repository-wide guidance and tooling.
- Put validation in work-package acceptance criteria and package tests; do not create a separate validation plan.
- Keep draft decisions and unresolved contracts explicitly labeled. Use stock Pi Durable's public interfaces and preserve its ownership of durable execution and recovery.
