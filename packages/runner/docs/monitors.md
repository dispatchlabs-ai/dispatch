# Reviewed attention monitors

A monitor polls a source in code, privately researches changed conversations and
tracks distinct requests within them. Only researched human actions qualify for
notifications. Pi Durable owns the polling, review tasks, checkpoints and exact
delivery payloads in the application's existing store.

```ts
import { defineAgent } from "@dispatch/runner";
import { monitors } from "@dispatch/runner/monitors";
import { slackMonitor } from "@dispatch/slack/monitor";
import notifications from "./notifications.js";

export default defineAgent({
  skills: true,
  extensions: [monitors({
    id: "attention-monitor", owner: "riley",
    source: slackMonitor({ workspaces: ["example-team"], credentialsFile: "slack-monitor.local.json" }),
    refreshEveryMinutes: 5,
    briefing: { cron: "30 8,16 * * 1-5", timezone: "America/New_York" },
    reviewTools: {},
    deliverTo: notifications,
    prompt: "Research each distinct request. Alert for a ready decision that needs Riley today; queue less urgent decisions for the briefing. Record work owned by others and resolve only the specifically answered request.",
  })],
});
```

Enroll the owner in the [user directory](../README.md) and configure a
[Slack user grant](../../slack/README.md#read-only-monitoring) for each selected workspace.

The application's `notifications.js` exports a recipient-bound `MonitorDestination`.
Its `send(event, signal, beforeSend)` calls `beforeSend()` immediately before delivery,
uses `event.id` as the idempotency key, and returns the confirmed provider status.
Its `cancel(id, signal)` withdraws that occurrence even if a previous send had an
uncertain outcome. A destination using MCP declares its private `connection` name
and receives the bound tool-call function as its first argument to both methods.

Run `npx dispatch preview --agent assistant --no-web`, then
`npx dispatch chat --preview assistant --as riley`. Ask to preview
`example-team:CHANNEL:THREAD_TIMESTAMP`. This reads the complete actual thread,
runs the same private review and returns decisions and proposed wording. It never
sends, cancels, advances production checkpoints or starts scheduled work. The
owner can start monitoring from a chosen absolute timestamp, inspect coverage
and cases, or stop it in an ordinary private conversation. Stop also cancels
outstanding notifications; it does not approve their underlying requests.

Polling continues while individual reviews run. A quiet source poll uses no
inference. Search fingerprints avoid full reads of unchanged inactive threads. Full pagination and thread reads include read messages and replies;
active requests are refreshed even without a search hit. A failed workspace search
keeps its checkpoint. After a successful search, unreadable threads stay queued
individually while other threads proceed. Coverage describes Slack’s search index
and the tracked threads. Slack applies the user’s search filters and can group
nearby matches. Use a named thread watch when every reply in that thread matters.
A missing thread remains a coverage issue.

An application can select additional read-only MCP tools with
`reviewTools: { knowledge: ["search", "read"] }`, using the server's original tool
names. These and the source's read tools are available only to the private
reviewer, along with the agent's skill reader and owner profile. Its task manages
completion; ordinary user-request completion hooks do not run in these children.
Keep research and alert policy in application instructions or a skill.

Each source is reviewed independently. At the polling cadence, the notification
task consolidates ready requests, saves the exact payload before sending, and
checks current source revisions. An unanswered review cannot hold up unrelated
requests. Briefings include the researched cases available at their scheduled time. Changed or resolved requests withdraw
their stale notices; acknowledgements never grant approval. A delivered batch
containing a resolved request is cancelled while its other cases remain tracked.
External acceptance is recorded separately from phone display or human action.
