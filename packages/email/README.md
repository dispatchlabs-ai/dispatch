# Email

`@dispatch/email` exposes selected Dispatch agents through email. Incoming mail
triggers work in the existing native runtime; configured agents can reply or send
new messages from any conversation, including scheduled work.

**Sending is disabled by default.** Receiving an email does not enable a response.
Set a route's `sendEnabled: true` only when its agent is ready to send.

- [Use cases](USE_CASES.md): approved channel behavior and boundaries.
- [Gmail setup and tools](docs/gmail.md): configuration, filing, file custody and recovery.

This source-alpha package currently supplies a Gmail adapter, not a separate
model loop or conversation database. Install it alongside `@dispatch/runner`.
