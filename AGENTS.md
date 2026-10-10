# Repository guidance

- Use the startup and check commands in [CONTRIBUTING.md](CONTRIBUTING.md).
- Follow the [testing policy](packages/web/docs/spec.md#testing-policy): do not add or run automated tests. AI-agent interactive verification using `agent-browser` is permitted; use source review, TypeScript and build checks too. Future coverage prioritizes stable end-to-end and API behavior.
- Before changing behavior, read the affected package's `docs/spec.md` and `docs/handoff.md`, and the relevant use cases and decisions linked from the [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/).
- Before changing browser UI, read the spec's [UI implementation rules](packages/web/docs/spec.md#ui-implementation-rules). Report any rule you did not meet or check as a deviation or as unverified; never describe it as done.
- Review UI on rendered desktop and 390 px phone screens, not from source alone. If you cannot sign in, ask Chris or the coordinator for captures. Keep captures in the gitignored `.local/`, and never commit ones that show account data. Still images do not verify keyboard, touch, or recovery flows.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for development and publication. Implement the current agreed work package, verify its acceptance criteria, then review with Chris before proceeding to the next.
- Use the [agent workflow index](CONTRIBUTING.md#agent-workflows) to find reusable prompts and procedures. Read only those relevant to the current task; agents outside Pi can follow the same Markdown files directly.
- Before completing an implementation package, apply the behavior-preserving review in [.pi/prompts/deslop.md](.pi/prompts/deslop.md). AI agents may use `agent-browser` for interactive verification of authorized work without a testing-policy exception. Use the release procedure for release work.
- Keep specifications, handoffs, usage guides, changelogs, and code with their owning package. Root files contain repository-wide guidance and tooling.
- Put build checks and outstanding acceptance evidence in work-package acceptance criteria; do not create a separate validation plan.
- Keep draft decisions and unresolved contracts explicitly labeled. Use stock Pi Durable's public interfaces and preserve its ownership of durable execution and recovery.
