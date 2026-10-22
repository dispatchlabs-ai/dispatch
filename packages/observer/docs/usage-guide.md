# Using Dispatch Observer

Observer reads supported Pi stores from a local desktop. The selected source,
logical store, and conversation define the inspection scope. No hosted account,
model credentials, new telemetry database, or agent-side instrumentation is needed.

## Connection setup

**Local SQLite:** choose SQLite, keep Direct connection, and browse to an existing
`.sqlite`, `.sqlite3`, or `.db` file. The OS identity running Observer must be able
to read it and any active WAL state. Open the live local database or a consistent
SQLite backup. Copying only the main file while its writer uses WAL can omit data;
use the database's supported backup procedure when making an offline copy.

**Postgres:** enter host, port, database, and database user. TLS verifies the
original database host, including through a tunnel. Supply a trusted CA certificate
for a private CA. Test the connection to list logical stores visible to that
identity, or enter an exact store ID. Observer reads the selected `dispatch_pi`
store only. It does not create tables, migrate a schema, obtain an advisory lock,
or claim an execution session.

Use a database identity with SELECT access to `dispatch_pi.schema_version` and
the intended store's `durable_metadata`, `conversations`, `entries`, `tasks`,
`documents`, and `document_revisions`. Store isolation belongs in database grants
or row-level security where required; choosing a store in the UI does not grant
or revoke database access. Observer also sets the session default to read-only
and uses short repeatable-read, read-only transactions. **No database TLS** is an
explicit option for an appropriately protected connection, never an automatic
response to a certificate failure.

**SSH:** choose SSH under Connect through. Use a hostname or an existing SSH config
alias. Blank user, port, and identity fields defer to that configuration and the
SSH agent. OpenSSH must be installed and the host already trusted in `known_hosts`.
The app uses batch mode and does not accept unknown host keys or prompt for a key
passphrase. For remote SQLite, enter the path as it exists on the remote host and
a Node executable available to its noninteractive shell. POSIX remote shells and
Node.js 22.13+ are supported. The helper runs over SSH stdio without installation.
For Postgres, the database address is resolved from the SSH host; its certificate
must still match that database address.

**AWS Session Manager:** install AWS CLI v2 and its Session Manager plugin and
configure an existing AWS profile. Enter region, instance ID, and optional profile.
IAM and the managed instance must already permit the selected operation. Remote
SQLite uses `AWS-RunShellScript` and `AWS-StartPortForwardingSession` on a Linux
instance with Node.js 22.13+. It creates an owner-only temporary reader directory,
a loopback listener protected by a random per-session token, and an SSM tunnel.
Closing the source requests helper cleanup and terminates that session. If the
client disappears, the helper expires after two idle minutes. No agent service,
security group, IAM policy, or public port is changed. Postgres uses Session
Manager port forwarding (including the remote-host document as appropriate);
that Postgres path is implemented but not yet qualified against an SSM endpoint.

Finder-launched apps also search common Homebrew, local-bin, and Nix profile paths
for CLI dependencies. Windows includes the standard AWS CLI/plugin install paths.
A remote Node executable can be an absolute path when the remote shell's PATH is
minimal. The remote reader is a bundled standalone program, not an agent runtime.

## Saved connections and credentials

Names and non-secret settings are stored locally. Passwords are session-only
unless **Save password in protected OS storage** is selected. Saved passwords
are encrypted with Electron's operating-system credential facility; Linux's
unencrypted `basic_text` fallback is refused. SSH keys and AWS credentials stay
with their existing providers. The renderer never receives a saved password.

Settings default to the platform's application-data directory under
`Dispatch Observer/connections.json`. `DISPATCH_OBSERVER_DATA_DIR` can select an
isolated local directory for development. Never commit that directory or copy a
verification profile containing private connection details into a distributed app.
A locked/unavailable keychain produces an actionable error; re-enter a password
for this session or unlock the existing keychain. Corrupt preferences are preserved
and reported instead of overwritten.

## Following and playback

The source rail lists conversations; filter it by name or native ID. Structure
shows native ownership and fork references, current/final task records, waiting
relationships, attempts, and saved documents. Select a child to inspect its own
scope; select its parent link to return. Expand or collapse the hierarchy without
changing an agent.

Timeline follows durable commit order and shows timestamps only when recorded.
Conversation shows saved transcript messages, calls/results, and context boundaries.
Entries load in pages of 500. **Load earlier events** extends the loaded history;
search and playback cover loaded events, not the entire database. Tool calls and
results are paired within the same conversation, including across loaded pages.
A result recorded later is labeled accordingly when inspecting its call.

Selecting an event or pausing freezes an observation boundary. New events are
counted separately; they do not change the paused event set. Play/Pause, previous,
next, first, last, the scrubber, and 0.5×/1×/2×/4× speed navigate that saved sequence.
Playback advances at an event cadence, not the original wall-clock timing. **Live**
explicitly returns to the current observation. Outside editable controls, Space
plays/pauses and left/right arrows step. Tab reaches controls; pane separators
resize with arrows or pointer dragging. Escape closes a transient detail or dialog.
Narrow windows use a detail drawer with its own playback controls.

Observations refresh about every 1.8 seconds after the preceding read completes.
Unchanged commit sequences reuse the previous projection. Saved running/waiting
states do not establish that a process is alive. Current/final task and document
state remains separate from historical playback; intermediate phases, removed live
slots, provider input, and every token are not recoverable from all stores.

## Errors and recovery

A lost connection preserves the last readable snapshot, timestamp, and paused
selection. **Reconnect** creates a new viewer connection without resuming work.
Editing or switching a source starts a new scope. A failed initial connection can
be corrected and reconnected normally. Missing files are never created. Unsupported
storage versions are reported and never migrated. An unavailable result may be
outside the loaded page, still pending, or absent from retained evidence.

Content is plain text or structured data, never evaluated HTML, scripts, terminal
commands, or arbitrary SQL. Opening a recorded HTTP(S) link requires an explicit
external-browser confirmation. Provider state, known secret fields, encrypted
thinking signatures, and image bytes are excluded or redacted. This is not complete
secret detection; do not publish raw records or screenshots without review.

## Compatibility and qualification

The reader supports stock Pi Durable SQLite schema 1 as used by 1.1–1.3, and
Dispatch's `dispatch_pi` Postgres schema 1. The shared schema number does not promise
compatibility with future versions. Custom entry/document kinds retain a generic
record view. Documents are reconstructed from their latest retained base and deltas;
retired contents that no longer exist are marked unavailable. Runner's storage
choice and existing deployments are unchanged.

Interactive qualification on October 22, 2026 used macOS Apple Silicon, Electron
45, Node 24 for builds, PostgreSQL 14, and Linux Node 22.23 for the SSM reader.
Source review and permitted type/build checks supplement these observations;
there is no automated test suite under repository policy.

| Use cases | Observed evidence | Limits |
| --- | --- | --- |
| OBS-001, OBS-016 | Existing local Pi records and synthetic schema-1 data; missing/unsupported input handling; native file selection. | Other SQLite/runtime versions need qualification. |
| OBS-002, OBS-005 | Direct Postgres with a SELECT identity and store-specific RLS; only the allowed store appeared. Invalid TLS trust was rejected; a trusted CA succeeded. Saved encrypted password reopened successfully after app restart. | Windows/Linux credential stores unqualified. |
| OBS-003, OBS-004 | TLS Postgres over SSH; SQLite over SSH and SSM on a live Linux agent host. Remote cleanup verified after close. | Postgres over SSM and Windows remote shells unqualified. |
| OBS-006–OBS-010 | Parent/children, waiting workflow, attempt and failure records, native tools and live slot, transcript, generic documents. | Custom workflow-specific phase diagrams are not provided. |
| OBS-011–OBS-014 | Completed live-host history and process-free synthetic records; playback, step/speed/scrub; paused snapshot with new commits; long paginated history; database disconnect/reconnect retaining playback selection. | No exact historical frame or process-liveness reconstruction. |
| OBS-015, OBS-017 | Four rendered sizes, light/dark layouts, keyboard controls, narrow detail drawer, Electron isolation and plain-text presentation. macOS app packaging and launch. | Windows/Linux native execution, installers, touch hardware and formal screen-reader/contrast audit unqualified. |

The original mockups remain [design references](design/README.md). Qualification
uses the real app and synthetic/private data; operational captures are not public
package assets. Signed installers, notarization, automatic updates, a hosted viewer,
remote file download, and agent execution controls are outside this implementation.
