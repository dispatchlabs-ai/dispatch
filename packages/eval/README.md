# Dispatch Eval

Evaluation of Pi Durable agents that any company's agent repository gets by pinning a Dispatch release. The package
holds the parts every evaluation shares; a company keeps only its **use-case packages**: what a unit is, the rubric,
where evidence comes from and, for reruns, the cases and the target.

It answers two questions, kept distinct:

- **Retained runs:** how good was work that already happened? Graded from its records. No agent is rerun and no
  effect is repeated.
- **Controlled reruns:** does changing one thing (a model, a thinking level, instructions) make the agent better?
  Fixed cases through a target under the same frozen rubric. Only for agents with a safe, repeatable test
  environment.

For companies that build their agent release with the [shared Nix builder](../runner/docs/nix-releases.md). Source
alpha, versioned in lockstep with Dispatch and not published to npm. The grading it produces is provisional until it
has been checked against a person's judgment.

## Contents

| Path | Role |
| --- | --- |
| [src/records.ts](src/records.ts) | Read-only reader for native Pi Durable stores. |
| [src/grading.ts](src/grading.ts) | The native grading loop: each extraction or judgment in its own tool-less conversation, stable request IDs, recovery. |
| [src/task.ts](src/task.ts) | The native task for one step of one package: collect or run, grade, publish. |
| [src/cli.ts](src/cli.ts) | `dispatch-eval`, the one entry point. |
| [definitions/](definitions/agents/dispatch-eval/agent.md) | The built-in agent that owns an evaluation's native session. |
| [engine/](engine/dispatch_eval/engine.py) | The runtime-independent engine (Python project `dispatch_eval`, with its lockfile): store, versions, grading protocol, reruns, comparison, report. |
| [example/](example/package/usecase.py) | A synthetic use-case package and a synthetic grader. |

## First result

From a Dispatch checkout, build the example release and run the synthetic package. It needs no credentials and
makes no model call: the grader is a [rule-based provider](example/synthetic-grader.mjs) and the "agent" is recorded
or generated text about a fictional atlas.

```sh
nix build .#checks.SYSTEM.eval-release        # SYSTEM such as x86_64-linux or aarch64-darwin
E=$(readlink -f result)/lib/eval-example/eval/example
W=$(mktemp -d)
cat > "$W/host.json" <<JSON
{ "stateRoot": "$W/state", "cwd": "$W", "namespace": "eval-example",
  "modelProviders": [{ "module": "$E/synthetic-grader.mjs", "export": "syntheticGrader" }] }
JSON
cat > "$W/bindings.json" <<JSON
{ "version": 1, "dataDir": "$W/data", "workbook": "$W/report.xlsx", "billingRoute": "none: synthetic grader and target" }
JSON
./result/bin/dispatch-eval run --config "$W/host.json" --package "$E/package" --bindings "$W/bindings.json" --collect
```

The last line printed is an `eval_finished` event whose outcome is `completed`, with `"units":3`, `"graded":12`
(three requirement extractions and nine judgments) and
`"agreement":"3 units repeated; 6/6 closed items identical (100%)"`. `$W/report.xlsx` is the report. Running the
same command again resumes: `"new_or_changed":0` and `"graded":0`.

Then compare two variants of the synthetic target:

```sh
EV() { ./result/bin/dispatch-eval engine --package "$E/package" --bindings "$W/bindings.json" "$@"; }
EV plan-run --run brief --variant '{"style":"brief"}' --repeats 2
EV plan-run --run thorough --variant '{"style":"thorough"}' --repeats 2
for RUN in brief thorough; do
  ./result/bin/dispatch-eval run --config "$W/host.json" --package "$E/package" --bindings "$W/bindings.json" --run $RUN
done
EV compare --runs brief,thorough
EV report
```

`compare` prints the comparison rows; `report` prints every sheet of the workbook as JSON. A release built from a
working tree with uncommitted changes labels all of it `DEVELOPMENT EVIDENCE`.

## Using it from a company repository

Opt in where the release is built:

```nix
dispatch.lib.mkAgentRelease {
  inherit system;
  name = "company-agents";
  src = source;
  revision = self.rev or self.dirtyRev or "uncommitted";
  withEval = true;
}
```

The release gains `bin/dispatch-eval`, the package under `lib/NAME/eval`, a Python interpreter with the engine's
dependency, and an `eval` record in `release.json` (`revision`, `version`, `command`, `engine`, `python`). The company repository adds no launcher, agent or Python
environment: only its use-case packages and, outside Git, their bindings. Without `withEval` a release is built
exactly as before.

### A use-case package

A directory, anywhere in the company's repository, with:

- **`eval.json`**: `name`, `unit` (one sentence), `module`, `rubric` (`extract`, `judge`, `prompt_version`,
  `schema_version`, `metric_version`), `grader` (`provider`, `id`, `thinking`), `judgments` per unit (default 3) and
  `clock` (`kind`: what `observed.seconds` measures; required before a rerun can be planned).
- **Rubric files**: the extraction instructions (what the request requires, from the request alone) and the
  judgment instructions (closed answers with evidence pointers).
- **The module** (Python), which supplies:
  - `collect(ctx)` for retained runs, or `cases(ctx)`, `run_case(ctx, run, case, variant, rep)` and
    `target_identity(ctx, variant)` for reruns;
  - `extract_prompt(unit)` and `judge_prompt(unit, requirements)`;
  - `validate_extract(value)` and `validate_judge(value, requirements)`;
  - `metrics(findings, requirements, unit)`: every number, computed in code from the closed answers;
  - `closed_items(findings)` for repeat agreement and `measures` for comparison;
  - optionally `report_columns`, `findings_columns` and `findings_rows`.

A unit is `{unit_id, request, evidence, observed, coverage, labels}`:

| Field | Meaning |
| --- | --- |
| `unit_id` | Stable identifier of the thing evaluated. |
| `request` | What was asked. Requirements are extracted from this alone and frozen by its hash. |
| `evidence` | What happened: the outcome and whatever the judgment needs to check it. |
| `observed` | `{seconds, tokens, cost_usd, models}` as recorded; `null` where the records hold none. |
| `coverage` | Names of what the evidence includes and what was unavailable. |
| `labels` | Any attributes of the use case's own domain, as JSON. The store has no column for them. `kind` and `title` are shown in the report. |

Optional: `first_at` (when the unit started), `requirements_key` (units sharing it share one frozen extraction, as
the same case does across reruns), `gradable: false` and `state` for a rerun that produced nothing to judge.

`ctx` gives the module `package`, `bindings`, `data` (the data directory), `records` (the argument vector of the
record reader below), `inspection_copy` and `build`. The [example module](example/package/usecase.py) is a complete
package in about a hundred lines.

### Bindings

Private JSON, kept outside Git:

```json
{ "version": 1, "dataDir": "/abs/state/USECASE", "workbook": "/abs/USECASE.xlsx",
  "billingRoute": "which credentials pay for target and grader calls", "concurrency": null,
  "source": { "...": "whatever the module reads: store paths, case files" } }
```

`dataDir` holds the use case's store, unit bundles and in-flight work, all owner-only. `concurrency` is unset by
default, so every needed step runs at once; set it only for a verified provider limit.

### Running

```sh
dispatch-eval run --config HOST.json --package DIR --bindings FILE --collect [--limit N]   # retained runs
dispatch-eval engine --package DIR --bindings FILE plan-run --run RUN --variant '{"thinking":"low"}' --repeats N [--cases A,B]
dispatch-eval run --config HOST.json --package DIR --bindings FILE --run RUN               # the planned rerun
dispatch-eval run --config HOST.json --package DIR --bindings FILE --grade                 # grade and publish only
dispatch-eval engine --package DIR --bindings FILE compare --runs A,B                      # also: status, agreement, publish, report, runs
```

`HOST.json` is the [on-demand host configuration](../runner/docs/nix-releases.md#on-demand-cli). It must bind the
provider named as the package's grader, through `gateway` or
[`modelProviders`](../runner/docs/service.md#local-model-providers). `run` exits 0 only when the step completed.
Diagnostics go to standard error; `run` prints two JSON events and each `engine` command prints one JSON value.

`run` opens the native session `eval-NAME` under the host's state root (`--session KEY` or `DISPATCH_EVAL_SESSION`
selects another). Rerunning a step resumes it: finished reruns are reused, in-flight grader steps keep their
conversations and request IDs, and unchanged evidence keeps its judgments.

### The session's owner agent

A native session needs an agent. This package supplies it as a
[built-in definition](definitions/agents/dispatch-eval/agent.md), loaded from the package's own definitions root, so
the company's definitions and catalog are untouched and nothing has to be added or kept in step. The owner has no
tools. Its provider is bound by the launcher to a fixed reply, so the host configuration needs to bind only the
grader. Evaluation state lives in the session document `dispatch.eval` and the task `dispatch.eval.step`.

### Importing the shared parts

A company definition that needs its own evaluation task can import the same modules the launcher uses; a release
built with `withEval` resolves them beside Runner:

```ts
import { gradeRounds, graderFrom } from "@dispatch/eval/grading";
import { NativeRecords, readRecords, withInspectionCopy } from "@dispatch/eval/records";
import { EvaluationExtension, engine } from "@dispatch/eval/task";
```

Python that needs the core (`dispatch_eval.core`: store, versions, answer parsing, comparison rules, agreement,
build identity) adds the directory named by `eval.engine` in `release.json` to its import path.

## Native evidence

`dispatch-eval records` is the supported way to read a native Pi Durable store. A module calls it through
`ctx["records"]`:

```python
out = subprocess.run([*ctx["records"], "--db", store, "--document-kind", kind], check=True, capture_output=True, text=True)
units = json.loads(out.stdout)["units"]
```

It opens the store with a separate query-only SQLite connection. It never opens a Pi Durable session, takes an
owner lock, migrates a schema or runs work. It selects the conversations that own a document of one kind, or one
`--conversation`, and returns for each:

- the transcript, including fork ancestry, with inherited entries marked. Every entry is kept: those without model
  messages (resets, compaction, data) are kept as envelopes. Text, tool calls and tool results are copied in full;
  other content (for example reasoning) is not copied, and its types are named in coverage as
  `content_omitted:TYPE`;
- the agent configuration rebuilt at the run's start sequence, and whether it changed afterwards;
- its own documents and recorded usage, its tasks and submissions with their outcomes;
- every child conversation, followed the same way;
- `coverage`: what is present and what is unavailable, for example `configuration_at_start_not_retained` or
  `usage_unavailable`. Nothing unavailable is filled in from current state.

Credentials and opaque provider state are redacted. `--copy` reads a temporary private copy instead of the store.
Any copy this package makes for inspection (`--copy`, `withInspectionCopy` in TypeScript, `ctx["inspection_copy"]`
in Python) is created with an owner-only directory and files and is removed by the step that made it.

## What every evaluation keeps

- **Requirements are frozen from the request alone.** The extraction never sees the outcome and is reused by its
  hash.
- **Judgments are closed.** The grader chooses among stated values and points at evidence; every number is
  computed in code.
- **"The evidence cannot settle it" is its own answer**, distinct from "not met".
- **Every assessment records** the evidence hash, the extraction and grading versions (rubric text, grader and
  settings, prompt and schema versions), the metric version in force, and the build that graded it.
- **History is append-only.** A changed rubric, grader or evidence makes new linked rows. Unchanged evidence is
  never graded again.
- **Grader repeats and run repeats are different things.** Several judgments of one outcome measure the grader;
  repeated runs measure the agent.
- **Runs are resumable and pinned.** A run keeps the exact case inputs it was planned with, and a target whose
  identity changed is refused before any new call.
- **A run manifest records** the target identity, the hash of its cases, the rubric and metric versions, the clock
  kind, the billing route, the runtime identity (Dispatch revision and Pi Durable version) and the definitions
  commit with whether that build was dirty.

Enforced, not left to convention:

- **Speed is compared only on one clock.** `compare` refuses to compare seconds between runs whose clock kinds
  differ, or that recorded none, and says which.
- **A dirty build is development evidence.** A build whose definitions or Dispatch revision is not a clean commit,
  a package with uncommitted changes, or an engine started without the launcher, labels its runs, its assessments
  and every report that includes them `DEVELOPMENT EVIDENCE`, with the reason.

## Store schema

Each use case has one SQLite store, `assessments.sqlite` in its data directory, at **schema version 2** (recorded
in `store_meta`). Units carry their domain attributes as JSON in `labels`; no column names a domain. A store on
another version is refused, never altered silently.

A store written before versions were recorded (schema 1) is upgraded with:

```sh
dispatch-eval convert --data-dir DIR [--bundle-root DIR] [--clock-kind KIND] [--runtime DISPATCH_REVISION,PI_DURABLE_VERSION]
```

Every row keeps its ID, so history, frozen requirements and comparisons keep their links and nothing is graded
again. Each column of a schema-1 unit that named a domain attribute becomes a label under the column's name. The
original file is kept beside the new one as `assessments.schema1.sqlite`. Schema 1 recorded no clock kind or
runtime identity: converted runs refuse speed comparison until `--clock-kind` declares the clock, and `--runtime`
records a runtime identity for reference only. A declaration is recorded as made at conversion. See
[convert.py](engine/dispatch_eval/convert.py) for the full mapping.

## Limits

- Grading is provisional until checked against a person's judgment.
- A case set is deliberate coverage, not a traffic sample.
- Retained-run evaluation sees only what the records hold.
- Cost is recorded token usage at stated rates.
- The launcher exists only in a release built with `withEval`. From a source checkout,
  `node packages/eval/src/cli.ts` runs the engine through `uv` and its lockfile, and its results are development
  evidence.
- The report is a workbook (`.xlsx`) or JSON. A release installs the engine's dependency from the wheels pinned in
  the engine's lockfile onto the release's own Python; a source checkout resolves the same lockfile with `uv`.
- No schedule is provided. Verified on macOS (Apple silicon) with the synthetic example; Linux is built by the same
  derivation and not separately exercised.

## Checks

`npm run build --workspace @dispatch/eval` runs its [content check](scripts/check-content.mjs) over this
package, `npm run typecheck --workspace @dispatch/eval` checks the TypeScript against Runner, and `nix flake check`
runs the content check and builds the example release. Package text is public: follow the
[public information boundary](../../OSS.md#public-information-boundary).
