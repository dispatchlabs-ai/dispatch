# Gmail transport

`@dispatch/email` exports `createAdapter`. Install it alongside
[Runner's service](../../runner/docs/service.md); use the absolute path to the
email package's `dist/index.js` as `adapters[].module`. The adapter shares that
service's native SQLite owner, tasks, submissions and conversations.

## Configure

Create a mailbox, agent labels and sending identities. Authorize Gmail
read/modify access.
Sending also needs the send and settings access used to verify sending identities;
receive-only startup does not query send-as settings. A route needs a verified Gmail send-as identity **only when
sending is enabled**. A receiving alias is not automatically a send-as identity.
Where Google's send-as creation API requires domain-wide delegation, add the
identity through Gmail Settings instead of enabling delegation solely for this.

Keep an owner-only OAuth file outside repositories and installation bundles:

```json
{
  "clientId": "YOUR_OAUTH_CLIENT_ID",
  "clientSecret": "YOUR_OAUTH_CLIENT_SECRET",
  "refreshToken": "YOUR_MAILBOX_REFRESH_TOKEN"
}
```

Use a private options file, for example:

```json
{
  "mailbox": "team@example.com",
  "credentialFile": "/srv/agents/private/gmail-oauth.json",
  "attachmentRoot": "/srv/agents/private/mail-files",
  "startAfter": 1793059200000,
  "otherLabel": "Team / Other",
  "routes": [
    {
      "address": "assistant@example.com",
      "agent": "assistant",
      "displayName": "Assistant",
      "label": "Assistant",
      "sendEnabled": false
    }
  ],
  "pollMs": 15000
}
```

Any directory-defined agent can have a route; names and roles are not hardcoded.
Keep `startAfter` fixed across restarts. Mail before that deliberate rollout
boundary is not executed or refiled. Missing labels are created. Polling includes
archived, automated, list, spam and trash mail; it does not require a sender
allowlist or passing DMARC.

**The configured `label` selects incoming work; `address` is the agent's sending
identity, not a recipient filter.** Labels are matched by exact Gmail name and
resolved to message label IDs. For example, a notification addressed to
`team@example.com` with label `Assistant` triggers `assistant`. An alias-addressed
message without that label does not. Use Gmail filters, manual labeling or an
upstream integration to apply routing labels. A filter can match an alias,
notification source or any other supported criteria; no alias change is required
at the sender. The adapter does not create these routing filters.

Multiple route labels each receive the message. Applying another route label
later admits that route on the next poll, provided the message is at or after
`startAfter`. Removing/reapplying a label does not replay already-admitted work,
and removing it does not cancel work already admitted. Labels on other messages
in the thread do not select this message. No recipient/delivery header is needed
for routing, including Bcc mail.

Unrouted mail is filed under `otherLabel` (default `Team / Other`), which must be
distinct from all routing labels. Sent mail is filed under its sending route;
that route's own sent copy does not trigger it again. Other route labels still
admit work, including mail between agents. Inbox is removed, unread status and
unrelated labels kept. Gmail filters may file mail immediately, but the adapter
also handles eventual filing and removes the catch-all when a route label appears.

For independent workers sharing a mailbox, set `unrouted: "ignore"` on each
label-scoped adapter. Messages without its route labels or owned sent identity
are left completely unchanged; Gmail filters or another designated consumer must
file unmatched mail. The default `"file"` retains catch-all filing. Use disjoint
agent/store ownership across processes, not multiple writers to one native store.
Multiple labels still fan out through their respective workers. This does not
provide mailbox-level access isolation or optimize the full polling scan.

Polling defaults to 15 seconds and rereads messages since `startAfter`; this is
not push/history-based synchronization. The rescan detects labels applied to
previously seen mail as well as new deliveries. No performance qualification for
large mailboxes is implied.

**Enablement is explicit:** `sendEnabled` defaults to false and blocks both tools
and automatic replies. With sending enabled, a final answer is automatically
replied to the incoming Reply-To (or From). Set `autoReply: false` to use explicit
sending only. `email_send` during the incoming turn suppresses its automatic final
reply, avoiding an extra copy. Settings are loaded on service startup; restart
through the installation's controlled owner-replacement workflow.

These are trusted agents, not sandboxed public bots. Incoming sender claims,
quoted text and attachments do not grant authority. Existing role/tool permissions
still apply. Review those permissions before accepting outside work or enabling
sending, including any risk of agents automatically replying to each other.

## Agent tools

- `email_accounts`: list this agent's configured addresses and enablement.
- `email_send`: durably queue mail from any conversation, including schedules.
  Supply `text`; optionally `from`, `to`, `cc`, `bcc`, `subject`, `html`, and
  `attachments: [{path, filename?}]`. Each recipient is a single mailbox address.
  Choose `from` when the agent has multiple addresses. Only the agent's own
  configured identities can send; another agent's enablement grants no access.
- For a reply, supply `replyToMessageId` using the Gmail message ID shown in the
  incoming input. Reply ownership follows the route label or its durable admission
  receipt, not the recipient address; removing a label after admission does not
  revoke the ability to reply to that work. Recipients and subject default from
  the message; `replyAll` includes original To/Cc, excluding the sending identity. Explicit recipient
  lists override these defaults. Replies can also reference the agent's sent mail.
- `email_delivery_status`: inspect the returned native `taskId` in the same
  conversation. Queued is not sent. Completed delivery includes the sent Gmail
  message ID; it does not prove recipient receipt or reading. Failures are visible
  in native task state. A tool retry recovers the same queued task.
- `email_attach`: compatibility helper for automatic final-answer replies. Create
  or copy authorized files into the incoming turn's private `outgoing` directory,
  then call with `path` and optional `filename`. Explicit `email_send` instead
  accepts authorized local files directly and freezes its own attachment bytes.

Example request to an enabled agent: “Email person@example.com a short update with
subject Project update, and attach the report I asked you to create. Check the
email delivery status before telling me it was sent.”

Native background replies also use the durable outbox: destination `channel` is
an owned sending address, `thread` a received Gmail thread ID, and `user` the
recipient. Unknown thread bindings fail rather than guess; use `email_send` for
new messages.

## Content, files and recovery

Plain text is preferred in multipart alternatives. HTML-only input is converted
to text without fetching resources or executing scripts. Full quoted/forwarded
content is retained as untrusted input. Input lists attachment metadata and paths;
interpretation depends on installed tools. Transport does not execute attachments
or act as a document converter or malware scanner.

Outgoing text gets a safe Markdown-rendered HTML alternative unless `html` is
explicitly supplied. MIME composition cannot fetch URLs or read file references
from HTML. Explicit HTML is caller-authored content, not a sanitizer. Bcc is
included in submitted raw MIME so Gmail can deliver it; recipient-facing Bcc
handling is the provider's responsibility.

`attachmentRoot` defaults to `gmail-files` beside the OAuth file. **Back up and
restore it with SQLite.** Private files are retained for follow-ups and recovery,
with owner/mode checks, hash verification and frozen outgoing snapshots. Stored
filenames are hashes; full sanitized names remain in metadata/MIME. Historical
paths and task records remain readable. There are no adapter attachment-size,
file-count, filename-length or HTML-input-length caps. Real provider/host/tool
constraints still apply and are reported rather than replaced with invented caps.

Native conversation bindings retain mailbox, address, Gmail thread and sender;
this preserves existing histories without merging different senders' private
context. Each route/message is admitted once, and follow-ups in the same binding
wait for their predecessor. Other threads have no invented concurrency limit.

Sending is not exactly once. A durable pre-send checkpoint and deterministic
`X-Dispatch-Delivery` header support reconciliation after uncertain sends. Replies
search their Gmail thread; new messages search Sent mail since the attempt.
Gmail may rewrite RFC Message-ID, so it is not used as the recovery identity.
After two minutes without confirmation, the native task fails for manual review
instead of risking a blind resend. Definitive provider 4xx rejections (except
408/429) fail with the status; labeling failures retry without resending. Disabling
sending blocks queued, not-yet-attempted mail; already-attempted mail is reconciled
and filed, never resent merely because enablement changed.

## Migration and qualification

Include both email and Runner archives in the service installation bundle. The
old `@dispatch/runner/gmail` entry point forwards to the installed email package;
new integrations should import `GmailOptions` and `createAdapter` from
`@dispatch/email`. Remove obsolete `allowedSenders` and `maxAttachmentBytes`
options: neither is enforced. Existing routes without `sendEnabled` become
receive-only. Routing now uses the existing `label` field rather than recipient
headers. Before rollout, verify Gmail filters apply the intended route labels to
each incoming message (including follow-ups); aliases alone no longer trigger
work. Existing route/message receipts prevent replay, while previously unrouted
labeled messages after `startAfter` become eligible. Keep the native namespace,
SQLite and attachment root unchanged.
The adapter currently requires POSIX file custody; Windows is unqualified.

Qualify first with sending disabled: a message carrying one or multiple route
labels should trigger native work and filing without producing mail. Then, in an explicitly
enabled qualification installation, inspect new mail, replies, reply-all, Bcc,
HTML and attachment bytes. Repeat native recovery after restart, including an
uncertain new-message send. Builds and simulated-provider checks do not establish
live Gmail acceptance or recipient-visible Bcc behavior.

On October 27, 2026, interactive native-runtime qualification with a simulated
mail provider observed multi-route receive-only work without sends, explicit
sending from a non-email conversation, owned-address enforcement, reply-all,
HTML/Cc/Bcc MIME, an exact 20 MiB + 1 byte attachment, and a 144-character filename.
An uncertain new-message send recovered the same task across close/reopen with
sending disabled, without another send. A not-yet-attempted queued message was
blocked after disablement; an explicit reply suppressed the automatic final
reply. Reused model call IDs in separate native tool tasks produced distinct
messages. Disposable stores were removed. These observations are not live Gmail
or recipient-visible Bcc qualification; no automated test suite was added.

A subsequent label-routing check used native SQLite with simulated Gmail. Shared
inbox mail selected two routes solely by label; alias addressing alone did not.
Adding a label later admitted work, and reopening native stores retained the same
admission task IDs without replay. A route's sent copy did not trigger itself,
but another route label admitted it to that agent. Reply admission accepted a
label-owned shared-inbox message and a previously admitted message whose label
was removed; another route's mail was rejected. Sending disabled blocked tool
admission. The first received thread binding persisted and admitted an enabled
background reply. No model work or real delivery was executed in this check.
