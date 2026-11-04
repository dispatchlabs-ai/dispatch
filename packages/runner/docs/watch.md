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

The start screen discovers active local sessions. A single session opens
automatically; a session with one conversation opens directly into its updates.
The latest public agent update stays above the history, alongside current activity
and elapsed time. Wide terminals also show a clickable agent sidebar. Narrower
terminals use the same views without the sidebar; **a** opens the agent list.
Process presence and recorded task state remain separate from reported outcomes.

**Updates** groups consecutive tool activity between messages. Each group shows
how many calls returned, reported errors, or have no recorded result. Open the
group to see readable action labels and open an action for its exact arguments
and matching result. Labels use recorded descriptions, paths, or literal shell
progress labels; they are not model-generated summaries. **All activity** shows
individual paired actions; **Errors** shows tool errors in the loaded history.
An error may have been recovered later and does not establish workflow failure.

| Key | Action |
| --- | --- |
| Click a heading | Open a session, agent, message, group or action |
| Up / Down, j / k | Select a card; scroll within expanded content |
| Enter / Right | Open the selection; expand or collapse an action group |
| Tab | Switch keyboard focus between the sidebar and activity on wide terminals |
| Escape / Left | Return to the previous view |
| Wheel / Page Up / Page Down | Scroll history or expanded content |
| 1 / 2 / 3 | Show Updates, All activity, or Errors |
| / | Search loaded messages, arguments and results; Escape clears the search |
| u | Read the complete latest public update |
| b | Load earlier history, including earlier search results |
| f / End | Return to live Updates and follow new entries |
| a / s | Open the agent list or session picker |
| ? | Show navigation help |
| r | Refresh discovery and overview |
| q / Ctrl+C | Close only the viewer |

Opening a conversation follows its newest recorded activity. Scrolling back or
selecting a card pauses following; new activity does not move the reading position.
The header shows when you are reading history and how many newer records are
available. Load earlier history with **b** or its heading; all retained history
remains accessible. Search covers the loaded history and expands as earlier pages
are loaded. Enter reads complete messages or exact tool arguments/results matched
by native conversation/call identity. Expanded calls refresh their result in
place. Press Escape, then **f**, to resume following.

Drag across prose to select text and use the terminal's copy shortcut. Shift-drag
bypasses clickable headings. The viewer uses the terminal's colors, with a
selection background that adapts to a reported light or dark theme.

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
