# Repository guidance

- Use the startup and check commands in [CONTRIBUTING.md](CONTRIBUTING.md).
- Follow the [testing policy](CONTRIBUTING.md#testing-policy): do not add or run automated tests. AI-agent interactive verification using `agent-browser` is permitted; use source review, TypeScript and build checks too. Future coverage prioritizes stable end-to-end and API behavior.
- Before changing behavior, read current authoritative project intent and relevant affected-package documentation. Historical handoffs are supporting evidence, not a second product specification.
- Dispatch Web project intent lives only in the database. Use `conversation_project_spec` for this chat's project; read the returned revision and continue with that revision/nextOffset until complete. The repo [spec-access pointer](packages/web/docs/spec.md) is not a requirements body, export or editing source. Reading intent does not authorize its backlog.
- Before changing browser UI, read relevant repo-local UI guidance and review records. Report requirements you did not meet or check as deviations or unverified; never describe them as done.
- Review UI on rendered desktop and 390 px phone screens, not from source alone. If you cannot sign in, ask Chris or the coordinator for captures. Keep captures in the gitignored `.local/`, and never commit ones that show account data. Still images do not verify keyboard, touch, or recovery flows.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for development and publication. Complete the current authorized task, verify its agreed outcomes, then review with Chris before starting further work.
- Use the [agent workflow index](CONTRIBUTING.md#agent-workflows) to find reusable prompts and procedures. Read only those relevant to the current task; agents outside Pi can follow the same Markdown files directly.
- Before completing an implementation package, apply the behavior-preserving review in [.pi/prompts/deslop.md](.pi/prompts/deslop.md). AI agents may use `agent-browser` for interactive verification of authorized work without a testing-policy exception. Use the release procedure for release work.
- Keep specifications, handoffs, usage guides, changelogs, and code with their owning package. Root files contain repository-wide guidance and tooling.
- Record checks and outstanding acceptance evidence in the task report or relevant linked supporting document; do not create a separate validation plan.
- Keep draft decisions and unresolved contracts explicitly labeled. Use stock Pi Durable's public interfaces and preserve its ownership of durable execution and recovery.
