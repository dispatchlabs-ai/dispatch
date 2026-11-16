# Reviewed reminders

Use `reminders` from `@dispatch/runner/reminders` when an agent should verify
an upcoming occurrence and author a notification. The host runs discovery in
code. Each approaching occurrence gets its own private review conversation,
with the agent's instructions, the owner's profile, current evidence and only
the read tools the source supplies.

```ts
import { defineAgent } from "@dispatch/runner";
import { reminders } from "@dispatch/runner/reminders";
import { deadlines, notifications } from "./connections.ts";

export default defineAgent({
  extensions: [reminders({
    id: "deadline-reminders",
    owner: "riley",
    source: deadlines,
    refreshEveryMinutes: 5,
    prepareMinutes: 2,
    dueAt: item => item.deadline - 10 * 60_000,
    expiresAt: item => item.deadline,
    deliverTo: notifications,
    prompt: "Verify the deadline. If it still applies, write a short alert with the due time.",
  })],
});
```

The application supplies a `ReminderSource` and `ReminderDestination`. The source
names a host MCP connection and implements `read` for discovery and `evidence`
for review. It may supply `reviewTools` for additional read-only research.
Items have a stable occurrence `key` and may include a `revision` and `link`.
Give a moved occurrence a new key. The destination's `send` receives the
occurrence ID, exact authored notice, exclusive expiry, and a guard to call
immediately before delivery. Its external service must honor that expiry and
accept identical retries under the same ID. Configure those connections once
in the host. Selecting a connection only through a reminder keeps its raw tools
out of normal agent conversations. [Host connections](mcp.md#connection-settings)

From the application directory run `npx dispatch preview --agent assistant`.
In a second terminal use `npx dispatch chat --preview assistant --as riley`,
or select Riley in preview Web. Ask “Verify my next deadline and show the exact
notice you would send.” Listing shows candidates and source coverage. Checking
runs the same review as delivery and returns the decision, evidence summary and
proposed wording. Reminder preview has no start or send operation.

In the owner's regular private conversation, ask to start or stop reminders.
Keep the host running. The scanner wakes for the next discovery poll or review
deadline, whichever comes first. It consumes no inference while idle. A completed
review waits until the due time, rereads the source and checks eligibility.
A changed revision can trigger a fresh review. Failed reviews can retry until
expiry; the host sends only an authored notice. Late discoveries are reviewed
immediately while the occurrence still qualifies.
