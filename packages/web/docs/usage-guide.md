# Dispatch Web usage guide

Dispatch Web provides company sign-in, invite-only shared conversations on stock Pi Durable, shared named agent definitions, and a branded desktop/mobile workspace. This is a local development implementation. Source/type/build checks are permitted; functional and browser qualification are deferred under the [testing policy](spec.md#testing-policy).

## Start development

Use Nix with `nix-command` and `flakes` enabled. M1 Air's Nix prerequisite is managed by [Palm](https://wiki.chrisreynolds.me/wiki/palm-nix-builders/); application tooling is owned here. Open a new terminal after installing Nix. An existing terminal can use `/nix/var/nix/profiles/default/bin/nix` directly.

From the repository root:

```sh
nix develop
npm ci
npm run dev
```

Open `http://localhost:5173`. The development launcher runs Vite on localhost and the API/Pi service on `127.0.0.1:3001`, proxying `/api` through Vite. Frontend-only edits hot reload without restarting Pi. Node watches the service entry point and its imported modules, including the shared contracts used by the service. Changes to those files send SIGTERM and wait for the old backend to exit before starting its replacement against the same state. The frontend stays running through that brief backend interruption. Pi owns recovery of interrupted native work; a restart is not an uninterrupted model or tool session. Browser disconnection does not restart the Pi owner.

Changes to launcher settings, environment variables, or the MCP manifest still require a manual launcher restart. Stop development before installing changed dependencies.

### Background development

From the repository root inside `nix develop`, with no existing dev launcher running:

```sh
mkdir -p .local/dev
chmod 700 .local/dev
nohup node --import tsx scripts/dev.ts > .local/dev/dev.log 2>&1 < /dev/null &
echo $! > .local/dev/dev.pid
```

This keeps development running independently of the terminal, with logs in `.local/dev/dev.log`. It does not register a login or reboot service. Inspect the recorded launcher before stopping it:

```sh
ps -p "$(cat .local/dev/dev.pid)" -o pid=,command=
kill -TERM "$(cat .local/dev/dev.pid)"
```

Send the signal only while that PID still identifies this repository's `scripts/dev.ts` launcher. Its shutdown stops both children. Wait for shutdown before launching again against the same state or ports.

The launcher fails if the frontend port is occupied, rather than silently choosing another URL. Stop only a server owned by this task/check-out. Run `npm ci` after the dependency lock changes. The initial dependency fetch needs network access; model calls need configured server-side credentials.

The root development, account, and built-app commands share `.local/state/dispatch` in the repository root. This directory is ignored by Git. Do not point two runtime processes at the same storage; a native SQLite ownership lock rejects the second owner. Separate worktrees default to separate state.

## First account and sign-in

With the same root checkout and Nix shell, create a single-use enrollment link:

```sh
npm run auth -- invite --email person@example.com --name "Person"
```

The link expires after one hour by default; `--hours` permits a value up to 24. Share it privately with its intended owner. No email is sent by the application. The browser user chooses a passkey with device PIN/biometric verification, or a password plus TOTP authenticator. Passkey creation opens the browser/password manager directly, without a separate credential-name field. There is no default password or authentication bypass.

Password/TOTP setup displays recovery codes once. Save them in a password manager. Account settings let a recently signed-in user add/remove passkeys, set or replace password/TOTP, and revoke sessions. Factor changes require authentication within the preceding ten minutes; sign out and back in when prompted. The final complete sign-in method cannot be removed.

Lost-device recovery uses the account password and a one-use recovery code, followed by fresh factor enrollment. For a passkey-only account or when those recovery materials are unavailable, an operator must independently establish the owner's identity before issuing a reset:

```sh
npm run auth -- reset --email person@example.com --confirm-reset
```

A reset immediately suspends the old sign-in methods and revokes sessions; the new link only permits fresh enrollment. It does not grant workspace access by itself. Completing recovery replaces old factors. An expired or lost invitation can be reissued with `invite` for an account that has not completed enrollment; use the explicit reset path for an existing account.

## Model credentials and agent configuration

The service uses Pi's public `ModelRuntime` from the pinned coding-agent package. It reads the operator's Pi credential/model files from `~/.pi/agent` and uses Pi's locked credential refresh, including OAuth. Secrets stay on the service and do not enter browser snapshots, Git, build artifacts, or the Nix store.

When seeding the company's default agent for the first time, explicit `DISPATCH_PROVIDER`, `DISPATCH_MODEL`, and `DISPATCH_THINKING` override Pi's `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`. Without either configuration, the fallback is `openai` / `gpt-6-sol` / `off`; the provider still needs credentials. `DISPATCH_PI_AGENT_DIR` selects a different existing Pi configuration directory. Provider environment credentials supported by Pi can also be supplied to the service. Use Personal Vault's process injection for secrets rather than putting them on the command line or in committed files.

The default agent is chat-only and has no tools. It is saved on first startup and can be edited in Agents just like other definitions; subsequent restarts or changes to the service defaults do not overwrite it. The Agents section creates company-shared definitions with instructions, provider/model, and supported thinking levels. Each save produces a new immutable revision. New agent instances copy that configuration; existing instances remain unchanged. A stale edit returns a conflict. Archived definitions cannot start new chats or be edited; there is no restore operation in this slice.

In Agents, New agent is at the top of the sidebar, followed by Find an agent and the saved-agent list. Select an agent to read its description and instructions; the right column shows its saved configuration. Start chat opens the starting-agent chooser with that definition selected. Hover or focus an agent's row for Edit and, for non-default agents, Archive; touch layouts keep the actions visible. Archived agents is at the bottom of the sidebar and supports inspection, not restoration. The default agent keeps its Default tag and cannot be archived.

New agent opens an editor with the saved default agent's model/thinking values. Fill in Identity, Instructions, and Model; Cancel and Create agent/Save new revision stay below the scrolling form. The right column previews the unsaved draft and distinguishes changes from the saved revision for existing agents. Choosing another agent or starting a new edit asks before discarding unsaved changes. Switching to Chats or Account, hiding a column, or changing screen size preserves the open editor. On phones, Start chat fills its row and the agent view includes a short model/thinking/tools summary; Details exposes the full configuration.

Instructions format Markdown while you type or paste, using the same editor as chat. Headings, lists, quotes, emphasis, links and code remain editable. Enter adds a paragraph or list item; Shift+Enter adds a line. Use Create agent or Save new revision to save. Saved instructions stay rendered when viewing the agent. Instructions remain Markdown text; formatting may normalize when edited. Drafts over 50,000 characters including Markdown formatting stay editable and show an error until shortened. Unsupported editor syntax remains text, and drafts are not saved across page reloads.

### Developer

The built-in Developer appears in Agents after service startup. It starts with the saved default agent's model and thinking level. Select Developer and choose Start chat to use Pi's `read`, `write`, `edit`, and `bash` tools. Its name, description, instructions, model, and thinking level use the normal editor; saving preserves its coding tools and affects new chats only. Archiving it prevents new chats and survives restart.

New agents with coding tools start in the configured workspace, so they can use the project already on disk. Root `npm run dev`, `npm start`, and `npm run preview` default to this repository root. Set `DISPATCH_WORKSPACE_DIR=/absolute/path/to/project` before starting the service to choose another existing checkout or Git worktree. A standalone service defaults to its launch directory. Missing or non-directory workspaces fail startup. Participants shows the saved absolute path; conversation project labels do not change it.

On startup, idle existing agents still using Dispatch’s generated `runtime/workspaces/<conversation ID>` folders switch to the configured workspace. Their history, other settings, and old files stay intact, including any repository cloned into an old folder. Custom working directories are preserved. Unfinished deliveries, native tasks, or queued input retain their old directory for recovery; restart again after they finish to apply the migration. Later workspace-setting changes affect new agents and still-eligible legacy instances only.

Agents sharing a checkout must coordinate edits and Git operations. Use separate Git worktrees for parallel coding, and set the workspace explicitly when launching a separate instance with its own state directory. Dispatch does not create worktrees or clone repositories automatically.

Coding tools run on the service machine with the service account's access, including paths outside the working directory. This first setup is for trusted local use on M1 Air; the directory is not a sandbox. Tool activity and follow-up text appear under one agent heading. Bash appears as an open terminal with the command above its live output, then its recorded result and completion status. Select the terminal header to collapse it. Long output scrolls inside the terminal; scroll up to read without following new output. Errors and full-output file paths appear below the output. A completed follow-up that only repeats the terminal output is omitted from the display; explanations remain visible. Raw call/result and assistant records remain in Pi’s SQLite storage; tool activity has no debug-data option. Other tools without a custom presenter keep a generic output disclosure. Stop uses Pi's cancellation; an interrupted shell/file operation is not guaranteed to be undone or to execute only once during recovery.

Write and edit appear as open file cards. A write shows the recorded file content with green additions, line numbers, and a line count; an edit shows the actual recorded patch, with green additions and red removals in one column. Markdown stays source text. Select the file header to collapse the card. Long content wraps and scrolls inside it. Execution status remains visible; requested write content is labeled until completion is confirmed, and errors retain their native output.

Read uses the same file card with the number of returned lines and their original range, such as “Read · 7 lines · lines 1–7”. The body shows those exact lines with neutral syntax highlighting and line numbers. Partial reads retain continuation/truncation notices; a partially returned line is labeled. A failed read shows its error rather than counting the error as file content. If the original call is unavailable, numbering is relative to the returned text and the card explains this.

Refreshing also applies these views to existing tool calls. The cards use the original recorded read/write content and edit patch, even if the file later changes. They do not rerun the tools or read files from disk. The shared public log remains available across native context resets and compaction. Private working inputs and reasoning are excluded from browser snapshots.

### Developer's Wiki connection

Open **Agents → Developer → Connections** to see the personal Wiki endpoint,
**Dispatch Developer** identity, connection status and discovered tools. Its configured
Wiki grants cover article search/read/history/preview/save and conversation-trace/attachment
access; discovery itself does not prove those grants. The other named agents retain their own configured capabilities.

The local operator provisions this connection through Palm's
`infra/playbooks/dispatch-developer-wiki.yml`. It uses a dedicated Wiki signing
credential and the existing official adapter. The definition editor preserves the
connection; it does not accept passwords or arbitrary executable commands.

The operator file defaults to `<DISPATCH_DATA_DIR>/agent-connections.json`:

```json
{
  "connections": [{
    "id": "wiki",
    "agentId": "developer",
    "name": "Wiki",
    "endpoint": "https://wiki.chrisreynolds.me/mcp",
    "identity": "Dispatch Developer",
    "command": "/absolute/path/to/node",
    "args": ["/absolute/path/to/agent-mcp.mjs", "/private/path/to/developer-wiki.json"],
    "instructions": "Consult maintained articles and relevant traces; follow the wiki writing guide before saving.",
    "applyToExisting": true
  }]
}
```

Paths above are examples; Palm writes the installation's actual paths. Override the
file path with `DISPATCH_AGENT_CONNECTIONS_FILE`. Restart the service after changing
the manifest. Keep secrets in the referenced adapter configuration/key store.
`applyToExisting` grants the connection to existing instances explicitly; it does
not replace their saved instructions or model. Removing an entry and restarting
removes that connection from definitions and instances. Upstream revocation is
still enforced by Wiki independently of this file.

An unavailable connection shows its last discovered tools and a **Reconnect**
action. A successful initialization establishes the advertised catalog, not that
all tool operations succeeded. An interrupted write is never automatically replayed;
inspect its outcome before retrying with Wiki's operation ID rules.

### Connect an MCP server

1. Open **Settings → Connections → Connect server**, or **Agents → Edit → MCP connections → Add connection → Connect another server**.
2. Enter a name and the server's Streamable HTTP URL. HTTPS endpoints can use any path; HTTP is supported only on loopback. Choose the authentication method documented by the provider: **OAuth**, **Bearer token**, **Custom headers**, or **No authentication**. Token and header values are entered in password fields and stored encrypted by the service.
3. For OAuth, continue to the provider's sign-in/consent window. **Advanced OAuth settings** accepts optional space-separated scopes and a registered client ID/secret when automatic client registration is unavailable; it shows the callback URL to register. Blank scopes use the server's advertised requirements. Dispatch does not assume a Wiki account or create an upstream agent.
4. Choose the connection in the agent editor, review the shared-conversation notice, and choose new instances only or new and existing instances. **Save new revision** commits the selection. Connecting alone does not grant an agent access.

Connections are reserved for one definition and use the configured provider authority. Participants, including later invitees, can receive connected content; teammates can edit the shared definition. This is not the future delegated personal-Wiki permission model. MCP server/tool names and OAuth scopes are shown when available; a discovered tool list does not prove permission to perform every operation. Existing operator-managed connections remain on their definitions and are edited through their manifest.

**Discard** abandons staged definition changes. An unused connection remains in Settings. **Disconnect** disables future Dispatch access for all bound instances. For OAuth providers that advertise revocation, it also revokes the tokens; retry a pending revocation. Without that endpoint, or for pasted credentials, Dispatch removes its stored credentials and tells you to revoke them with the provider separately. Reauthorization keeps the scope ceiling; use a new connection to change endpoint, authentication method or permissions.

Existing Wiki authorizations retain their identity check and bindings during migration. A newly connected Wiki uses the same generic MCP setup as other services, with its own consent screen and grants deciding access. API-based Wiki agent registration is still deferred.

The editor's Files and commands capability selects native local coding tools for future instances. Existing instances retain their saved configuration, except an explicitly applied MCP connection change. Switching between editor and Settings preserves the draft; reloading or ending the sign-in session does not.

## Chat and workspace

Messages use a compact, left-aligned flow with distinct participant avatars, author names, agent badges and timestamps. Hover a message or focus its actions to reveal Reply in thread and Copy; narrow and touch layouts keep these actions visible. An existing reply summary shows its participants, count, and last reply. Reply opens the thread beside its highlighted parent, or in a full-height phone panel. Replies remain visible to everyone in the conversation.

Conversations initially use the workspace with the context panel closed. Open participants from the header, then select a person or agent for details. Close the context panel to restore the conversation's width. The main composer names its conversation; each thread has a separate Reply to thread composer. Generic tool activity uses a readable summary and observed status; expand it for the original tool identifier, arguments, and results. Native command and file presentations remain available.

The message composer formats Markdown as you type or paste: headings, lists, quotes, bold/italic text, links, and code stay editable in place. Copying selected content retains its Markdown formatting. Paste inside a code block keeps the text literal. Desktop Enter sends; Shift+Enter inserts a line. Enter on a touch-primary device inserts a line; use Send to submit. The toolbar contains a lower-left + attachment menu, an arrow-only Send button and, during active work, Stop. Main-message and individual reply-thread drafts stay with each open chat. Messages over 100,000 characters including formatting must be shortened before sending.

Use **+** to pick files/images, or paste an image into the message or reply composer. The top-left preview row shows image thumbnails or named files; remove a preview to leave it out of the message. Wait for uploads to finish before sending; a message may contain attachments without text. Limits are 10 files, 10 MiB per file and 25 MiB total per message. Main and thread drafts remain separate; they are not saved across reloads.

**Uploading shares the file immediately with authorized conversation members, before Send.** Removing a preview does not delete the uploaded file; it remains a conversation asset. Verified PNG/JPEG/GIF/WebP images up to 4 MiB can reach agents as images (8 MiB total per delivery/history read). Larger originals remain previewable/downloadable, but require a smaller upload for agent use. Omitted images are identified explicitly; agents can retrieve total-budget omissions individually. These application limits do not guarantee provider acceptance, and validated UTF-8 files can be read through their attachment tool. Other files, including PDF/Office/binary formats, are download-only; upload does not mean an agent can interpret them. SVG is download-only, not displayed inline or exposed as agent-readable text. See [the attachment contract](spec.md#message-attachments).

Conversations are visible only to their human members within the installation’s company. New conversation opens a chooser for one or more company agents and an optional conversation name. Enter a name of up to 200 characters (surrounding whitespace is trimmed), or leave it blank to use the existing first-message preview. An explicit name stays as entered, including “New conversation”; it is shared with other members and can be changed later with Rename. A failed creation keeps the name and selected agents for retry. Selecting an agent in Participants opens its saved configuration and per-agent usage. Add participants invites existing active company people or available agents; newcomers can read the full public history. Each agent has an independent working context. Agents consider messages from humans and other agents and may remain silent.

To mention someone, type **@** in a message or reply and start typing their name.
Select a suggestion with the arrow keys and Enter/Tab, or click/tap the person.
The name appears highlighted within your text. Escape dismisses the picker;
deleting the highlighted name removes the mention. Enter selects a suggestion
while the picker is open, then
returns to its normal send behavior. Only current participants appear. Mentioning
someone requests attention without inviting them or changing access.

Agents waiting to publish show **Listening**. An agent with the speaking turn shows **Responding**; **Working** includes concurrent model requests, analysis and tools without holding that turn. Ordinary tool-call commentary stays private; deliberate progress posts and admitted final answers are public. Prepared contributions keep their place through final conversational review and publication. Agents read intervening messages and can revise or discard their draft; unchanged history needs no extra review call. Human typing pauses publication without discarding the answer. Further research releases the speaking turn. Explicit posting tools initially report pending while sibling tools finish, not posted. Mentions give an agent first opportunity when the conversation is free. Human typing and sending are always available, and abandoned typing indicators expire automatically. This policy spans the conversation and its reply threads.

- Sending appends a public message and admits native delivery tasks for the other agent members. Each agent processes its deliveries in order. Retry a failed network request with the same logical request ID; a changed message gets a new ID. Reusing an ID with different content returns a conflict.
- Stop all cancels admitted deliveries and agent responses through Pi, preserving public messages and committed tool output, not unpublished assistant drafts or partials. Messages sent while stopping remain in the composer for retry after Stop finishes; a later message resumes participation. Failure and Stop are distinct from completed answers.
- Closing a main tab, browser tab, or live connection stops observation only. Pi continues admitted work. Reopening restores the current saved state without replaying every missed event.
- Restarting the service invokes native Pi recovery. An interrupted provider request can run again from its committed checkpoint, rather than continuing the exact streamed token; another provider charge is possible.
- The right column follows the active main tab. Participants exposes each agent’s saved configuration and usage. Narrow screens expose navigation and context through panels; per-chat drafts remain in browser memory while switching layouts and tabs.

Sessions last at most twelve hours and expire after thirty minutes without an authenticated request. Stream heartbeats do not extend idle expiry. Expiry or revocation ends protected access; agent work remains owned by the service.

The left rail selects Chats, Agents, or Account and changes both the sidebar and main content. It never adds tabs. Chats retains its open conversations and selected tab while you visit another section; open agent/account forms also remain in memory. Agents lists saved agents in its sidebar, and Account links to its settings sections. Reloading returns to Chats.

Within Chats, the main tab strip appears when multiple conversations are open. Close a view with the × on its tab, or focus the tab and press Delete. With one view open, the entire tab header is absent. Use New conversation in the sidebar to open another conversation as a new tab, preserving the existing tabs. On narrow screens, open the sidebar with Menu in the bottom bar.

Above 1100 pixels, use the left rail’s conversations and details icons to hide or show either side. Drag either inner divider to resize it, or focus the divider and use Left/Right (Shift for larger steps) or Home/End. These choices last while the workspace is open; reloading restores the defaults. Phone Menu and Details controls live in the bottom bar and open panels.

Hover or focus a conversation row to open its actions menu on the right. Touch layouts keep the menu button visible. The menu includes Rename, Move to project, Pin/Unpin, and Archive/Restore. Pinned conversations stay above the others within each group. Archive hides a conversation from the regular list without deleting it or stopping work; use Archived conversations at the bottom of the sidebar to reopen or restore it. Pin, archive and project choices are personal to your account, including when the conversation has other members.

Choose **Rename** from a conversation's actions menu (including archived and project lists), edit its current title, and select **Save name**. Titles are trimmed and must contain 1–200 characters. **Cancel** leaves the title unchanged; a failed save keeps your input and shows an error. Unlike pin, archive and project choices, the new title is shared with all members. It changes only Dispatch's display labels, not messages, agent context or tool directories.

### Projects

Choose **New project** inside Conversations, enter a name, and select **Create project**. A name is the only project field; projects are private to your account within the company. Names can be reused, and can contain up to 100 characters. Existing chats appear under **Without a project**.

Select a project name to see its conversations in the main area; use the chevron to expand or collapse its sidebar group. Search finds both project names and conversation titles. **New conversation** in the project view opens the starting-agent chooser and keeps that project as the destination. The sidebar's **New conversation** also uses the current project's context (including the project of the active chat); starting from an agent or the welcome view makes an unassigned chat.

Choose **Move to project** from a conversation's actions menu, select one destination, and save. **Without a project** removes its membership. A project can contain many conversations, but each conversation belongs to at most one project. Moving keeps its history, current work, chosen agent, and tool directory. Archiving a conversation keeps its project membership; active project counts exclude archived chats.

Projects remain inside Chats and can open alongside conversation tabs. On phones, **Menu** opens the same project controls. New-project input remains available if a responsive layout change closes its popover; reopen New project to continue. This first version does not add project descriptions, renaming, deletion, sharing, files, or automatic context sharing. Omarchy still uses its existing deployment until a later authorized update.

## Checks and builds

Inside the Nix shell:

```sh
npm run check
npm start
```

`check` generates React Router route types, checks frontend/service/tooling TypeScript, and builds the app. It does not run tests. `build` writes the SPA to `packages/web/build/client/` and the compiled service to `packages/web/build/service/`. Root `npm start` and `npm run preview` serve that built application at `http://localhost:5173`, using the same root state as development. Stop development first. Built mode does not hot reload; rebuild after edits.

The pinned build entry points work outside the shell:

```sh
nix build
nix flake check
```

The Nix output includes `result/bin/dispatch-web`, `result/bin/dispatch-auth`, the compiled service/dependencies, and static client files linked at `result/share/dispatch-web/client/`. Its derivation runs TypeScript checks and a build, with no tests or application credentials. Writable state stays outside the immutable output.

The standalone Nix binaries use port/origin 3001 and a state directory relative to the current working directory unless configured. Use both binaries with the same explicit settings when launching outside the root npm workflow:

```sh
export DISPATCH_DATA_DIR="$PWD/.local/state/dispatch"
export DISPATCH_ORIGIN=http://localhost:3001
export DISPATCH_PORT=3001
result/bin/dispatch-auth invite --email person@example.com --name "Person"
result/bin/dispatch-web
```

Do not run that service beside the development owner of the same state. Passkeys are bound to the relying-party hostname; use the same hostname consistently. The local app has not been qualified across browsers/devices under the current no-tests policy. The flake declares Apple Silicon macOS and x86-64 Linux; Linux remains unbuilt and is not deployment-qualified.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DISPATCH_WORKSPACE_DIR` | Existing directory for new coding agents; root launchers default to the repository root, standalone service to its launch directory. Relative values resolve from the service launch directory. |
| `DISPATCH_DATA_DIR` | Writable authentication and native Pi state; root launchers default to the repository's `.local/state/dispatch` |
| `DISPATCH_AGENT_CONNECTIONS_FILE` | Operator per-agent MCP manifest; defaults to `agent-connections.json` inside the state directory |
| `DISPATCH_WEB_PORT` | Root frontend/built-app port; default 5173; root account links use the same port |
| `DISPATCH_PORT` | API service port during development or standalone Nix operation; default 3001; root built launcher uses `DISPATCH_WEB_PORT` |
| `DISPATCH_ORIGIN` | Exact browser origin, without a trailing slash; root launchers default to localhost plus the web port |
| `DISPATCH_HOST` | Standalone/built service bind address; default 127.0.0.1; development pins 127.0.0.1 |
| `DISPATCH_COMPANY_ID`, `DISPATCH_COMPANY_NAME` | Installation company identity/display name; defaults `dispatch` / `Dispatch` |
| `DISPATCH_PI_AGENT_DIR` | Pi credential/model/settings directory; defaults to `~/.pi/agent` |
| `DISPATCH_PROVIDER`, `DISPATCH_MODEL`, `DISPATCH_THINKING` | Explicit default-agent model settings |
| `DISPATCH_CLIENT_DIR` | Optional static-client location for a custom service launcher |

Use HTTPS for any non-loopback origin. HTTP configurations must bind to loopback. Keep company identity and state together; changing the company ID does not migrate accounts or conversations. Custom origin/port settings must be shared by the service, frontend, and account CLI.

The state directory contains `auth.sqlite`, `auth.key`, and `runtime/` with Pi storage and its ownership lock. Back up the authentication database and encryption key together, along with the complete runtime directory, including `runtime/attachments/` blobs and their native Pi metadata. Attachment references without their blobs cannot be restored by rebuilding; missing bytes return 410. Stop the service before a simple file-copy backup so SQLite journals are settled. A missing encryption key must be restored; generating another key cannot decrypt existing TOTP factors. Do not copy these files into build inputs or source control.

## Application API

`POST /api/chats/:id/preferences` accepts any combination of boolean `pinned`/`archived` and nullable `projectId`, and returns the current chat snapshot. Any human member may update their own conversation preferences; the destination project must belong to that same user/company. `GET /api/chats` includes archived records and project membership so the browser can present active, archived, and grouped lists.

`POST /api/chats/:id/title` accepts `{ title: string }` (trimmed, 1–200 characters) and returns `ChatSnapshot`. Any authenticated human member may rename the shared display title. The original creation title is preserved so renaming does not invalidate creation retries.

`POST /api/projects` accepts `{ requestId, name }` and returns `{ project }`. A project contains `id`, `name`, and `createdAt`. Retrying the same request ID and trimmed name returns the original project; changed content returns 409. `POST /api/chats` accepts optional `projectId` (null or omitted means unassigned). Chat creation retries compare the original creation project, even after the conversation has moved. Names are labels; stable UUIDs identify projects.


All `/api` access requires a fully authenticated session except the authentication flow endpoints. Mutations require same-origin requests; bodies are JSON except multipart attachment uploads. Protected commands validate input; unavailable resources return 404 across identity boundaries.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Company, default agent, available model choices and supported thinking levels, provider readiness |
| `GET/POST /api/chats` | List conversations you belong to / create with a request ID |
| `GET/POST /api/projects` | List private projects / create a name-only project with a request ID |
| `POST /api/chats/:id/title` | Rename the shared Dispatch display title |
| `POST /api/chats/:id/preferences` | Set pin/archive flags or assign, move, or remove project membership |
| `GET /api/chats/:id` | Public messages, participants and sanitized native activity |
| `POST /api/chats/:id/messages` | Admit a message idempotently; return a snapshot with status 202 |
| `POST /api/chats/:id/attachments` | Upload one multipart `file`; return `{ attachment }` |
| `GET /api/chats/:id/attachments/:attachmentId` | Session/access-checked image or download |
| `POST /api/chats/:id/stop` | Conversation-wide native cancellation; return the current snapshot |
| `POST /api/chats/:id/composing` | Publish expiring human typing presence; no draft text |
| `GET /api/chats/:id/events` | SSE `snapshot` events; `session-ended` closes access on invalidation |
| `GET /api/people` | Active company people available for invitation |
| `POST /api/chats/:id/participants` | Invite company agents or people with an idempotent request ID |
| `GET/POST /api/agents` | List company definitions / append a revision using optimistic concurrency |
| `GET /api/agents/:id/connections` | Read observed per-agent MCP status and the discovered tool catalog |
| `POST /api/agents/:id/connections/:connection/reconnect` | Retry initialization/discovery for a configured connection; body `{}` |
| `POST /api/agents/:id/archive` | Archive using the expected revision |
| `/api/auth/*` | Enrollment, sign-in, recovery, session and factor management, logout |

`POST /api/chats` accepts `agentDefinitionIds` (one or more), or the legacy singular `agentDefinitionId`. Message commands accept `threadId` and participant-ID `mentions`. Invitation commands accept `{ requestId, agentDefinitionIds?, userIds? }`. The service binds public authorship to the authenticated human or native agent instance.

Attachment uploads return `{ attachment: Attachment }`, where metadata contains `id`, `name`, `mimeType`, `size` (bytes), `kind` (`image`, `text` or `file`) and a session/access-checked `url`. Send commands accept `attachmentIds` (at most 10 unique IDs, 25 MiB total), scoped to the same conversation and uploaded by the sender. Their Markdown `text` may be empty when attachments are present. Uploaded IDs may be reused in later messages by their uploader; duplicate IDs within one message are rejected. Retries retain both the send request ID and attachment IDs; changing attachment identity under the same request ID returns a conflict. Message snapshots include `attachments`. Shared limits and metadata are exported from `src/shared/contracts.ts`.

Agents use `conversation_attachment` with `attachmentId` and optional zero-based character `offset`. Verified images return native image content; text returns at most 12,000 characters with `textLength`, `truncated` and `nextOffset` for continuation. Download-only files return metadata with `readable: false`, not extracted content. Attachment names/content are untrusted conversation data, not instructions.

The composing command accepts `{ clientId, sequence, active }`, where each mounted composer uses its own UUID and increasing sequence number. It returns `{ ok: true }`. Only authenticated conversation members may publish presence; the service derives their identity. A true signal expires six seconds after receipt. Sending messages is independent of presence updates, and failed presence must not disable Send.

A public message can include `aliases`, prior IDs for a reconciled duplicate of the same native reply. History lookup and reply targets accept those IDs; the visible history retains one message and combines its replies. Raw native records remain intact.

The precise shared types are in `src/shared/contracts.ts` and `src/shared/auth-contracts.ts`. See [runtime.md](runtime.md) for native storage, cancellation, and request identity. The browser never sends an authoritative user or company ID for access checks.

## Dependency updates and later deployment

The runtime pins Pi Durable, Pi AI, Chord, Pi Coding Agent, and Pi MCP to 1.0.4. Keep these directly used packages aligned when upgrading so the application and native harness share compatible provider, document, and credential implementations. After installing an updated lockfile, restart the development launcher to load the new runtime; frontend hot reload alone does not replace the persistent backend.

Use exact versions in the owning manifest and commit the root dependency lock. To update `npmDepsHash` in `packages/web/nix/package.nix`, temporarily set `lib.fakeHash`, run `nix build`, replace the placeholder with the reported actual hash, then rebuild. Never commit a placeholder. Toolchain changes through `nix flake update` also require a build.

Omarchy/Palm hosting and its internal HTTPS domain are a later work package. The current pilot at `dispatch.chrisreynolds.me` remains in place. Loopback development cannot be opened directly from a phone; real-device access requires a later reachable environment. CI and release automation are unconfigured. Do not add tests until stable behavior is ready to preserve and Chris resumes that work; future coverage focuses on end-to-end and API tests.

### Agent skills

In the agent editor, Skills lets you create reusable text playbooks and explicitly select revisions for that agent. Creating a skill does not select it. Save the agent revision to apply selected skills to future instances. Editing a skill does not upgrade existing assignments; select the newer revision deliberately. Existing conversation participants retain their copied skill contents.

Only assigned skills are advertised to the model, which can call `load_skill` with the advertised ID. No Files and commands capability is required. Unassigned IDs are rejected by the loader. This is not filesystem isolation for coding agents.

`GET /api/skills` returns the company's latest skill revisions. `POST /api/skills` creates or revises a text skill with name, description, instructions and requestId; updates also require id and expectedRevision. Agent saves accept `skills: [{ id, revision }]` (up to fifty). Text skills do not include uploaded files, package imports or automatically available scripts.

### Shared projects

New project now creates an empty shared project with you as its manager. Project settings lets managers rename it, select default agents and add/remove members or managers. Keep at least one manager. Members can read every project conversation, including history from before they joined, and participate. Removing membership denies later requests and snapshot delivery; previously delivered information cannot be recalled. Already admitted agent work is not canceled.

Default agents are preselected when starting a conversation in the project; adjust the selection before creating it, including selecting none for a people-only conversation. Existing conversations keep their own participants and configuration. Add human access through project settings, not the conversation invitation picker. Default agents are not an allowed-agent restriction.

Old projects remain **personal groupings** with unchanged invite-only conversation access. Their grouping moves remain private organizational changes. Shared projects cannot receive existing conversations or move their conversations to another audience in this slice. No automatic migration expands access.

Operators can set `DISPATCH_READ_ALL_PROJECT_USER_IDS` to comma-separated stable user IDs from the company's authenticated people directory. The default is empty. These users can read all shared projects in their company but cannot participate or manage settings without explicit membership. The grant excludes standalone conversations and legacy personal groupings. Changing it requires a backend restart. No grant for Ben or another person is inferred from a display name or provisioned by this release.

API: `POST /api/projects` with `{requestId,name,kind:"shared"}`; `POST /api/projects/:id` with `{requestId,expectedRevision,name,members:[{userId,role}],defaultAgentDefinitionIds}`. `GET /api/projects` includes personal/shared kind and current participation/management flags. `POST /api/chats` uses `sharedProjectId` for the shared audience, mutually exclusive with personal `projectId`. Omitted agent selections resolve project defaults; explicit selections override them. Retries retain the original request object. Project-save replay still requires current manager access and returns current state; losing your own access can therefore prevent replay even when the original save committed.

The UI refreshes project/conversation lists periodically and on return to the page; active stream denial clears its displayed snapshot. This is not a mechanism for erasing content already received. Broad coding tools, company-shared definitions and connections remain separate confidentiality boundaries: do not treat project permissions alone as protection for restricted files or credentials. Multi-user authorization and device behavior still require functional qualification before a restricted-data rollout.


### Image generation

Enable **Image generation** in an agent's Capabilities and save a new revision. Assign the seeded **Image generation** skill separately for prompting guidance. Neither action updates existing participants: start a new conversation or invite a new instance using the saved definition. Files and commands is not required for generation itself. The service's configured workspace must exist and OpenAI platform credentials must be available through its existing Pi credential configuration. ChatGPT/Codex subscription credentials are not substituted.

`generate_image` generates from a prompt or edits workspace reference PNGs with an optional mask. It defaults to `gpt-image-2.5-sunburst`; specify another supported model explicitly when needed. References leave the workspace for OpenAI processing. Outputs and run metadata remain workspace files; no gallery, automatic conversation attachment, or cleanup job is added. Metadata may contain private prompts and reference paths, so protect workspace storage and backups.

Generation may incur provider charges. There is no automatic retry. After interruption, inspect the existing run record and outputs before deciding whether to request another generation. An incomplete record or locally cancelled request does not prove OpenAI stopped or avoided a charge. Rewind does not delete outputs or reverse charges. Skill guidance is not a permission grant or a guaranteed workflow.
