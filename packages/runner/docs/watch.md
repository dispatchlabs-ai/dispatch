# Watch local agent sessions

Watch is a read-only terminal viewer for existing on-demand Runner sessions.
Start the work in one terminal, then open the viewer in another:

```sh
company-agents watch --config /path/to/host.json
```

The standalone packaged command is `dispatch-watch --config /path/to/host.json`.
Only `stateRoot` and optional `namespace` are read from that configuration; no
model credential, gateway, definition, workspace or agent runtime is opened.
The viewer reads committed public messages and native task/tool activity. It
does not stream unfinished model tokens or display hidden provider reasoning.

## Navigation

The start screen discovers active local sessions. A single discovered session
opens automatically; Escape returns to the picker. The overview includes each
recorded agent conversation, owned researchers, native task state and latest
activity. A process can own many conversations across several agent stores.
Process presence and unfinished native work are shown separately.

| Key | Action |
| --- | --- |
| Up / Down, j / k | Select a session, agent or recorded event |
| Enter / Right | Open the selection; expand a message or tool call |
| Tab | Switch between agents and recent session activity |
| Escape / Left | Return to the previous view |
| Page Up / Page Down | Move through events or expanded content |
| f / End | Return to the latest conversation events and follow new entries |
| r | Refresh discovery and overview |
| q / Ctrl+C | Close only the viewer |

Opening a conversation follows its newest recorded events. Navigating older
events stops following so new activity does not move the selection. At the first
loaded event, Up or Page Up retrieves an earlier page; all retained history stays
accessible. Enter shows the complete message, or tool arguments and the result
matched by native conversation/call identity. Expanded calls refresh their matching
result in place while preserving the reading position. Return to the conversation
and press f to follow the latest entries again.

The viewer refreshes while open and restores terminal modes on exit. Closing it
does not send signals or messages to agent owners, admit work, alter financial
actions, migrate a database, or start a listener or schedule.

## Select a saved session or capture one observation

```sh
company-agents watch --config /path/to/host.json --session research-session
company-agents watch --config /path/to/host.json --json
```

An explicit session also opens stopped work. With redirected output, Watch prints
one plain-text observation and exits. `--json` provides one structured observation
with source issues and observation times; it does not enter terminal mode.

## Discovery and limits

On macOS and Linux, `lsof` discovers same-user runtime processes holding writable
`stateRoot/SESSION/AGENT/session.sqlite` files. Discovery stays inside the configured
installation. Native schema, Runner namespace and agent identity are checked;
immediate sibling stores supply other participants. Read-only viewer handles do
not count as agent owners. Session state must be owned by the current account and
must not be redirected through symlinks. A missing, unreadable or unsupported
source is reported rather than treated as a completed run.

SQLite schemas 1 and 2 are read through short read-only transactions. No native
Session/Harness is constructed. `status.json` is supporting identity evidence,
not proof of active generation. Native task activity is recorded state, not a
guarantee of ongoing model execution or a successful workflow outcome. Known
credential fields are redacted; terminal controls are displayed as escaped text.

Automatic process discovery is unavailable on Windows; explicit saved sessions
remain addressable. Remote stores and other installation layouts are outside
this command's scope. This initial implementation is qualified on macOS; other
platforms require their own interactive qualification.

The [release composer](nix-releases.md) can keep an existing execution runtime
pinned while adding the viewer from a newer source revision. Installing Watch
does not require opening or upgrading existing agent state.
