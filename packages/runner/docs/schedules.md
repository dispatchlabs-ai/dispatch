# Agent-local schedules

An agent owns its named schedules and assignment prompts. Runner calculates
calendar occurrences and admits ordinary inputs; stock Pi Durable owns the
persisted timer tasks, deadlines, conversations, submissions and recovery.
There is no second database, system cron entry or per-agent timer process.

## Definition and activation

```ts
schedules: [{
  id: "daily-review",
  cron: "0 3 * * *",
  timezone: "America/New_York",
  instance: { mode: "new" },
  missed: "latest",
  input: "Perform the assigned daily review and report the findings.",
}],
```

Keep this list in `agents/<name>/agent.ts`, or import an ordinary adjacent
`schedules.ts`. Multiple entries share the role's model, instructions and grants.
The optional field is validated by `defineAgent`; imported schedule values also
contribute to the loaded definition fingerprint. Existing definitions need no
change. `trigger: { mode: "manual" }` disables the legacy loop, not calendars.
Legacy continuous and interval semantics are unchanged.

Enable the owning agent in `factory.yaml` (for example `agents: [author]`) and
serve it with `run()` / `ChatService.open()` or `dispatch-service CONFIG serve`.
The installation must keep that service available. `run()` starts native recovery
after host bindings and adapters are ready. All addressed roles must be
served. Merely loading the definition, terminal chat, history mode and
`resume: false` do not activate calendar admission. A custom `ChatService.attach`
does not activate calendars on application-owned hosts.

The first occurrence is strictly after activation. Installing a new schedule
after today's time does not retroactively run it. Use the native calendar for a
future verification occurrence, not a manually submitted substitute.

## Contract

- `id`: unique within the agent, lowercase letters/digits/hyphens, starting with a
  letter. Keep it stable across ordinary edits.
- `cron`: five fields, minute through weekday, interpreted by pinned
  `cron-parser`. Seconds and `@daily` shortcuts are rejected. Day-of-month and
  weekday follow the parser's standard OR rule; names and supported extensions
  are accepted. Hashed fields use the schedule ID as their deterministic seed.
- `timezone`: explicit IANA timezone, validated before state opens. Calendar
  arithmetic follows that zone, not the service machine's timezone or a fixed
  24-hour interval. DST behavior follows the pinned parser: nonexistent local
  times shift forward through the gap; repeated clock times do not imply two
  daily occurrences. Review the actual next UTC deadline when choosing a time
  inside a DST transition.
- `instance`: explicitly `{ mode: "new" }` for a fresh independent conversation
  per occurrence, or `{ mode: "existing", id: "author:2" }` for an exact existing
  instance of the owning agent. The latter queues with native `followUp` when
  busy. New instances may overlap; there is no imposed concurrency cap.
- `input`: nonempty assignment, sent unchanged. The role still owns its workflow,
  authority, self-continuation and handoffs. Scheduling grants no new tools.
- `missed`: required. `skip` discards past calendar minutes; `latest` admits only
  the most recent missed occurrence, never a backlog. A delayed wake within the
  due minute is still that occurrence. These rules apply before admission;
  already admitted work always follows native recovery.
- `endAt`: optional exclusive absolute expiry with `Z` or an explicit offset.
  After expiry no waiting occurrence is admitted, even with `latest`. An admission
  phase already in progress recovers its saved identity. This permits a bounded
  calendar verification without leaving an annually repeating test behind.

## Recovery and changes

Each occurrence uses `schedule:<agent>:<schedule-id>:<UTC epoch milliseconds>` as
both its conversation key (for `new`) and native request ID. If a process stops
between creation, submission and receipt recording, replay addresses the same
conversation and input. The timer never waits for the model's answer. External
agent effects still need their own domain receipts; this is not an exactly-once
banking or shell guarantee.

Unchanged schedules preserve their saved deadline across restart. Schedule edits,
removal or agent disablement are reconciled before native work resumes: pending
calendar tasks are aborted and changed/re-enabled schedules start at the next
future occurrence. Previously submitted conversations/inputs remain independent
and are not cancelled. Removed schedule metadata and last admission remain
inspectable. Definition updates use the existing deliberate idle-update policy;
waiting calendar tasks alone do not prevent updates. An in-progress admission or
ordinary agent work still counts as busy.

A native calendar failure remains visible; restarting an unchanged definition
does not create a replacement task. Fix the cause, then deliberately disable and
re-enable the schedule or change its definition. Before retrying, inspect its
conversation/request identity. The service remains the sole owner of its stores.

## Inspect and verify

```sh
dispatch-service /srv/agents/config.json schedules
dispatch-service /srv/agents/config.json status
dispatch-service /srv/agents/config.json snapshot author:2
dispatch-service /srv/agents/config.json receipt author:2 7
```

`service.schedules()` and the versioned local API's `{ "method": "schedules" }`
return each agent-local definition, enabled flag, next deadline, native task state
and last admission (occurrence, conversation and submission). Each admission also
appends a native `schedule-admission` entry in the owning root conversation for
Observer/history inspection. `last` means admitted, not successfully completed.
Future sleeping timers alone do not make `status` / `idle` busy; ordinary work,
active admission and adapter work do.

Exercise a synthetic short schedule, inspect its native receipt, close/reopen the
service and inspect the retained identities before live deployment. Also inspect
missed occurrences, disable/re-enable, bounded expiry and timezone transitions.
Follow the repository's manual verification policy; no automated functional test
suite is shipped. Source publication does not upgrade installed services.

The [scaffold walkthrough](https://github.com/dispatchlabs-ai/agent-scaffold/blob/main/examples/dispatch/docs/schedules.md)
shows a complete author/reviewer definition and service command.

## Prior decision

The October 26, 2026 document accepted agent-local ownership and proposed the API,
but explicitly shipped no cron implementation. This implementation supersedes
that status. It retains Runner admission and Pi recovery ownership; it does not
move schedules into `factory.yaml` or add a workflow supervisor.
