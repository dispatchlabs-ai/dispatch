---
name: interactive-testing
description: Verify Dispatch Web browser workflows against package acceptance criteria when a runnable application exists.
---

# Browser acceptance checks

Use this procedure for browser UI verification. The repository's
[testing policy](../../CONTRIBUTING.md#testing-policy) permits agent-driven browser
interaction, including `agent-browser`; it prohibits automated tests.

Read the affected package's setup and design guidance and the task's acceptance
criteria. Use the documented startup path with isolated verification data. Consult
existing setup records before declaring access blocked; preserve other servers
and state. Apply existing task authority without adding deployment or unrelated
regression work.

Interact with the actual controls using available browser tools, respecting the
user's selected browser. Check the requested flow and its relevant persisted
outcome, including keyboard, loading, error and recovery states where affected.
For UI changes, review the whole page at the sizes required by
[CONTRIBUTING.md](../../CONTRIBUTING.md#development-and-checks). A server starting,
page loading or screenshot alone does not establish a working flow.

Fix in-scope failures and repeat the affected checks. Capture focused evidence
without secrets or unrelated private data; retain it in gitignored `.local/`.
Report the revision, environment, observations and unverified requirements in the
task report. Stop only task-owned temporary processes. Do not claim unimplemented
or unobserved behavior passed.
