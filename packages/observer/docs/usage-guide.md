# Using Dispatch Observer

Observer reads supported Pi stores from a local desktop. The selected source,
logical store, and conversation define the inspection scope. No hosted account,
model credentials, new telemetry database, or agent-side instrumentation is needed.

## This machine

The app starts on **This machine**, refreshing about every five seconds. On macOS
and Linux, `lsof` identifies existing `.sqlite`, `.sqlite3`, and `.db` files open
for writing by the current user's Node, Bun, Deno, Pi, Dispatch or Electron
processes. Observer validates Pi's schema and reads supported stores without
opening an execution owner. It does not recursively crawl directories, request
elevated permissions, or inspect remote machines. Other runtime hosts require
a saved explicit source; unrelated application databases are excluded.

Saved direct SQLite connections are read too, including when their processes have
stopped. All saved work is visible by default. **Process observed** means a
process had the store open at the shown observation time, not that an LLM is
currently generating. Unfinished tasks may be waiting or sleeping. **Unfinished
only** explicitly filters out history. Search finds workflows and conversation
titles; source setup and paths stay in Settings.

Choose a workflow to see its assignments, newest recorded activity first. Select
an assignment to open its conversation; the workflow's other conversations remain
in the rail. **Back to workflow** and the workflow breadcrumb return to the
overview. **Sent by** opens an available sender conversation, including one in
another local agent store. Same-source Back/Forward history remains separate.

Workflow groups come from recognized Runner instance-message envelopes whose
leading lines explicitly declare `workflow:` and `cycle:`. `assignment:` and
`phase:` enrich the view. Matching names alone never group work: namespace,
validated sibling agent-store directory and exact recipient identity must agree.
Sender addresses resolve only against unambiguous chat metadata in available
sources. Missing stores are not opened from message-supplied paths. Arbitrary
prose, replies and definition files do not create workflow membership. This is
an interpretation of saved handoffs, not a native workflow-run table, final
outcome or reconstructed phase graph. No runner change or SQLite migration is needed.

Clicking a conversation saves/reuses its local connection and opens **Conversation**.
The saved integration title is preferred, with the first retained assignment as a
fallback. The conversation opens at assignment context: agent, sender, literal
handoff labels, starting time and the original request when retained. **Read full
handoff** shows the saved text; a requested automatic reply is not labeled as a
received reply. Unknown callers and missing openings stay explicit.
Markdown messages and inline tool rows stay in recorded order. Consecutive tool
events form compact groups; long requests and unknown native records start
collapsed. Peer messages show their recorded sender rather than “You.” Expand
a call or result to read it; shell commands preserve real line breaks, with the
full arguments available separately. Native details open only on request.

An overall read failure retains the last observed list and labels it stale.
Process-discovery failures and individual unreadable sources appear under
**Source notices**; saved local sources remain readable when discovery fails.
Stopped unsaved sources outside validated sibling installations disappear after
a successful refresh; saved sources and discovered siblings remain readable.
Windows discovery is not implemented. Processes hidden by OS permissions, stores
without a writable open handle, extensionless files, remote/Postgres stores, and
non-Pi runtimes require explicit connections or are outside discovery coverage.
No process is started, stopped, resumed or instrumented.

Observer is a desktop app, with a 900 px minimum window width. Mobile layouts
are not a current requirement; earlier small-layout checks below are historical.

## Find the latest recorded workflow

This machine shows saved workflows by default, with consistent names and last
recorded activity dates. Workflows sort by their latest assignment activity, so
a shared sender cannot make an old cycle appear new. Assignments sort newest first;
unknown timestamps are explicit. The **All saved work / Unfinished only** toggle
changes the filter, not the task state. Recency is limited to loaded sources.

Opening a validated Runner source also checks immediate sibling agent directories
for session.sqlite. Stopped coordinator, developer and reviewer stores can therefore
participate without each having an open process. This is not a recursive filesystem
crawl: sibling symlinks and paths embedded in messages are not followed. Unreadable
or mismatched stores produce source notices. Sources outside those installations
still require an explicit connection through Settings.

Open a workflow to see its known sender → assignment links, latest response excerpts,
activity dates and unfinished counts. Missing senders have a Settings recovery action.
**Execution unknown** is deliberate: open files and pending tasks do not prove model
execution. A reported **Changes requested**, **Approved** or other explicit opening
verdict belongs to that assistant response, not the whole workflow's outcome.

In a conversation, **Read latest response** jumps to the response heading rather than
the bottom. If that response is outside the current loaded/playback page, a labeled
dialog displays it without changing the playback boundary. The existing **Latest
activity** control follows the transcript tail instead. Expand a tool call to view
its identity-matched result under **Matching result**, or inspect the original result
event in its saved order. Commands wrap and full arguments remain available.

## Connection setup

Open **Settings** at the bottom of the navigation rail, then **Add connection**.
Saved sources, their management menu, and the System/Light/Dark color theme live
here rather than beside the conversations. **Open** returns to the current
connected source without resetting the view, or connects to a different source.
The menu provides **Edit connection**, **Reconnect**, and **Remove saved connection**.
Removing the current connection returns to This machine; agent data is never deleted.

Settings leaves the workspace mounted. **Done**, the close button, or Escape
returns to the same reading position, expanded tools and inspection state.
Opening Settings pauses automatic playback, not the agent or live connection.
Cancelling Add/Edit returns to Settings; **Save & connect** opens the saved source.

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

The navigation rail lists conversations; filter it by name or native ID. Structure
shows native ownership and fork references, current/final task records, waiting
relationships, attempts, and saved documents. Select a child to inspect its own
scope; select its parent link to return. Expand or collapse the hierarchy without
changing an agent.

Timeline follows durable commit order and shows timestamps only when recorded.
Conversation shows assignment context, saved transcript messages, calls/results,
and context boundaries. Live reads do not move the reading position on opening.
**Latest activity** starts following the end; scrolling away or expanding content
stops movement while updates continue. **Context** returns to the opening without
resuming paused playback.
Messages render Markdown, including lists, tables, and fenced code. Tool events
start inside compact activity groups; expand a group, then click a row or focus it and press Enter/Space
to expand its arguments or result. JSON text envelopes display their decoded text
with line breaks and indentation; additional fields remain under a disclosure.
Other structured results use indented JSON. Command lines wrap inside their panel. **Inspect entry** opens the formatted detail and original redacted
native record. Playback opens the selected tool row without merging separate call
and result events.
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

Content renders as safe Markdown, text, or structured data, never evaluated HTML,
scripts, terminal commands, or arbitrary SQL. Remote images are shown as references
without fetching their bytes. Opening a recorded HTTP(S) link requires an explicit
external-browser confirmation. Provider state, known secret fields, encrypted
thinking signatures, and image bytes are excluded or redacted. This is not complete
secret detection; do not publish raw records or screenshots without review.

## Conversation navigation

Use **Back** and **Forward** above the work title to retrace conversation
selections, or **Parent conversation** to return directly to a child's owner.
Alt+Left/Right and Cmd+[/] provide the same history navigation outside editable
fields and dialogs. These controls are separate from previous/next event playback.
Returning restores the inspection tab, event filters, selected evidence and
live/paused view, but does not restart automatic playback. A new selection after
going back replaces the forward path. Switching connections clears history;
reconnecting the current connection preserves it.

## Compatibility and qualification

Workflow-reading refinement qualification (October 28, 2026, OBS-007, OBS-008,
OBS-010, OBS-012, OBS-013, OBS-015, OBS-018–020): an isolated packaged macOS ARM64
preview read existing local Pi stores without changing agent state. The default
home exposed saved work immediately; validated sibling discovery made previously
unavailable coordinator, developer and tester conversations navigable. The overview
and card agreed on name, latest assignment activity and unfinished-conversation count.
Assignments were ordered by recorded activity, not numeric assignment suffix.
An explicit reviewer verdict appeared in the overview and persistent conversation
header even though its task count was zero. A developer's later tool-only records
did not erase its preceding prose response. The response shortcut landed at the
message heading; invoking it in recorded playback left the playhead at its original
event. Source notices exposed a mismatched sibling rather than silently grouping it.

Call expansion displayed the identity-matched result with its own timestamp and
later-event label; keyboard Return toggled the result disclosure. Commands wrapped
without horizontal hunting. Search/no-match recovery and the unfinished-only toggle
worked. Home, overview and conversation layouts were reviewed at 1440×900 and
1280×720, with light/dark appearances; Settings preserved the response reading
position and paused event. Captures remain private. The user's running app and
normal preferences were not replaced during this pass.

Workspace type/build checks passed in Nix; no automated tests were added or run.
This pass does not requalify Postgres queries at runtime, remote transports,
Windows/Linux, exhaustive machine discovery, permission/connection-loss recovery,
or the out-of-loaded-page response dialog. Multiple-cycle ordering and symlink
alias deduplication received source review but no new runtime fixture exercise.
Existing broader use-case conditions remain unchecked in the catalog rather than
being promoted to blanket verification claims.

Earlier workflow-first qualification (October 28, 2026, OBS-007, OBS-008, OBS-010,
OBS-012, OBS-013, OBS-018): the packaged macOS ARM64 app was checked against
existing local handoffs and isolated synthetic Pi stores. Workflow → assignment
→ conversation navigation, cross-store sender links, return to the overview,
and direct-source opening with workflow context were observed. Stores in separate
installations with identical workflow/cycle/address values stayed separate.
Missing senders remained unlinked; replies and workflow names mentioned only in
prose stayed outside assignment groups. Saved process-free sources, search,
no-match recovery and the all-work filter were exercised.

Opening context and the complete handoff remained available with only the latest
500 entries loaded. New synthetic entries arrived without moving the reader;
Latest activity opted into following, and scrolling away stopped it. Grouped tool
disclosures worked with the keyboard. Playback opened the selected tool, kept
later commits outside its frozen boundary, and preserved the selected event when
earlier pages loaded. Context and handoff dialogs did not resume playback; Escape
returned focus to the handoff opener. Settings preserved the reading position.
Native parent navigation and same-source Alt+Left history retained the paused
event selection. All seven synthetic database checksums were unchanged during
the final packaged-app pass.
Home, workflow, conversation, tool and handoff layouts were reviewed at 1440×900
and 1280×720, including light/dark conversation views. Workspace type/build checks
and macOS packaging passed; no automated tests were added or run.

This qualification does not establish native workflow-run persistence, arbitrary
workflow adapters, final workflow outcomes, remote workflow discovery, other
operating systems, or new transport coverage. Missing-lsof and preference-write
failures were not exercised in this refinement. Synthetic updates were written
only by the sample-data producer, never by Observer; source reading remained
read-only. Private transcript evidence and captures are not public assets.

Settings qualification (October 28, 2026, OBS-005, OBS-014, OBS-015): the packaged
macOS ARM64 app was checked with an isolated profile and a synthetic Pi store.
The work rail contains no saved-connection list or setup/appearance controls.
Settings supports adding, reopening, editing and removing saved sources, and
System/Light/Dark appearance. Add/Edit cancellation returns to Settings with
focus retained; closing Settings returns focus to its opener and preserves the
conversation's scroll position, expanded tool rows, selection and live/paused
mode. Automatic playback stops without moving the playhead. Explicit reconnect,
a missing-file error, recovery through Settings, and removal of the active
profile were exercised; the synthetic database checksum remained unchanged.
Saved names and theme survived an app restart. Home, conversation and Settings
layouts were reviewed at 1440×900 and 1280×720 in light/dark appearances.
Workspace type/build checks and macOS packaging passed. No automated tests were
added or run. Remote transports, other operating systems, protected-password
changes and preference-write failures were not requalified by this UI move.

Local-work qualification (October 28, 2026): the packaged macOS ARM64 app
discovered live local Pi stores, put unfinished conversations first, reused a
saved connection, and opened the selected conversation directly. Saved integration
titles, automatic arrival of new entries, inline multiline commands/results,
history navigation with Alt+Left, search/no-match recovery, and the all-conversations
toggle were checked interactively. Home and conversation layouts were reviewed at
1440×900 and 1280×720. Workspace type/build checks and macOS packaging passed;
no automated tests were added or run. Linux discovery, unavailable-lsof recovery,
process-exit discovery refresh, and remote regressions were not exercised in this
refinement. Windows discovery is explicitly unavailable. Mobile qualification
was removed from the current scope.

Navigation qualification (October 27, 2026): the packaged macOS ARM64 app was
checked interactively for Back/Forward navigation. A synthetic renderer preview
verified paused-event and tab restoration, Alt+Left/Right, forward-history
replacement, and source isolation. Full-page layouts were reviewed at 1440×900,
1280×720, 768×1024, and 390×844. Windows and Linux navigation remain unverified.

The reader supports stock Pi Durable SQLite schema 1 as used by 1.1–1.3,
schema 2 as used by 1.4, and Dispatch's `dispatch_pi` Postgres schema 1.
The sample generator uses Pi Durable 1.4.0 and creates schema 2. The reader
never opens Pi's storage writer or migrates an existing database.
These schema versions do not establish compatibility with future Pi releases.
Custom entry/document kinds retain a generic
record view. Documents are reconstructed from their latest retained base and deltas;
retired contents that no longer exist are marked unavailable. Runner's storage
choice and existing deployments are unchanged.

Interactive qualification on October 22, 2026 used macOS Apple Silicon, Electron
45, Node 24 for builds, PostgreSQL 14, and Linux Node 22.23 for the SSM reader.
Source review and permitted type/build checks supplement these observations;
there is no automated test suite under repository policy.

| Use cases | Observed evidence | Limits |
| --- | --- | --- |
| OBS-001, OBS-016 | Existing local Pi records and synthetic schema-1 data; missing/unsupported input handling; native file selection. | These October 22 observations predate schema-2 support. |
| OBS-002, OBS-005 | Direct Postgres with a SELECT identity and store-specific RLS; only the allowed store appeared. Invalid TLS trust was rejected; a trusted CA succeeded. Saved encrypted password reopened successfully after app restart. | Windows/Linux credential stores unqualified. |
| OBS-003, OBS-004 | TLS Postgres over SSH; SQLite over SSH and SSM on a live Linux agent host. Remote cleanup verified after close. | Postgres over SSM and Windows remote shells unqualified. |
| OBS-006–OBS-010 | Parent/children, waiting workflow, attempt and failure records, native tools and live slot, transcript, generic documents. | Custom workflow-specific phase diagrams are not provided. |
| OBS-011–OBS-014 | Completed live-host history and process-free synthetic records; playback, step/speed/scrub; paused snapshot with new commits; long paginated history; database disconnect/reconnect retaining playback selection. | No exact historical frame or process-liveness reconstruction. |
| OBS-015, OBS-017 | Four rendered sizes, light/dark layouts, keyboard controls, narrow detail drawer, Electron isolation and plain-text presentation. macOS app packaging and launch. | Windows/Linux native execution, installers, touch hardware and formal screen-reader/contrast audit unqualified. |

On October 23, 2026, a fresh workspace install resolved Pi Durable and Chord
to 1.4.0. The sample command generated a schema-2 database, and the isolated
macOS app connected to it and displayed its three conversations, three tasks,
and two documents, including a decoded workflow document. The database's
SHA-256 checksum was unchanged after observation. Workspace TypeScript/build
checks and the native Nix build passed. This does not extend the earlier
remote-transport or Windows/Linux qualification to schema 2.

The October 22 conversation-rendering update was checked against a real
SSM-connected SQLite transcript in the packaged macOS app: a JSON-wrapped
repository result displayed as multiline source with its saved line numbers.
Existing named connection settings survived the app update unchanged.
An isolated interactive rendering preview covered Markdown lists/tables/code,
JSON envelope metadata, invalid JSON and literal backslashes, error/truncation
labels, light/dark themes, keyboard disclosure and code scrolling, call/result
playback, and the narrow detail drawer. Layouts were reviewed at 1440×900,
1280×720, 768×1024, and 390×844.
HTML remained literal text and image references created no image elements.
Workspace type/build checks, the Nix build, and flake checks passed on macOS
Apple Silicon. No automated tests were added or run.

The original mockups remain [design references](design/README.md). Qualification
uses the real app and synthetic/private data; operational captures are not public
package assets. Signed installers, notarization, automatic updates, a hosted viewer,
remote file download, and agent execution controls are outside this implementation.
