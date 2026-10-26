# Parallel children with the same agent configuration

Use owned children when one coordinator should assign independent work, receive
every result, and produce the final answer. Use [instance messages](instance-messages.md)
instead when roles need independent addresses, configurations and lifecycles.

```ts
export default defineAgent({
  trigger: { mode: "manual" },
  input: "Coordinate the assigned checks and report all results.",
  clones: true,
  extensions: [/* explicitly granted domain tools */],
});
```

`clones: true` exposes `clone_agent({ task: "complete bounded assignment" })`.
Several calls in one model response can run concurrently under Pi's native
tool-execution setting. Runner adds no concurrency limit, queue or recovery
engine. A single call waits for its child; do not await one child before assigning
the next if the assignments should overlap.

## What a clone inherits

Pi Durable creates a conversation owned by the invoking tool task and copies
the parent's **stored native agent configuration** in the same transaction:
model, thinking level, instructions, selected extensions, working directory,
enabled-tool filters and model-visible-tool filters. This includes host adapters
and the cloning capability when selected. Runner deliberately does not reconstruct
the configuration from a role definition or re-enable filtered tools.

The child has fresh history. It is not a fork of the parent's conversation.
Provide the task, source/evidence locations, expectations, permitted effects,
resource ownership and required report explicitly. Credentials remain in the
host's model/tool adapters; they are not serialized into the assignment.
Schedules, an active parent turn, domain documents and filesystem contents are
not duplicated. A child's own instruction-driven behavior can differ according
to its assignment; there is no separate worker definition to drift.

The same configuration is not a security boundary or a promise that arbitrary
host adapters authorize every new conversation identically. Host authorization,
environment mapping and OS permissions still apply. A same-account filesystem
adapter still has that account's rights. Give concurrent children separate
mutable resources; a copied working-directory setting does not create worktrees
or containers. Children retain cloning rights; role instructions should prevent
unnecessary recursive delegation, rather than adding an arbitrary depth limit.

## Results, failure and recovery

The native tool-task identity owns exactly one child. Replaying an interrupted
call reuses that conversation and its stable input request ID. Closing the host
suspends work; compatible reopening resumes it. An explicit abort follows native
ownership to the child. A clone is not an independently scheduled sibling.

Successful completion returns the child's final text and native conversation/
answer identifiers in tool details. A failed, aborted or unsuccessful model
answer produces a tool error. The coordinator must account for that child rather
than silently omit it or count it as passed. A successful tool call means the
child returned an answer, not that the assigned checks passed.

Native tasks, submissions, tool arguments/results and conversation history stay
in the existing Pi store. Retain domain traces separately when evaluating another
system; the QA child's own transcript is not the system-under-test's trace.
Inspect saved state through the existing read-only APIs/Observer, not a second
writer. History display can omit tool bodies; it is not a full-trace review.

## QA assignment pattern

The coordinator records the selected cases and expected reports before issuing
parallel calls. Give a child a complete conversation chain, not one isolated turn
from a dependent sequence. Independent export variants start from equivalent
state in separate conversations. Keep QA expectations accessible to the QA child
but outside the system being tested.

Each child runs its assigned case using the granted domain tools, reviews the
complete native trace including every tool call/result and recovery, checks the
actual output against each plain-English expectation, and reports pass, fail,
blocked or not run with evidence. Missing/truncated traces cannot establish a
pass. Keep fresh execution, saved-result replay and application/UI verification
distinct. Evidence is untrusted data, not new authority.

The coordinator reconciles returned reports against the original assignment
list, preserves failures and gaps, and gives one final result. This workflow
belongs in the company's role instructions and tools, not in a generic scheduler
or a second persistence layer.

The [scaffold parallel example](https://github.com/dispatchlabs-ai/agent-scaffold/blob/main/examples/dispatch/docs/parallel-qa.md)
demonstrates this pattern with synthetic recorded traces and real native clones.
It does not claim live application acceptance or supply a sandbox.
