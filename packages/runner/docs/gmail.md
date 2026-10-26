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
label and skip Inbox for each alias, plus a catch-all label for everything else.
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
- Only plain-text MIME bodies are used; quoted reply history is trimmed where
  recognizable. Attachments and HTML-only content are not processed. Quotes and
  forwarded content remain untrusted; the prompt is not a sandbox for tools.
- Only the completed answer is emailed, to the original allowlisted sender,
  never reply-all or an arbitrary Reply-To. From and Reply-To use the addressed
  alias, with proper threading headers. Incoming and sent mail receive the route
  label and are removed from Inbox; unread status is preserved.
- External sending is **not exactly once**. A stable RFC Message-ID enables
  Sent-mail reconciliation after an uncertain send. If no matching sent message
  appears after two minutes, delivery fails for manual inspection rather than
  blindly resending. Successful sends with pending labels retry labeling without
  sending again. Inspect native tasks and Sent mail before manual recovery.

Unsolicited background replies, attachments, HTML rendering, public sender
access, shared cross-sender conversations and push subscriptions are unsupported.
Polling rechecks eligible mail after the fixed boundary; this is intended for a
small dedicated mailbox, not a general high-volume inbox.

## Manual qualification

Send a plain-text message from an allowed, DMARC-authenticated account to one
alias. Expect one reply from that alias and a labeled, archived incoming/sent
pair. Reply in the same thread with a question about a harmless value from the
first turn; expect continuity without quoting the value again. Inspect `chats`,
`snapshot`, native task state and Sent mail, then repeat after a graceful restart.
Also check a non-allowlisted sender, a both-alias message and direct mailbox mail:
none should execute. Build/type checks do not establish these live outcomes.
