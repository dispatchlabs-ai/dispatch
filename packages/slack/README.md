# Dispatch Slack

`@dispatch/slack` is the optional Slack Socket Mode transport for
[`@dispatch/runner`](../runner/README.md). It owns the Slack SDKs, incoming event
admission, shared thread routing, streaming receipts and durable reply delivery.
No web server or public webhook is required.

Each public assistant response has its own chronological Slack message/stream.
Completed text is retained across tools, steering and native completion-hook
continuations, including intermediate `final_answer` responses. The eventual final
uses its existing response identity, not a second copy. Private thinking and raw
tool payloads are never included. Native completion tracking remains independent.


Hosts observing external workflows can pass `transport.queueStatus` as Runner's
`createWorkflowProgress.statusSink`. Its stable key selects one editable message;
unchanged waiting state does not create repeated thread replies. Status writes
coalesce, serialize per key, retry, and recover the timestamp using message
metadata after an uncertain initial post. Thread-history access is required.

Trusted hosts can call `queueContinuation` with the original request identity
and supply `allowContinuation` to revalidate it in the native admission commit.
It waits for active work and queued human input, then resumes only an unfinished
matching request. Cancelled, completed or replaced requests are discarded.
Admission and recovery use native tasks and submission identities.

Install matching Runner and Slack archives from [Dispatch releases](https://github.com/dispatchlabs-ai/dispatch/releases).
The packages share the repository's lockstep version; they are not published to npm.
See [use cases](USE_CASES.md) and [changes](CHANGELOG.md).

Runner's [artifact tools](../runner/docs/artifacts.md) upload documents/images
to the authenticated originating thread using Slack's external-upload flow.
Install both `files:write` and `files:read` scopes and reauthorize existing apps.
Native upload identities survive retries; success requires a matching Slack
file/thread receipt. Text replies and image observations are not file delivery.

## Package and host contract

Install the matching prepared package archive beside Runner. `createAdapter(options)`
returns the adapter accepted by `run({adapters})`, and is also the factory used by
`dispatch-service` JSON configuration. A wrapper module is unnecessary. Native
inbox/outbox tasks remain inside the owner; other clients use Runner's common API.

## Configure

Install both packages in the agent application's repository. Use the same exact
Pi Durable version as Runner (1.5.2 for current source). Upgrade the packages
together and follow Runner's [state upgrade precautions](../runner/README.md#persistence-and-boundaries)
before opening an existing store.

For the ordinary host launcher, add the adapter to `host.json`:

```json
{
  "adapters": [
    { "module": "@dispatch/slack", "optionsFile": "slack.local.json" }
  ]
}
```

Put the connection settings in `slack.local.json`, relative to the host's working
directory. For an agent defined in `agents/helper/agent.md`, a DM-only connection is:

```json
{
  "config": {
    "teamId": "T0123456789",
    "channels": {},
    "directMessagesAgent": "helper"
  }
}
```

Supply `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` through the host's environment.
Alternatively, the private options file can include
`credentials: { botToken, appToken }` beside `config`; exclude that file from Git
and restrict it to the host account. Start `dispatch serve --config host.json`.
Slack, terminal and Web then use the same host and native conversations. No
additional agent implementation, Slack-only host or `factory.yaml` is required.

For DMs, enable the app's Messages tab and allow users to send messages. Subscribe
to `message.im` and install `im:history` and `chat:write`. Reauthorize the app after
adding scopes. Each top-level DM starts a conversation; reply in its thread to
continue it. Send `stop` or `cancel` in that thread to stop its active work.

Open the conversation in the terminal with `/chats` or select its Slack-labelled
row in Web. Messages sent there appear in the same Slack thread with a bold
`User · Web` or `User · CLI` heading and a quoted body, followed by the agent's public replies. Slack's own
messages are already in the thread and are not echoed. All three clients use
the same saved conversation; starting a separate conversation does not link it.

The adapter observes native conversation changes and admits delivery into its
existing durable queue. Startup catches up missing turns, including history
written before this feature was installed, using retained entry/generation IDs
to avoid reposting delivered responses. Catch-up posts appear at the end of the
Slack thread; Slack cannot insert them at their original historical positions.
Human messages use the bot's identity with an explicit source label. The shared
client contract does not carry a verified human name; the Slack recipient is not
assumed to be the author. Long user messages retain attribution and quotation on
every part. Stop does not discard an already-saved human message.
The existing host authorization and Slack route/user restrictions still apply.
Only public message text is mirrored. Attachment names are listed, but this does
not upload their bytes; raw tools, system instructions and thinking stay out of
Slack's transcript. Slack message edits/deletions are not history synchronization.

Applications using `run({adapters})` may instead keep named connections in an
optional `factory.yaml`:

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

One Slack app can route several channels to the same agent with different trusted
profiles. A channel value may remain an agent name or use this object:

```yaml
channels:
  C0123456789:
    id: engineering-v1
    agent: helper
    instructions: Summarize implementation decisions and their evidence.
    context:
      project: example
    capabilities: [wiki.read]
  C0987654321: helper
```

Profiles are host configuration. The adapter snapshots the selected profile in
the admitted input and exposes it as `origin.slack.profile` when creating a native
mention conversation. With thread supervision, `thread.json` pins that exact
snapshot along with the agent; changing the channel configuration affects new
threads. Hosts receive it through `thread.profile` and decide how to apply its
instructions, context and capability selection. The package neither grants
tools nor interprets the profile as permission. Enforce actual grants in trusted
host adapters; message text cannot supply or replace this profile. Existing
report origins and string channel routes retain their behavior.

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
The loading indicator runs in a separate native background task, so status API
requests never hold text delivery. It resumes after restart and clears after the
reply task settles, rechecking the current thread before each status write.
Each native assistant generation gets its own public response task. Its stream
shows only public text blocks; tools and thinking never enter that prose. Once
committed, the response is finalized in place, preserved, and followed by a NEW
message for the next response. Completion-hook continuations, commentary, tool
rounds and steering cannot replace a completed response. The eventual final is
not duplicated. Identical text in distinct native responses is retained twice.
A successful tool-only termination does not invent an empty-answer warning.

Native generation/entry identities, response ownership, chunk offsets and ordered
predecessor tasks survive restart. Coalesced observations scan committed entries
so fast intermediate final answers are not lost. Streaming touches only the
current unfinished response. Retry/restart may correct that response's partial;
it never writes later generations into an earlier response. At eight minutes it
closes that current stream before continuing to edit its unfinished partial;
committed long responses split into ordered Slack-sized messages without an
application response-length limit. Stop closes current streams without replacing
their text or deleting prior responses, with a separate keyed acknowledgement.

Tool activity stays in the independent native thread loading indicator. Hosts
can supply `describeTool({name,arguments})` for safe labels/subjects. Select only
public fields; never credentials, raw commands or tool output. No extra model
summary pass or raw private reasoning is exposed.

This changes the native `slack-turn` task to version2. Upgrade an old owner only
at native idle with no unfinished version1 deliveries; retain its original
runtime for existing tasks rather than reinterpret old run-wide stream memos.
Back up the complete closed state before changing release selection.
See [Slack's response guidance](https://docs.slack.dev/ai/developing-agents/#responding-to-the-user).
Replies use standard Markdown in Slack's Markdown blocks and streams: headings,
bold text, lists, blockquotes, inline/fenced code, links and pipe tables. Use
`[label](https://example.com)` and tables with header/separator rows; do not wrap
tables in code fences or pre-convert replies into Slack `mrkdwn` or Block Kit JSON.
Direct posting tools still follow their own declared payload format. Code stays
literal, including angle brackets and ampersands, while ordinary Slack control
syntax is escaped.
Final messages split at complete Markdown blocks where possible. A block too
large for one message is delivered in literal text chunks, preserving its source
instead of interpreting broken code fences or links in separate messages.
User mentions retain Slack's mention syntax in streamed and final replies.
Other control syntax, including broadcast tags, stays literal. Partly generated
mentions wait for completion before streaming, and delivery chunks keep complete
mentions together. No directory lookup or `users:read` permission is required.

Slack posts are reconciled with deterministic native response/chunk metadata;
initial streams carry a deterministic public block marker because Slack's
supported startStream API has no idempotency-key parameter. Intent is committed
before opening. After uncertain creation, history lookup recovers the timestamp;
if no marker is visible the task stays pending rather than blindly creating a
duplicate stream. Resolve access/history failures and inspect native delivery
before retrying. Canonical current-response edits are idempotent. Slack history
and effect/receipt persistence are not one transaction, so this is not a global
external exactly-once guarantee. Definite deleted-message errors permit recovery;
uncertain creation remains explicit. The package has no inference concurrency cap.

## Thread processes and steering

Additional messages use native in-run steering, not after-completion follow-ups.
They share native execution, but each public response is retained independently. Native tool boundaries still determine when steering is consumed.
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

The optional fourth constructor argument is a `SlackThreadExecutor`. It receives
the thread key, native directory, pinned input, cancellation state and the resolved
`ThreadLaunch`, plus an awaited event handler. Return a `SlackThreadExecution`
with `request`, `close` and `exited`; `child.pid` is optional for remote owners.
The default still creates a local Runner `ProcessScope`. Remote executors must
preserve the resolved release, enforce one owner and terminate or fence it before
reporting cancellation. A normal `close` suspends retained work; `cancel` must
persist cancellation before acknowledging. Do not forward the launch environment
or host credentials to an untrusted workspace. Await the event handler before
acknowledging stream events so their receipts have reached durable storage.

Hosts may supply `allowProgressText(conversationId, inputIds)` to withhold partial
model text until required evidence exists for the current inputs. Native activity
status continues; the host must separately enforce its final-answer policy.

`runSlackHost` composes this protocol without a second scheduler. Supply `root`,
`stateRoot`, the trusted `entrypoint`, `runner`, Slack config/credentials and an
`open` callback that opens suspended native stores using the provided bindings.
It handles supervisor/`--thread` modes, stream acknowledgements, cancelled recovery,
steering and shutdown. Supply `stopThread` and `threadBusy` for independently
enforced external workspace ownership; `allowProgressText` receives the opened
service. `ready` runs only after supervisor recovery. It never starts calendars.
An existing non-threaded installation still needs an explicit history migration.
Pass `executeThread` to select a trusted remote executor after the existing
application-release pin is resolved. The fleet package's
[`FleetSlackThreads` and `createFleetSlackRun`](../fleet/README.md) implement this
composition for its coordinator/worker protocol.

A route change selects the agent only for a new thread. Saved threads retain
their admitted agent for follow-ups, Stop, and worker-side routing. Hosts must
open the recorded `thread.agent`, including its message recipients.

For immutable installations, `runSlackHost({ retainRelease: true })` also retains
the initial application root, entrypoint, Node executable and Node flags per
thread. Keep those release paths installed while a thread can be resumed. A
pre-existing thread with native state must be pinned to its original installation
before enabling this option. Older non-threaded histories require an explicit
migration before changing routes.

### Worker Web API relay

Native Slack admission and reply tasks can run on a worker without Slack tokens:

```ts
import { createSlackWebApi, prepareSlack, slackThreadConfig } from "@dispatch/slack";

const transport = await prepareSlack(root, runner, {
  config: slackThreadConfig(config, pinnedThread),
  webApi: createSlackWebApi((method, args) => trustedRelay({ method, args })),
  onStream: event => retainAtCoordinator({ type: "stream", ...event }),
});
// Open suspended native stores with transport.extension, then attach them:
await transport.start(service, false);
```

The relay replaces only Web API calls. Native tasks still own admission,
streaming checkpoints, retry decisions and delivery receipts. Relay mode never
reads Slack credentials or opens Socket Mode; `start(service, true)` fails.
The coordinator remains the single Socket Mode consumer. The host must validate
the original team/channel/thread and allowed method on every request, track
message/file ownership, and refuse caller-supplied tokens or alternate targets.
Retain Slack provider errors as `{ ok: false, error, retryAfter? }` so the native
tasks keep their existing retry behavior; the relay adapter adds no blind retry.
Artifact bytes use the existing exact `https://files.slack.com` upload allocation
and retained native file ID; the worker needs access to that upload endpoint.

## Trusted common-client input

The prepared transport's `receive(input)` accepts optional `files` containing
Runner `AttachmentFile` values (`name`, `mimeType`, base64 `data`). This is a
trusted host binding for actual bytes, not permission to download arbitrary URLs
or filenames from channel events. It validates native text/image content and
carries it through the existing incoming/turn/delivery tasks, retaining
`text`/`attachments` in native message metadata. Admission/user/channel policy,
native request keys, retries, cancellation and delivery remain unchanged. Company
facades must bind the authenticated requester and original thread; never accept
a caller's source/user claim as authority. Validate authored model image support
before admitting an image in a custom channel facade.

Prepared transports declare their explicit `transport` for Runner multi-adapter
background reply routing. Multiple accounts of the same transport require the
company's trusted `run({replySink})` routing; untagged destinations are supported
only with one adapter. This does not merge unrelated channel threads.

Stop acknowledgement I/O is queued as a separate native presentation task in the
transport host. Its history lookup, message and status retries never invoke native
Stop again. Incoming Stop records cancellation completion before acknowledgement
admission; crashes during unfinished cancellation still recover it, while admitted
acknowledgements survive restart independently. ThreadProcesses retains its
original cancellation cutoff and workspace cleanup boundary. `stopStreams` now
returns after durable acknowledgement admission, not external delivery; inspect
native acknowledgement task outcome for actual delivery.
