# Gmail transport

`@dispatch/email` exports `createAdapter`. Install it alongside
[Runner's service](../../runner/docs/service.md); use the absolute path to the
email package's `dist/index.js` as `adapters[].module`. The adapter shares that
service's native SQLite owner, tasks, submissions and conversations.

## Configure

Create a mailbox and receiving addresses. Authorize Gmail read/modify access.
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
allowlist or passing DMARC. Multiple addressed routes each receive the message.
To/Cc and delivery headers determine routing; BCC delivery needs an alias-bearing
delivery header. Unrouted mail is filed under `otherLabel` (default `Team / Other`).
Sent mail is filed under its sending route. Inbox is removed, unread status kept.
Gmail filters may file mail immediately but are not required for eventual filing.

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
  incoming input. Recipients and subject default from the message; `replyAll`
  includes original To/Cc, excluding the sending identity. Explicit recipient
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
receive-only. Keep the native namespace, SQLite and attachment root unchanged.
The adapter currently requires POSIX file custody; Windows is unqualified.

Qualify first with sending disabled: a message to one or multiple routes should
trigger native work and filing without producing mail. Then, in an explicitly
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
