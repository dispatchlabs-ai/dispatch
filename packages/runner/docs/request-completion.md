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
or replacement. These are model assessments, not independent proof that an
external task is done. The tool descriptions and instructions require supporting
evidence; applications can inspect `RequestWork` as well as native tool history.
The record is not new authority to act or to override tool and host permissions.

A question can complete with its answer. A partial status report does not complete
an action request. A blocked part does not justify ending independent work.
After a real input pause, the next user input resumes assessment of the same
unfinished request. Process close suspends native work; explicit abort cancels
execution and is never overridden by this extension. Changing an existing
definition requires its ordinary idle-state definition update.

This extension does not change continuous schedules. Named workers opt in through
their own definitions; each has its own assignment and completion record.
