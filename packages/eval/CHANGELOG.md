# Changelog

## [Unreleased]

## [0.10.0] - 2026-11-12

- Add the evaluation package. `dispatch.lib.mkAgentRelease { withEval = true; }` installs `bin/dispatch-eval`: a read-only native record reader (`records`), one step of one use-case package in a native session (`run`: collect or rerun, grade, publish), the engine's commands (`engine`: `plan-run`, `compare`, `status`, `agreement`, `publish`, `report`, `runs`) and a store converter (`convert`). The session's owner is a built-in agent, so a company repository supplies only use-case packages and bindings. Definitions can import `@dispatch/eval/grading`, `@dispatch/eval/records` and `@dispatch/eval/task`.
- The engine is the Python project `dispatch_eval`. Its store is at schema version 2: units carry domain attributes as `labels` JSON, and `convert` upgrades a schema-1 store with every row ID kept.
- Enforced: speed is not compared between runs whose clock kinds differ or are unrecorded; runs on different Dispatch revisions or Pi Durable versions are marked not comparable and are not continued on another runtime; a dirty or unrecorded build labels its runs, assessments and reports as development evidence; inspection copies of stores are owner-only and removed by the step that made them.
- A synthetic example package and rule-based grader run the whole path without credentials or model calls.
