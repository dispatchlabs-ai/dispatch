# Gmail transport

Email now belongs to [`@dispatch/email`](../../email/README.md). See its
[configuration, tools and recovery guide](../../email/docs/gmail.md) and
[use cases](../../email/USE_CASES.md).

The `@dispatch/runner/gmail` entry point remains an asynchronous compatibility
forwarder; install the email package alongside Runner. Import `GmailOptions` from
`@dispatch/email`. Existing routes now default to **sending disabled** until
`sendEnabled: true` is configured. Keep SQLite, namespace, rollout boundary and
attachment storage unchanged when upgrading.
