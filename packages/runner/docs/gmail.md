# Gmail transport

The optional `@dispatch/runner/gmail` module exports `createAdapter`. Install it
in the existing [agent service](service.md), alongside other adapters. It uses
that service's native SQLite owner, tasks, submissions and conversation catalog;
there is no email-specific model loop or second conversation database.

## Configure

Create the mailbox, receiving aliases, Gmail labels and **verified send-as**
identities first. A receiving alias alone is not a Gmail sending identity.
Authorize the dedicated mailbox for Gmail read/modify/send and settings lookup.
For OAuth clients whose send-as creation API is restricted to delegated service
accounts, use Gmail Settings → Accounts → Add another email address. Do not
enable domain-wide delegation just to add an identity.

Keep a private, owner-only OAuth credential file outside the definition
repository and installation bundle:

```json
{
  "clientId": "YOUR_OAUTH_CLIENT_ID",
  "clientSecret": "YOUR_OAUTH_CLIENT_SECRET",
  "refreshToken": "YOUR_MAILBOX_REFRESH_TOKEN"
}
```

The adapter refreshes short-lived access tokens in memory. Revocation or startup
validation failure leaves the service unable to start; retain existing state and
repair the credential or remove the adapter deliberately. This initial adapter
requires POSIX owner/mode enforcement; Windows qualification is outstanding.

Add the installed `dist/gmail.js` absolute path as a service `adapters[].module`,
with a private options file:

```json
{
  "mailbox": "team@example.com",
  "credentialFile": "/srv/agents/private/gmail-oauth.json",
  "attachmentRoot": "/srv/agents/private/mail-files",
  "maxAttachmentBytes": 20971520,
  "startAfter": 1793059200000,
  "allowedSenders": ["owner@example.com"],
  "routes": [
    {
      "address": "assistant@example.com",
      "agent": "assistant",
      "displayName": "Assistant",
      "label": "Assistant"
    }
  ],
  "pollMs": 15000
}
```

Set `startAfter` to a deliberate epoch-millisecond rollout boundary and **keep it
fixed across restarts**. Earlier mail is not executed. Configure Gmail filters to
label and skip Inbox for each alias, including its From address as well as
To/Cc/delivery addresses, plus a catch-all excluding all those conditions.
Gmail can apply filters to sent mail too; excluding alias senders prevents the
catch-all from also filing agent replies as unrelated mail.
Do not mark messages read automatically. Polling searches archived mail too.

## Supported behavior and boundaries

- Only allowlisted single From addresses with Google-delivered `dmarc=pass`
  and a matching authenticated From domain are admitted. Mailing-list,
  automated, spam, trash and self-sent mail do not execute an agent.
- Exactly one configured alias must appear in To/Cc or delivery headers.
  Multi-alias and unaddressed mail is left filed for human review, without an
  automatic reply. BCC routing requires an alias-bearing delivery header.
- A conversation key contains mailbox, receiving alias, Gmail thread and sender.
  Follow-ups from that sender reuse the native conversation. A different sender,
  alias or thread cannot join its history merely by copying a subject.
- Each delivered message has a stable native request ID and a durable turn task.
  Turns in the same binding wait for their predecessor. Other threads are not
  artificially serialized. Role/tool permissions remain definition-owned.
- Plain text is preferred in multipart alternatives; HTML-only bodies are
  converted to text with entities, structure and links preserved. Scripts/styles
  are discarded, never executed, and remote images/URLs are not fetched.
  Recognizable quoted reply history is trimmed. Quotes, forwarded content,
  filenames and file contents remain untrusted, not authorization.
- Attachments and inline MIME files are downloaded only after sender and route
  checks. Private per-message directories, sanitized filenames, byte counts and
  SHA-256 receipts keep duplicates and different messages separate. Native agent
  tools can inspect the files; text and images use the existing reader, while
  PDF/Office interpretation requires appropriate tools in the host environment.
  No macros, scripts, archives or installers are automatically executed.
- During an active email reply, `email_attach` snapshots user-requested files
  created/copied into that turn's private `outgoing` directory. Other local paths,
  links escaping that directory, non-regular files and hard links are rejected.
  It has no recipient parameter and cannot send unsolicited mail. The final
  native checkpoint freezes the selected files; delivery verifies their hashes.
- Only the completed answer is emailed, to the original allowlisted sender,
  never reply-all or an arbitrary Reply-To. From and Reply-To use the addressed
  alias, with proper threading headers. Incoming and sent mail receive the route
  label and are removed from Inbox; unread status is preserved.
- Replies include both plain text and Markdown-rendered HTML. Raw HTML is
  escaped, unsafe links are rejected by the renderer, and remote images are not
  embedded. Attachments use standard MIME with Unicode-safe filenames. MIME
  composition cannot fetch URLs or read files other than the supplied bytes.
- External sending is **not exactly once**. A stable `X-Dispatch-Delivery` header
  enables reconciliation against Sent messages in the Gmail thread after an
  uncertain send. Gmail can rewrite the RFC Message-ID; it is not the recovery
  identity. If no matching sent message
  appears after two minutes, delivery fails for manual inspection rather than
  blindly resending. Successful sends with pending labels retry labeling without
  sending again. Inspect native tasks and Sent mail before manual recovery.

Unsolicited background replies, public sender
access, shared cross-sender conversations and push subscriptions are unsupported.
Polling rechecks eligible mail after the fixed boundary; this is intended for a
small dedicated mailbox, not a general high-volume inbox.

## File custody and limits

`attachmentRoot` is an absolute private persistent directory. If omitted, it
defaults to `gmail-files` beside the OAuth credential file. **Back it up and
restore it together with native SQLite**, including pending received/outgoing
files. Files are retained for follow-ups and recovery; no automatic purge or
expiration is implied. Old plain-text task records remain compatible.

The default combined attachment limit is 20 MiB per incoming or outgoing message,
configurable through positive integer `maxAttachmentBytes`. Incoming files over
the remaining budget are listed as unavailable with a reason; they are not
silently passed off as readable. Outgoing tool calls enforce the combined budget
atomically, including parallel calls. Provider message limits still apply.

The adapter supplies transport and private custody, not a malware scanner,
document converter or filesystem sandbox. It never follows HTML resources or
opens documents automatically. The installation must expose this adapter only
to trusted agents with appropriate file/document tools and authorization rules.

## Manual qualification

Send a plain-text message from an allowed, DMARC-authenticated account to one
alias. Expect one reply from that alias and a labeled, archived incoming/sent
pair. Reply in the same thread with a question about a harmless value from the
first turn; expect continuity without quoting the value again. Inspect `chats`,
`snapshot`, native task state and Sent mail, then repeat after a graceful restart.
Also check a non-allowlisted sender, a both-alias message and direct mailbox mail:
none should execute. Build/type checks do not establish these live outcomes.

For rich mail, send an HTML-only request containing an entity, list and harmless
marker, with small text/CSV/image/document attachments. Ask the agent to inspect
supported files and return a generated file through `email_attach`. Check both
reply MIME alternatives, exact attached bytes, private file custody, labels and
same-thread follow-up after restart. Verify unsupported formats are described
honestly; storing a file does not establish that the model understood it.
