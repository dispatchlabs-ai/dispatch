# Complete the request

Opt a definition into `RequestCompletion` alongside its existing tools:

```ts
import { defineAgent, RequestCompletion } from "@dispatch/runner";

export default defineAgent({
  trigger: { mode: "manual" },
  input: "Complete the user's request.",
  extensions: [RequestCompletion],
});
```

The agent uses `request_status` to record the original request, remaining work,
completion evidence and any indispensable external input. `request_status({})`
reads the record. Native `RequestWork` document state retains it through restarts
and compaction and puts it back into each request's prompt. The original request
cannot be replaced while unfinished; follow-ups can update the remaining work.

Pi Durable's `GenerationTask.onYield` continues the same run when the model tries
to finish without a current assessment or while the request is `active`. The
original submission remains pending, tools keep their native recovery semantics,
and there is no pass limit, second scheduler or new submission per continuation.
New native input invalidates an earlier assessment, including input admitted at
the final-answer boundary. Pi retains ownership of steering and cancellation.

`complete` requires no remaining work. `needs_input` retains unfinished work and
requires a specific external dependency; the agent must first establish that no
useful authorized work remains possible. `cancelled` records a user cancellation
or replacement. Completion assessments are not independent proof that an
external task is done. The tool descriptions and instructions require supporting
evidence; applications can inspect `RequestWork` as well as native tool history.
The record is not new authority to act or to override tool and host permissions.

A question can complete with its answer. A partial status report does not complete
an action request. A blocked part does not justify ending independent work.
After a real input pause, the next user input resumes assessment of the same
unfinished request. Process close suspends native work; explicit abort cancels
execution and is never overridden by this extension. Changing an existing
definition requires its ordinary idle-state definition update.

## Explicit Stop and recovery

`ChatService.stop`, `cancelService` and the legacy `stop_<delegate>` tool record
host cancellation without a model call. They change existing `active` or
`needs_input` records to `cancelled`, retain the original request, stable identity,
remaining work and prior evidence, and clear the obsolete input blocker. Completed
records remain complete. Native ownership limits child cancellation; independent
peer conversations are not cancelled by stopping their sender.

Cancellation captures the current and queued native input IDs in the same commit
as the summary update. A model cannot reopen that cancelled input set, including
a subset placed from queued steering. Repeating an update to the same cancelled
state leaves the host evidence and input set intact. A later native input has a
new ID and can explicitly record a new or resumed request. Stop reconciles again
after native abort settles to include a child or first request record created
while abort was taking effect. Absent records are not mounted; conversations
without this extension retain their existing behavior.

Custom hosts can call `recordRequestCancellation(harness, conversationId, context)`
through Pi's public snapshot/commit interface. It covers that conversation and
its owned descendants and is idempotent. The helper changes bookkeeping only;
the host must still abort native work. Hold new admission until both operations
finish. `ChatService` orders its `submit` and `stop` operations per conversation;
adapters that submit directly must retain their own Stop/admission ordering.

For crash recovery, persist the explicit cancellation decision before terminating
the worker. Reopen with `resume: false`, run `cancelService`, and only then admit
new input or resume execution. The same helper can reconcile a previously stopped
store's stale summary through native commits, preserving its history. Do not
infer cancellation from an idle process, an interrupted observer, or ordinary
close; those paths leave the request suspended. Cancellation does not undo
completed external effects.

This extension does not change continuous schedules. Named workers opt in through
their own definitions; each has its own assignment and completion record.
