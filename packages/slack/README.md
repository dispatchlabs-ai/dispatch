# Dispatch Slack

`@dispatch/slack` is the optional Slack Socket Mode transport for
[`@dispatch/runner`](../runner/README.md). It owns the Slack SDKs, incoming event
admission, shared thread routing, streaming receipts and durable reply delivery.
No web server or public webhook is required.

This is a source-alpha package, installed as a packed archive from reviewed
source. It shares the repository's 0.6.0 development version and has not been
published to npm.
See [use cases](USE_CASES.md) and [changes](CHANGELOG.md).

## Configure

Install both packed packages in a private company repository. Use the same exact
Pi Durable version as the runner (1.4.0 for current source). Upgrade both packages
together and follow the runner's [state upgrade precautions](../runner/README.md#persistence-and-boundaries)
before opening an existing store. Add a connection to `factory.yaml`:

```yaml
agents: []
slack:
  connections:
    example:
      teamId: T0123456789
      botTokenEnv: SLACK_BOT_TOKEN
      appTokenEnv: SLACK_APP_TOKEN
      channels:
        C0123456789: helper
```

Provide the bot token and Socket Mode app token through the host's secret
mechanism. Tokens never belong in the repository. The bot must belong to the
configured workspace and channels. Enable `app_mention` and the normal message
events appropriate for those channels (`message.groups` for private channels,
`message.channels` for public ones), with their read permissions, plus message
posting and Socket Mode. Mentions alone cannot deliver unmentioned thread replies.
See [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).

```ts
import { run } from "@dispatch/runner";
import { slack } from "@dispatch/slack";
import { models } from "./models.ts"; // Your native Pi Models catalog.
const app = await run({ models, adapters: [slack({ connection: "example" })] });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void app.close());
```

Top-level mentions start a thread. Replies in known threads, including replies
sent with "Also send to channel", continue one shared conversation across human
members, with their Slack IDs attributed in model input. Unrelated channel
chatter, bot messages, edits and unconfigured channels
are ignored. `allowedUsers` is optional and limits a connection when present;
omitting it allows human channel members. Direct messages are disabled unless
`directMessagesAgent` is explicitly configured. Do not run competing consumers
for one Slack app: Slack may deliver an event to any of its Socket Mode connections.

To allow a single agent in any channel where its bot has been invited, set
`channels: { "*": helper }`. Explicit channel routes take precedence; this does
not join channels or expand the bot's Slack permissions. Set
`directMessagesAgent: helper` and subscribe to `message.im` with `im:history`
to accept DMs from workspace members.

When bots share a channel, list the other bots' Slack user IDs in
`peerBotUserIds`. Messages explicitly mentioning a peer are ignored unless this
bot is also mentioned. An assistant used inside other bots' threads can select
`threadReplies: started`: its own top-level mention threads and published report
threads accept ordinary replies, while questions in other threads require a
fresh mention. Each top-level DM starts a conversation; replies in its thread
continue that conversation without another mention. Thread ownership is retained across
restart; human mentions do not count as peer-bot addressing. The default `all`
keeps accepting unmentioned replies in every registered thread.
New mention and DM conversations include `origin.slack` with `teamId`,
`channelId` and `threadTs` for a company initializer. Existing report origins
are preserved.

`onActionToken` optionally hands an incoming search credential and its verified
workspace/channel/thread/requester identity to trusted host code before input
admission. Keep this callback local and idempotent: redelivery may repeat it.
Tokens never enter native task input or model context. The host owns secure
credential storage, expiry handling and any search policy; the callback alone
does not authorize a conversation or expand Slack scopes.

## Publish a report with a discussion

Retain the adapter returned by `slack()` and use its `publish` method after the
runner has started:

```ts
const thread = await transport.publish({
  agent: "helper", channel: "C0123456789", text: "Completed review…",
  key: "review:revision:part-0", title: "Review discussion",
  origin: { kind: "review", reviewKey: "revision" },
});
```

The operation posts the report and binds its root to a durable conversation
before returning its receipt. Supply `thread` for subsequent parts. The domain
initializer resolves the origin and configures the discussion inside the native
creation transaction. Preserve the receipt in the domain workflow. On startup,
`transport.bindThread(service, { agent, channel, thread, origin, title })` restores
bindings for existing report receipts without reposting or rerunning reviews.

Incoming copies of `message` and `app_mention` and Slack retries share a native
admission key. Acknowledgement follows local durable admission and does not wait
for thread lookup or inference. Native tasks retain incoming messages, retry
thread lookups using Slack's retry delay, and preserve admission order within
each thread across restarts. A deleted thread leaves a recorded failed admission.
Known unrelated threads are filtered without a Slack API request when the event
identifies their parent author. Existing admission keys survive the inbox upgrade.
Native tasks also retain outgoing reply progress.
The native Slack thread loading indicator stays active during model/tool work,
including quiet periods, and is renewed before its two-minute timeout. Status
failures never block execution or final delivery; an interrupted process may
leave the indicator until Slack expires it. This uses the existing `chat:write`
scope through `assistant.threads.setStatus`, not an additional assistant grant.
Thread status reads the current native run, including after a reply clears
Slack's indicator, so a completed or queued turn cannot clear active work.
Short answers stream normally. Once the model starts tools, or before an initial
stream reaches eight minutes, the adapter closes the stream and updates the same
message with the latest public response and execution-derived progress: the
current tool round's finished/total count, model retry or context preparation,
and elapsed time in ten-second increments. A finished tool is not necessarily a
successful tool. These updates do not depend on model narration or invent a
percentage complete. Slack updates are paced and may lag during API failures.
Later model responses replace the progress text, including after restart;
private reasoning and tool names, arguments and output are not displayed. This
avoids Slack's ten-minute stream expiry marking active work as failed.
Final delivery replaces progress with
the committed answer. See [Slack's response guidance](https://docs.slack.dev/ai/developing-agents/#responding-to-the-user).
Final replies use Slack's Markdown blocks, matching the Markdown sent while
streaming, so bold text, inline code and source links retain their formatting.
Final messages split at complete Markdown blocks where possible. A block too
large for one message is delivered in literal text chunks, preserving its source
instead of interpreting broken code fences or links in separate messages.
User mentions retain Slack's mention syntax in streamed and final replies.
Other control syntax, including broadcast tags, stays literal. Partly generated
mentions wait for completion before streaming, and delivery chunks keep complete
mentions together. No directory lookup or `users:read` permission is required.

Slack delivery is at least once. A crash after Slack accepts a post but before
its local receipt/binding is committed can duplicate it. Delivery metadata and
stable report IDs aid reconciliation, but are not a transactional guarantee.
Streaming failure preserves the final reply, which retries through the native
outbox. If a stream message was deleted, delivery clears its saved timestamp and
posts the completed answer as an ordinary thread reply. The package imposes no
global inference concurrency limit.

## Thread processes and steering

Additional messages use native in-run steering, not after-completion follow-ups.
They share the active run's answer; a separate response is produced only for a
new run. Native tool boundaries still determine when steering is consumed.
`onInput` lets a trusted host wake an owned observation without cancelling work.
Exact authenticated `stop` or `cancel` messages bypass ordinary admission waits.

Opt into `SlackThreadProcesses(directory, launch, stopped)` through `threads`.
The host launches one trusted entry point per workspace/channel/thread and gives
it a separate native state directory. Attach its adapter with `start(service,
false)`; only the supervisor connects Socket Mode. Forward IPC `receive` to the
worker adapter. Report `idle` with the last admitted input key only after native
and descendant work are idle. Report `stream` events with key/ts/done; supplying
`eventId` requests an `eventSaved` acknowledgement after fsynced receipt storage.

The launch callback receives `cancelPending`: clean retained tasks without
replaying them before signalling readiness. Routing records persist cancellation
cutoffs before termination. Newer inputs may resume the same history, while
cancelled inputs cannot restart it. Unexpected worker exits recover active work;
closing the supervisor suspends it. There is no global concurrency cap. The
`stopped` callback finalizes saved streams and cancels host-owned external work.
Remote jobs, existing-history migration and company authorization remain host
responsibilities. Slack's post/receipt crash window remains at least once.

Hosts may supply `allowProgressText(conversationId, inputIds)` to withhold partial
model text until required evidence exists for the current inputs. Native activity
status continues; the host must separately enforce its final-answer policy.
