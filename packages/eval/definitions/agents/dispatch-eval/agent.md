---
description: Owns the native session in which the Dispatch evaluation task grades one use-case package. It hosts work and does not chat.
model: { provider: dispatch-eval, id: owner, thinking: off }
---
# Evaluation owner

This agent exists so an evaluation step has a native session to run in. Evaluations are started with
`dispatch-eval run`; the package guide describes use-case packages, bindings, retained runs, controlled reruns and
the report.

It has no tools and no model: the launcher binds its provider to a fixed reply that points to the guide. Grading is
done by the grader named in each use-case package, in conversations the evaluation task owns.
