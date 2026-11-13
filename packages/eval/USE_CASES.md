# Eval use cases

This catalog records intended actor goals; accepted additions do not establish
implementation or deployment.

- **EVAL-001 — First result without credentials:** a new user builds the example release and runs the synthetic
  package through collection, grading, comparison and the report with no model call.
- **EVAL-002 — Evaluate from a pinned release:** a company opts in with `withEval` and evaluates its agents with
  only its own use-case packages and bindings; it writes no launcher, agent or Python environment.
- **EVAL-003 — Grade retained runs:** an evaluator grades work that already happened from its native records;
  no agent is rerun and no effect is repeated.
- **EVAL-004 — Compare controlled reruns:** an evaluator runs fixed cases through a target under two variants and
  reads which measures clearly changed.
- **EVAL-005 — Read native records safely:** a collector reads a store beside its live owner without opening a
  session or taking a lock, and learns from `coverage` what the store did not hold.
- **EVAL-006 — Resume:** an interrupted step is run again and repeats no finished rerun, grader call or judgment.
- **EVAL-007 — Trust a comparison's limits:** a reader is told when speed was not compared because the clocks
  differ and when evidence came from a dirty build, and can see the runtime each run recorded.
- **EVAL-008 — Keep earlier results:** an operator converts a store written by the earlier schema and reads the
  same figures from it.
- **EVAL-009 — Leave others alone:** a release built without `withEval` is built exactly as before.
