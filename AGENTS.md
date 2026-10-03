# Repository guidance

- Use the startup and check commands in [CONTRIBUTING.md](CONTRIBUTING.md).
- Do not add or run tests at this stage. Chris requested zero tests on October 3, 2026; use source review, TypeScript, and build checks until he changes this rule. Later coverage should focus on end-to-end and API tests for stable behavior; see the [testing policy](packages/web/docs/spec.md#testing-policy).
- Before changing behavior, read the affected package's `docs/spec.md` and `docs/handoff.md`, and the relevant use cases and decisions linked from the [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/).
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for development and publication. Implement the current agreed work package, verify its acceptance criteria, then review with Chris before proceeding to the next.
- Use the [agent workflow index](CONTRIBUTING.md#agent-workflows) to find reusable prompts and procedures. Read only those relevant to the current task; agents outside Pi can follow the same Markdown files directly.
- Before completing an implementation package, apply the behavior-preserving review in [.pi/prompts/deslop.md](.pi/prompts/deslop.md). Do not run the linked interactive-testing procedure while the zero-tests rule is active. Use the release procedure for release work.
- Keep specifications, handoffs, usage guides, changelogs, and code with their owning package. Root files contain repository-wide guidance and tooling.
- Put build checks and outstanding acceptance evidence in work-package acceptance criteria; do not create a separate validation plan.
- Keep draft decisions and unresolved contracts explicitly labeled. Use stock Pi Durable's public interfaces and preserve its ownership of durable execution and recovery.
