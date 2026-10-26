# Agent-local schedules

**Design accepted October 26, 2026; not implemented.** An agent owns its
schedules and assignment prompts. Runner owns the shared scheduling machinery;
Pi Durable owns persistent execution and recovery. A schedule submits an
assignment; it does not supervise the resulting work.

The current [definition API](../src/definition.ts) supports only `manual`,
`continuous` and `interval` triggers. It has no `schedules` field or cron/timezone
support. The shapes below describe the proposed API, not runnable configuration.
Do not suppress TypeScript errors to install them: an untyped extra property
does not make Runner execute it.

## Ownership

Keep the schedule list inside `agents/<name>/agent.ts`, alongside that agent's
capabilities. If it grows, import an ordinary adjacent `schedules.ts`; that file
is not a separately discovered manifest. Model selection, thinking and role
instructions stay in `agent.md`.

An agent can own several named schedules with different prompts, times and
target repositories. The folder supplies the agent identity, so each entry
does not repeat an `agent` field. Do not clone an agent definition merely to
schedule another assignment.

`factory.yaml` selects which agents' autonomous behavior is enabled. It does not
own their cron expressions or prompts. Only definitions selected in the running
service can execute; installing a definition is not a process supervisor.
The existing `agents: []` configuration enables no autonomous loops.

## Proposed definition

This is a proposed field inside `defineAgent(...)`, not a complete definition:

```ts
schedules: [
  {
    id: "daily-review",
    cron: "0 3 * * *",
    timezone: "America/New_York",
    instance: { mode: "new" },
    input: "Perform the assigned daily review and report the findings.",
  },
],
```

- `id` identifies the schedule within its owning agent.
- `cron` uses five fields: minute, hour, day of month, month and day of week.
- `timezone` names the calendar timezone. The example means 3 a.m. Eastern,
  following daylight-saving changes, not every 24 hours or fixed-offset EST.
- `instance` makes the conversation choice explicit. `new` means a fresh
  independent instance for each occurrence, not a fresh instance on recovery.
- `input` is the predefined assignment sent to that instance, not its system
  prompt. Existing role instructions, model, tools and authority still apply.

The [cron format and timezone reference](https://github.com/harrisiirak/cron-parser#cron-format)
explains the notation; this design does not select or install a parser.
See the scaffold's [complete illustrative definition](https://github.com/dispatchlabs-ai/agent-scaffold/blob/main/examples/dispatch/docs/schedules.md)
for a daily author-to-reviewer assignment with self-contained synthetic input.

Under the proposed model, `trigger: { mode: "manual" }` means no legacy continuous
or interval loop; it does not prohibit assignments from schedules, people or
peers. The current runtime still treats that definition as manual only.

## Execution boundary

Runner would interpret each enabled agent's schedule and admit the saved prompt
as ordinary native input. Each occurrence needs a stable identity so recovery
continues the admitted conversation/input instead of generating a replacement
assignment. Pi Durable remains the execution and recovery authority; do not add
a competing persistence system or a per-agent timer service.

Self-continuation, stopping conditions, independent review and optional replies
remain in the agent's workflow. A schedule does not wait for or supervise the
whole sequence. Recipients must still be served and permitted under the existing
[instance-message contract](instance-messages.md).

## Decisions still needed before implementation

Agent-local ownership and the runtime boundary are accepted. The exact field
schema and these operational choices are not a shipped contract:

- Addressing an existing instance instead of creating one per occurrence.
- Missed occurrences while the service or machine is offline.
- Admission when earlier work is still active, including existing-instance
  behavior; no overlap limit or skip/coalescing policy is established here.
- Schedule edits, disable/re-enable behavior, definition revisions and already
  admitted work.
- General daylight-saving gaps/repeated wall-clock times, parser validation,
  occurrence identities and history/next-run inspection.

The service must be available to admit work at the intended time. Native
recovery of admitted work does not decide what to do with an occurrence that
was never admitted. Existing interval-loop behavior is not an implicit cron
policy. No system cron entry, deployment, schedule activation or new Runner
release is part of this documentation change.
