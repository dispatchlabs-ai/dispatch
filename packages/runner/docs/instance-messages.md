# Messages between independent instances

Use instance messages for assignments, handoffs and updates between separately
addressable agents. Unlike `delegate` or the private `handoff` helper, recipients
are ownerless top-level conversations with their own configuration, host adapters
and lifecycle. No parent model waits for them. Pi Durable owns tasks, admission,
busy-input queueing and recovery; Runner adds routing, attribution and receipts.
There is no notes store, external broker, new scheduler or supervising LLM.

## Enable and send

Declare the agent types a definition may address:

```ts
export default defineAgent({
  trigger: { mode: "manual" },
  input: "Review the assigned changes.",
  messages: ["reviewer", "author"],
});
```

Open both definitions in one `ChatService` (or the installed service's `names`).
Missing recipients fail startup before stores are opened. An allowlist does not
silently enable definitions, and cycles between messaging definitions are valid.
Definitions without `messages` receive no messaging tools.

The enabled agent can use:

- `agent_instances`: its own ID, allowed agent names and addressable conversation
  identities. It does not expose other conversations' text or tool history.
- `message_agent({agent, instance?, title?, text, reply?})`: supply an existing
  instance ID or omit it (an empty string also means new) to create an independent instance. Include the
  assignment, scope, exact revisions, evidence and any needed knowledge links;
  history and authority are not inherited. `title` applies to new instances.
- `message_status({taskId})`: inspect one of its own message tasks when needed.
  Do not busy-poll for an automatic reply.

The send tool returns `{messageId, from, to, taskId}` after durable admission.
That is not delivery or recipient completion. A native background task submits
the input with `whenBusy: "followUp"`: idle recipients wake and busy recipients
queue the message. No interruption/steering is implicit.

`reply: true` sends the recipient's answer (or explicit unanswered outcome) back
as a new, attributed input to the sender. The sender may react to it, so its
instructions should distinguish replies from new assignments. Replies never
request another automatic reply. Self-messages are allowed only with
`reply: false`; use the existing self ID rather than accidentally creating
another instance. With no reply requested, outcomes remain in native records
without another sender model call.

Local operator clients use the same admission and scope checks:

```sh
dispatch-service /srv/agents/config.json create reviewer "Review release"
dispatch-service /srv/agents/config.json ask author:9 reviewer:9 "Review revision abc123; report only."
dispatch-service /srv/agents/config.json message-status author:9 22
```

Use the actual IDs returned by `create` and `ask`. `message FROM TO TEXT` omits
the automatic reply; `ask` requests one. These commands explicitly act on behalf
of the chosen sender, using its allowlist. They are local operator operations,
not an unauthenticated remote impersonation API. The CLI generates a fresh
request ID for each intentional command.

Applications use `ChatService.message(from, message, requestId)` and
`messageStatus(from, taskId)`, or the corresponding `ServiceCommand` methods.
Retain a stable request ID for retries. Reusing it with different content fails;
the API can omit `instance` to create a new recipient, just like the agent tool.

## Durability, cancellation and scope

The conversation-scoped request receipt and native delivery task are committed
atomically. Tool calls derive their request ID from the native tool task. Replay
uses the same recipient creation key and native submission request IDs, including
the reply. A restart between cross-store commits therefore reuses already
admitted inputs. Another intentional tool call is another message, even if its
text is identical. This deduplicates admission, not arbitrary recipient effects.

Native task checkpoints and entries record queued/delivered state, sender,
recipient, submission and final outcome. Provider errors and aborted inputs are
not reported as successful answers. Unexpected delivery faults appear in the
native task outcome; they are not a promise that an automatic reply arrived.

An ordinary sender turn can finish while delivery/outcome tracking continues.
Stopping its conversation with background cancellation stops that tracking, not
already admitted recipient work. Stop the recipient explicitly when intended.
Graceful service close suspends native work and compatible reopening resumes it.
Keep the namespace, adapters and both definitions available on recovery.

This is trusted, service-local routing, not cross-service transport or multi-tenant
authorization. An allowlisted agent type includes all its instances in that
service. It does not grant new filesystem, provider or human authorization.
Attribution is derived from the executing top-level conversation, not supplied
by the model. Model-facing messages are labeled as peer context.

`ChatService.open` installs the extension automatically. Domain services using
`ChatService.attach` must install the exported
`instanceMessagingExtension(namespace, agent, service)` on each participating
host before resuming it; the service reference must be ready before any task
runs. Standalone `openAgent` rejects opted-in definitions without that extension.
Private delegates cannot impersonate a top-level sender.

## Observe and upgrade

Use the existing service/transport conversation list to find both instances.
`snapshot` shows user/assistant text and active tool names, not complete tool
arguments/results. [Dispatch Observer](../../observer/README.md) reads the native
stores without opening another Harness owner and exposes tool calls, results,
message tasks, entries and submissions. Message bodies and results can contain
sensitive repository or user data; protect the stores accordingly.

Adding `messages` changes the definition fingerprint. Update idle definitions
deliberately or use separate state, preserving backups and pending work. No live
installation changes merely because this source was published. Messaging does
not replace existing delegation/handoff APIs or migrate their saved histories.

## Qualification — October 25, 2026

On macOS Apple Silicon, Node 24 type/build checks passed. Manual synthetic
Astra/max conversations exercised tool-created independent recipients, client
admission, self-continuation, automatic replies, queued delivery while busy,
stable request replay and conflicting retry rejection. Scope checks rejected
ungranted senders/targets, mismatched addresses and automatic self-replies.
Stopping a sender left the recipient running; stopping a recipient returned an
explicit unanswered result. A pending message and its original submission
recovered after graceful service reopening, with history and receipts retained.
Native records included tool arguments/results and ownerless recipient identity.

These observations qualify messaging, not a particular business workflow.
Abrupt process-loss boundaries, other platforms and installation-specific
transport delivery were not exercised. No automated tests were added or run.
