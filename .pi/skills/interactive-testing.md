---
name: interactive-testing
description: Verify Dispatch Web browser workflows against package acceptance criteria when a runnable application exists.
---

# Browser acceptance checks

The [testing policy](../../CONTRIBUTING.md#testing-policy) permits AI agents to use `agent-browser` for interactive verification of authorized work without a separate exception. Do not add or run automated tests; loading this skill does not authorize regression coverage, deployment or live-state disruption. Read `AGENTS.md`, `CONTRIBUTING.md`, the affected package README and specification, and the current authorized task's acceptance criteria. The local frontend startup and build commands are documented in the package README; documentation checks do not count as browser validation.

1. Identify the supported startup command, environment, test data, and application URL from the package's actual setup documentation. Inspect the implementation and maintained setup records before declaring a blocker. If setup is still undefined, report which criteria cannot yet be exercised; do not fabricate commands, services, or passing results.
2. Translate the agreed criteria into concrete observations: starting state, user action, expected visible result, and relevant persisted outcome. Cover specified failure and recovery paths as well as success. Keep this evidence in the task report or relevant linked supporting document, without introducing a separate validation-plan document.
3. Run the permitted type/build checks appropriate to the change; do not add or run automated tests. Start or use the documented application environment with isolated verification data. Do not disturb another task's server or state.
4. Use the available browser tools to perform the workflow. Prefer the built-in browser unless an existing browser session is required. Interact with the actual controls and verify results; a server starting or a page loading is not a completed acceptance check.
5. Check the affected states that the specification requires, including keyboard interaction, loading/empty/error states, navigation, reload, or recovery when applicable. Inspect relevant console/network errors to explain failures. Capture screenshots or other focused evidence when they help establish the result; avoid retaining secrets or unrelated private content.
6. Fix in-scope defects and rerun the affected checks. Compare each observation to the criterion rather than changing expected behavior to match the implementation.

Report the tested revision and environment, criteria passed/failed/not exercised, meaningful evidence, and remaining limitations. Stop only task-owned temporary processes when finished. Update reusable test coverage only when separately authorized by that policy; do not claim unimplemented workflows were tested.
