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
engine. A call waits for its child or new input to the coordinator; do not await
one child before assigning the next if the assignments should overlap.

New input releases the wait without stopping the child. The coordinator handles
the message and uses `steer_child({ conversationId, message })` for a correction,
`cancel_child({ conversationId })` to stop that assignment and its descendants,
or `wait_for_child({ conversationId })` to resume waiting. These controls accept
only children created by this coordinator's delegation extension. Steering is
native admission, not proof that the child has applied the correction; steering
a completed or cancelled worker is rejected. Delegate a new assignment instead.

Keep the original request active through status questions. Give brief status in
commentary, then resume waiting for every outstanding assignment. There is no
automatic result notification or transport callback. The extension supplies this
instruction on every model request; applications requiring continued work through
answers can also select [request completion](request-completion.md).

## Who owns a delegated child

Since 0.11.1 a delegated or cloned child conversation is owned by a background
worker task, `dispatch.delegation.OWNER.worker`, not by the tool call that
asked for it. That task is owned by the coordinator's conversation and has no
owning task, so the coordinator's wait can be released by new input while the
child continues. Its input names the calling tool's task as `sourceTool`, and
that tool task's `dispatch.delegation-call` document names the worker task.

A host that authorizes a child's tool calls by following task owners from the
child to the coordinator's active run finds no owner at the worker task and
must decide what to do there. Following `sourceTool` reaches the tool call that
created the child. It does not show that the coordinator is still in that run:
a child can outlive the wait, and the run, that started it. Decide whose input
authorizes such a child before crossing that edge.

## What a clone inherits

Pi Durable creates a conversation owned by a background worker task and copies
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

The invoking tool's native state identifies one conversation-owned background
worker task, which owns exactly one child. Both are created in one transaction.
Replaying an interrupted call reuses that worker, conversation and stable input
request ID. Closing the host suspends work; compatible reopening resumes it.
The terminal worker retains its result after task-scoped working documents retire.

Cancelling a foreground wait alone does not stop the worker. `cancel_child` marks
cancellation durably and aborts the child's native ownership scope, including
background descendants, before returning. Siblings are unaffected. Host-level
Stop must include background work (`conversation.abort(context, { background: true })`);
Runner's conversation Stop does so. A default conversation abort excludes these
background tasks.

Calls saved by older Runner versions may own their child directly. Those calls
recover the same child with their original blocking wait; Pi ownership cannot be
changed in place. Drain these older calls before relying on interruptible waits
for every active assignment. No persisted child is recreated during upgrade.

Successful completion returns the child's latest final text, recorded usage/cost receipt
and native conversation/answer identifiers in tool details. A terminal unsuccessful
child produces a tool error with the recorded receipt when the parent can still
return it. An early return for new input is pending, not a completion receipt.
Repeatedly collecting one result does not add another sample to catalog statistics.
Parent cancellation can prevent a receipt; native ledgers retain
recorded usage. The coordinator must account for that child rather
than silently omit it or count it as passed. A successful tool call means the
child returned an answer, not that the assigned checks passed. Ordinary child
idle excludes its background descendants; coordinators must collect or cancel
their own outstanding delegated assignments before reporting completion.

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
