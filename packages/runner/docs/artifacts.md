# Documents and images

Call `publish_artifact({path})` to retain and deliver an authorized file. Files
are separate from model text and image-tool observations. `artifact_status`
reports native transport tasks; queued, failed, aborted and completed-without-a-
receipt are **not sent**. Email automatic replies finish after the final response,
so their `afterResponse` tasks are never waited on inside that response.

Local sources accept owned regular files in the conversation's staging directory
(shown in its instructions) or its host-assigned working directory. This grants
no file-creation tools or arbitrary host access. A host can supply
`artifacts.source` to stream bytes from its authenticated workspace; the host,
not model arguments, selects that workspace. Optional source size/SHA-256 is
verified before publication. Binary bytes do not pass through model context.

Native task-owned children publish into their owning user conversation.
Independent instances/processes need an explicit authorized host transfer.
Published files have sanitized names, MIME types, byte sizes and SHA-256 hashes.
They are immutable snapshots; deleting/editing the source does not change them.
Identical bytes/name/MIME reuse one artifact and delivery in that conversation.

`ChatSnapshot.messages[].artifacts` exposes retained metadata.
`service.artifact(chatId, artifactId)` resolves only that conversation's manifest
and verifies its bytes. Direct terminal mode prints retained paths; installed
service clients use:

```sh
dispatch-service service.json download CHAT ARTIFACT ./new-output.pdf
```

Downloads refuse to overwrite an existing destination. Host applications must
apply their own user authentication before calling the service. The local
service socket remains an owner-only boundary, not a multi-user API.

After repairing a failed transport, explicitly call
`publish_artifact({path: "artifact:ID", retryDelivery: true})`. The original
source is unnecessary. Pending or successful deliveries are not duplicated.
Slack retains its allocated file ID for retries and reconciles the exact
originating channel/thread before returning success. An uncertain/expired upload
may still require operator reconciliation; no exactly-once guarantee is implied.
Slack needs installed `files:write` and `files:read` authorization and channel
membership. Updating an app manifest does not reauthorize an installed token.

The email adapter includes published files in enabled automatic replies.
Explicit `email_send` accepts `artifactIds` from the same conversation and
suppresses the automatic reply; select the files explicitly. Sending remains
disabled by default. Hosted Dispatch Web has its own attachment integration and
is not replaced by this Runner API.

Back up the complete private agent directory, including `artifacts/`, with its
native store. First adoption requires an explicit idle `updateDefinitions`
deployment so existing conversations receive the new tools. Keep compatible
runtime/adapters for recovery; byte storage is local even with a remote SQLite
factory. No application-level file-size/count cap is added; provider, memory and
disk constraints still apply.
