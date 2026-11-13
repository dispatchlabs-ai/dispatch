# Dispatch Google Chat

Expose an existing Dispatch agent through a Google Chat app. The adapter owns
Google authentication, Pub/Sub intake, thread routing, presentation and delivery.
Agent definitions and their command-line operation remain independent.

## Package and host contract

Install the matching prepared package archive beside Runner. `createAdapter(options)`
returns the adapter accepted by `run({adapters})`, and is also the factory used by
`dispatch-service` JSON configuration. A wrapper module is unnecessary. Native
inbox/outbox tasks remain inside the owner; other clients use Runner's common API.

## Host integration

Install this package with `@dispatch/runner`, Pi Durable and Chord 1.5.2. Build
from this workspace with `npm ci` and `npm run check`. The host supplies its
existing model catalog and agent repository:

```ts
import { readFile } from "node:fs/promises";
import { run } from "@dispatch/runner";
import { googleChat } from "@dispatch/google-chat";

const connection = googleChat({
  credentials: JSON.parse(await readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
  config: {
    projectId: "example-agent-chat",
    subscription: "projects/example-agent-chat/subscriptions/agent-host",
    spaces: { "spaces/EXAMPLE": "assistant" },
  },
});
// Supply your existing models catalog; the transport adds no model credentials.
const service = await run({ root: "./agents", models, adapters: [connection] });
// On host shutdown: await service.close().
```

A host that requires one process per conversation can use
`GoogleChatThreadProcesses` with `prepareGoogleChat`. Retain its thread directory
and each child’s native state together. Stop the owning supervisor before backup.
Google route keys include the project, space and real thread resource name.
Start the prepared adapter with its `ChatService` before calling the thread
supervisor's `recover()`: Stop acknowledgement choices use that native store.

## Google setup

Use an operator account in the intended Google Workspace organization for the
app's **first** configuration save. Google binds a private app to that organization;
its trusted testers must belong to it. External members cannot add or interact
with apps in an organization-owned space. Check the actual space owner and
membership before provisioning. See Google's [organization binding](https://developers.google.com/workspace/chat/determine-chat-app-migration)
and [tester access](https://developers.google.com/workspace/chat/test-interactive-features).

Follow Google's [Pub/Sub Chat app guide](https://developers.google.com/workspace/chat/quickstart/pub-sub).
Create a dedicated project, enable Chat and Pub/Sub, and configure the app's topic.
For the standard Chat interaction format, clear **Build this Chat app as a Google
Workspace add-on** and grant only `chat-api-push@system.gserviceaccount.com` the
publisher role on its topic. The host service account needs subscriber and
subscription-metadata read access. Keep its JSON key in the host's credential
store, outside the agent repository and conversation context. Add-on envelopes
are also recognized, but that mode requires Google's separate per-project
publisher identity; never grant arbitrary publishers.

Enable space/group conversations, configure app visibility, and add the app to
the intended space. Mention it with a small request. Expect a threaded answer;
send another addressed message during work to steer the same conversation.
Send an addressed `stop` or `cancel` to stop it. In a space, Google delivers
messages addressed to the app; ordinary unmentioned discussion is not an app
interaction. This adapter does not subscribe to all historical space messages.

## Ownership and recovery

- Pub/Sub acknowledgement follows native durable admission, not model completion.
- Native request IDs deduplicate redelivery. Steering shares the active run's reply.
- Replies use deterministic Google message IDs; uncertain delivery is retried
  without creating another message. Oversized text is split at Unicode boundaries
  within Google's 32,000-byte message limit.
- Public commentary, editable status, final replies and host-authorized workflow
  continuations use native tasks. Continuations wait for an idle conversation and
  recheck the original request through the host's `allowContinuation` callback.
- The automatic working message becomes the first final-answer chunk. Delivery
  waits for its prior status writer before editing it, then retires its status
  receipt so a later Stop preserves the answer. Further chunks use deterministic
  reply IDs. If there was no working message, ordinary reply delivery applies.
- Stop reuses one owned status message for its confirmation, or creates one when
  none exists. The selected message is saved before the Google call and reused
  after retries, stream cleanup and restart. Other published progress remains as
  history. Routine completion and Stop do not delete messages: Google Chat can
  display visible deletion tombstones. App-owned edits use `chat.bot` permission.
- Malformed input is discarded individually with its Pub/Sub message ID logged.
  Transient admission or acknowledgement failures remain eligible for redelivery.
- Hosts enforce company permissions from native input attribution. Space membership
  alone is not an operator grant. Do not authorize from display names or model text.

File uploads require Google user authentication, which this app-identity transport
does not request. Deliver files through your host's authorized artifact links.
Incoming attachment names are identified, but file bytes are not downloaded.

See [use cases](USE_CASES.md) and [changes](CHANGELOG.md). Source/build verification
is separate from live Google app and installation acceptance.

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
