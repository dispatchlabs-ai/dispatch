# Reviewed attention monitors

A monitor polls a source in code, privately researches changed conversations and
tracks distinct requests within them. Only researched human actions qualify for
notifications. Pi Durable owns the polling, review tasks, checkpoints and exact
delivery payloads in the application's existing store.

```ts
import { defineAgent } from "@dispatch/runner";
import { monitors, attentionAlerts } from "@dispatch/runner/monitors";
import { slackGo } from "@dispatch/runner/slack-monitor";

export default defineAgent({
  skills: true,
  extensions: [monitors({
    id: "attention-monitor", owner: "riley",
    source: slackGo({ workspaces: ["example-team"] }),
    refreshEveryMinutes: 5,
    briefing: { cron: "30 8,16 * * 1-5", timezone: "America/New_York" },
    reviewTools: {},
    deliverTo: attentionAlerts("notifications"),
    prompt: "Research each distinct request. Alert for a ready decision that needs Riley today; queue less urgent decisions for the briefing. Record work owned by others and resolve only the specifically answered request.",
  })],
});
```

Keep the normal npm application and host commands. Enroll the owner in the
[user directory](../README.md). Install SlackGo on the host and sign into the selected
workspaces. Optional `command` and `credentialsFile` settings select its executable
and private credential file. Configure the destination's authenticated MCP
connection in `host.json`; `attentionAlerts` needs `send_alert` and `cancel_alert`.
Credentials stay outside the agent definition. Other destinations implement
`MonitorDestination` and must support idempotent delivery and cancellation of
uncertain sends by the original occurrence ID.

Run `npx dispatch preview --agent assistant --no-web`, then
`npx dispatch chat --preview assistant --as riley`. Ask to preview
`example-team:CHANNEL:THREAD_TIMESTAMP`. This reads the complete actual thread,
runs the same private review and returns decisions and proposed wording. It never
sends, cancels, advances production checkpoints or starts scheduled work. The
owner can start monitoring from a chosen absolute timestamp, inspect coverage
and cases, or stop it in an ordinary private conversation. Stop also cancels
outstanding notifications; it does not approve their underlying requests.

Polling continues while individual reviews run. A quiet source poll uses no
inference. Full pagination and thread reads include read messages and replies;
active requests are refreshed even without a search hit. Each workspace keeps its own checkpoint; failed coverage does not advance it or
prevent successful workspaces from progressing. Slack search is an index, not a change stream:
edits or deletions outside the overlapping search window and tracked threads
are not guaranteed to be discovered. Missing threads are coverage failures,
never evidence that a request was resolved.

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
