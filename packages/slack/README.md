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
Pi Durable version as the runner. Add a connection to `factory.yaml`:

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

Top-level mentions start a thread. Replies in known threads continue one shared
conversation across human members, with their Slack IDs attributed in model
input. Unrelated channel chatter, bot messages, edits and unconfigured channels
are ignored. `allowedUsers` is optional and limits a connection when present;
omitting it allows human channel members. Direct messages are disabled unless
`directMessagesAgent` is explicitly configured. Do not run competing consumers
for one Slack app: Slack may deliver an event to any of its Socket Mode connections.

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
admission key. Acknowledgement follows durable admission; inference runs after
acknowledgement. Native tasks retain queued input and outgoing reply progress.
User mentions render through Slack's native user elements in final replies and
mention syntax while streaming, so readers see member names rather than raw IDs.
Other control syntax, including broadcast tags, stays literal. Partly generated
mentions wait for completion before streaming, and delivery chunks keep complete
mentions together. No directory lookup or `users:read` permission is required.

Slack delivery is at least once. A crash after Slack accepts a post but before
its local receipt/binding is committed can duplicate it. Delivery metadata and
stable report IDs aid reconciliation, but are not a transactional guarantee.
Streaming failure preserves the final reply, which retries through the native
outbox. The package imposes no global inference concurrency limit.
