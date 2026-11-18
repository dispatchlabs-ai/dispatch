# Email

`@dispatch/email` exposes selected Dispatch agents through email. Incoming mail
with a configured Gmail label triggers work in the existing native runtime;
configured agents can reply or send new messages from any conversation, including
scheduled work.

**Sending is disabled by default.** Receiving an email does not enable a response.
Set a route's `sendEnabled: true` only when its agent is ready to send.

- [Use cases](USE_CASES.md): approved channel behavior and boundaries.
- [Gmail setup and tools](docs/gmail.md): configuration, filing, file custody and recovery.

This source-alpha package currently supplies a Gmail adapter, not a separate
model loop or conversation database. Install it alongside `@dispatch/runner`.

## Read-only follow-ups

`gmailFollowUpSources({ accountsFile: "gmail-watch.local.json" })` from
`@dispatch/email/follow-ups` provides `mail-thread` (`alias/threadId`) and
`mail-search` (`alias/Gmail query`) for [persistent follow-ups](../runner/docs/follow-ups.md).
Register the sources in the agent definition. The reader checks the mailbox
identity, searches all folders, and reads complete matching threads for messages
since the case baseline. It uses the same message ID across selectors.

Enable the Gmail API and authorize the mailbox for
`https://www.googleapis.com/auth/gmail.readonly` with offline access.
The private account map selects the mailbox and its refresh credentials.

```json
{ "work": { "mailbox": "owner@example.com", "credentialFile": "gmail-oauth.local.json" } }
```

Store `clientId`, `clientSecret` and `refreshToken` in the named credential
file, mode `0600`. Relative credential paths resolve from the account map.
A watch only reads mail and can run without an email route or sending permission.
See Google's [thread search](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list) and [OAuth guide](https://developers.google.com/identity/protocols/oauth2).
