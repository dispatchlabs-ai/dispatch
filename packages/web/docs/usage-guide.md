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

Open `http://localhost:5173`. The development launcher runs Vite on localhost and the API/Pi service on `127.0.0.1:3001`, proxying `/api` through Vite. Frontend-only edits hot reload without restarting Pi. Node watches the service entry point and its imported modules, including the shared contracts used by the service. Changes to those files send SIGTERM and wait for the old backend to exit before starting its replacement against the same state. Shutdown drains Pi work and releases provider session resources, including cached model WebSockets and their idle timers, before the old process exits. The frontend stays running through that brief backend interruption. Pi owns recovery of interrupted native work; a restart is not an uninterrupted model or tool session. Browser disconnection does not restart the Pi owner.

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

By default, the root development, account, and built-app commands share `.local/state/dispatch` in the repository root. This directory is ignored by Git. Do not point two runtime processes at the same storage; a native SQLite ownership lock rejects the second owner. Separate worktrees default to separate state.

### PostgreSQL development (WP-042)

**Opt-in implementation; focused native Linux trial checks passed.** See the [adapter work package](handoff.md#wp-042--local-postgresql-pi-storage-adapter) for integration/check evidence. PostgreSQL is opt-in Pi storage, not an AWS deployment or a switch to distributed workers. The current application still owns one runtime/store. Authentication, managed connection credentials and attachment bytes remain in local application state.

Use PostgreSQL 17 and a dedicated development database owned by the connecting role. The adapter creates/version-checks its `dispatch_pi` schema at open, so that role needs schema/table creation privileges. Choose **one** setup below; do not replace an existing database service or reuse installation data. These commands are procedures, not recorded execution evidence.

#### Container

With Docker available, from a trusted local terminal:

```sh
# Read a disposable database password without putting it in shell history.
read -r -s -p 'Development database password: ' POSTGRES_PASSWORD
printf '\n'
export POSTGRES_PASSWORD
docker volume create dispatch-pg-dev
docker run -d --name dispatch-pg-dev \
  -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=dispatch_dev -e POSTGRES_DB=dispatch_dev \
  -e POSTGRES_PASSWORD \
  -v dispatch-pg-dev:/var/lib/postgresql/data postgres:17
unset POSTGRES_PASSWORD
```

The prompt uses Bash syntax; run this block in Bash on macOS. Use unused container/volume names and port; do not adopt a preexisting volume. Wait for PostgreSQL initialization before starting Dispatch. The volume persists through `docker stop dispatch-pg-dev`; later use `docker start dispatch-pg-dev`. Do not remove the volume unless intentionally discarding this development database. The password is visible to Docker administrators in container configuration; use disposable credentials, never a production secret. Port 55432 is loopback-only, not a network exposure boundary against other local users.

#### Homebrew on macOS

If no existing PostgreSQL service occupies port 5432:

```sh
brew install postgresql@17
brew services start postgresql@17
"$(brew --prefix postgresql@17)/bin/createuser" -h localhost -p 5432 -P dispatch_dev
"$(brew --prefix postgresql@17)/bin/createdb" -h localhost -p 5432 -O dispatch_dev dispatch_dev
```

Run role/database creation as the installation's database administrator; Homebrew's initial administrator is normally your macOS user. Choose new names if those already exist. Set a disposable role password at the prompt. Keep the server loopback-only and review its existing authentication configuration; installing a password does not itself change `pg_hba.conf`. Do not weaken authentication, overwrite an existing cluster or restart someone else's service to follow this example.

#### Application settings

In the repository's Nix shell, use a fresh state path and a stable store identity unique to this development instance:

```sh
export DISPATCH_PI_STORAGE=postgres
export DISPATCH_DATA_DIR="$PWD/.local/state/dispatch-postgres"
export DISPATCH_POSTGRES_STORE_ID=dispatch-dev-postgres
# Inject DISPATCH_POSTGRES_URL privately, then:
npm run dev
```

Supply `DISPATCH_POSTGRES_URL` through private process injection or a non-echoing prompt, not a literal secret in shell history or a committed file. Its shape is `postgresql://dispatch_dev:<encoded-password>@127.0.0.1:55432/dispatch_dev` for the container; use port 5432 for Homebrew. Percent-encode password characters when constructing the URL. URL query parameters and fragments are rejected; TLS/remote-deployment configuration is not supported by this slice. Restart the launcher after changing settings. Keep these exports in effect when running `npm run auth -- invite ...`, so account enrollment uses the same fresh local state; invitation links are private.

PostgreSQL mode requires an explicit data directory and store ID and rejects existing `runtime/pi.sqlite`; there is no migration. `runtime/postgres-store.json` binds the local directory to database host, port, path and store ID, without credentials. It blocks changing that identity or switching the directory back to SQLite, including after a failed initial connection. Do not remove the marker or rename/delete `pi.sqlite` to bypass these guards. Reopening PostgreSQL state requires the same database, logical-store ID, local state and company configuration. A new store ID selects different Pi state; it does not copy accounts, conversations or attachments. Backups must pair PostgreSQL state with the complete local state and its encryption keys/attachment bytes; database-only backup is insufficient. Focused controlled restart and API-level paired-restore checks passed in the isolated [Palm trial](handoff.md#wp-043--isolated-palm-postgresql-trial); interrupted-agent recovery and full conformance remain unverified.

The local duplicate-owner guard is a per-store PostgreSQL session advisory lock on a dedicated, serialized, non-reconnecting connection used for storage. A competing open is rejected without waiting; the lock is released only after admitted operations drain. Connection loss permanently rejects further storage operations and an uncertain COMMIT requires reopening rather than automatic retry. This is **not distributed fencing**, and automatic takeover is unsupported: losing the database connection does not terminate an already-running shell command or remote tool request. Do not start a replacement while an old executor might still run tools. Confirm the old process and its work have stopped before restart. The local runtime-directory SQLite ownership lock remains in use in both modes; only Pi record persistence changes. Keep existing native/LAN owners unchanged.

## First account and sign-in

Accounts require an operator-issued invitation; the login page has no self-service signup. Only the unused enrollment link expires—not the enrolled account. After setup, sign in normally with your saved credentials.

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

Developer (`developer`) is the default agent and includes local coding tools. It is saved on first startup and can be edited in Agents just like other definitions; subsequent restarts or changes to the service defaults do not overwrite it. The Agents section creates company-shared definitions with instructions, provider/model, and supported thinking levels. Each save produces a new immutable revision. New instances copy that configuration; existing active instances adopt base updates at the next safe idle boundary, preserving identity and history. A stale edit returns a conflict. Archived definitions cannot start new chats or be edited; user-driven archive restoration is not supported (the Developer default migration below is a startup exception). Configuration restoration for an eligible active target is described under [permissioned agent management](#permissioned-agent-management).

**Update policy:** saved does not mean applied. In Participants, **Base revision applied** identifies adopted instructions/model/capabilities/selected skills; a newer saved base revision shows Pending until adoption succeeds. Instance connections lists actual MCP assignments separately, with Pending update for queued connection work. Supplements and workspace paths survive upgrades. No remove/reinvite is needed. A failed application retains the old configuration and reports a safe error; reconciliation retries on later eligible boundaries and startup. Candidate source/build evidence does not establish runtime or rendered acceptance. See [the contract](spec.md#in-place-agent-revision-upgrades).

In Agents, New agent is at the top of the sidebar, followed by Find an agent and the saved-agent list. Select an agent to read its description and instructions; the right column shows its saved configuration. Start chat opens the starting-agent chooser with that definition selected. Hover or focus an agent's row for Edit and, for non-default agents, Archive; touch layouts keep the actions visible. Archived agents is at the bottom of the sidebar and supports inspection, not restoration. The default agent keeps its Default tag and cannot be archived.

New agent opens an editor with the saved default agent's model/thinking values. Fill in the sections described under [authoring navigation](#agent-overview-and-authoring-navigation); Discard and Create agent/Save new revision stay below the scrolling form. The right column previews the unsaved draft and distinguishes changes from the saved revision for existing agents. Choosing another agent or starting a new edit asks before discarding unsaved changes. Switching to Chats or Account, hiding a column, or changing screen size preserves the open editor. On phones, Start chat fills its row and the agent view includes a short model/thinking/tools summary; Details exposes the full configuration.

Instructions format Markdown while you type or paste, using the same editor as chat. Headings, lists, quotes, emphasis, links and code remain editable. Enter adds a paragraph or list item; Shift+Enter adds a line. Use Create agent or Save new revision to save. Saved instructions stay rendered when viewing the agent. Instructions remain Markdown text; formatting may normalize when edited. Drafts over 50,000 characters including Markdown formatting stay editable and show an error until shortened. Unsupported editor syntax remains text, and drafts are not saved across page reloads.

### Agent overview and authoring navigation

The Agents sidebar has a named ellipsis menu for Edit and, except for the default agent, Archive. Select an agent to read its instructions, skills and connections. **Overview** and **Evaluations** share that agent context. **Edit agent** opens one draft with Identity, Instructions, Model, Capabilities, Skills and Connections shortcuts. These shortcuts scroll to sections without saving. Instructions offers bold, italic, inline code and list formatting; Markdown remains the stored format. The desktop Configuration column opens with the editor and shows draft values; phones expose it through **Details**. **Discard** and **Save new revision** remain in the footer.

Switching back to **Overview** retains an evaluation draft in memory. To discard it, use the evaluation editor's **Cancel** or **Back to agent** and confirm when asked. Reloads still lose in-memory drafts.

### Agent evaluation profiles

WP-047 adds a separate Evaluation profile section for saved agents. Focused disposable-data demonstrations cover persistence, conflict recovery and desktop/390 px rendering; broader accessibility, real-device and crash-recovery qualification remain outside that evidence. See the [data contract](spec.md#individual-agent-evaluation) and [acceptance scope](handoff.md#wp-047--agent-evaluation-profiles-and-editor).

1. Save the agent definition first, then select **Evaluations** to open its evaluation workspace. Select **Create evaluation profile** for first use or **Edit profile** for an existing profile. The saved overview links to Expectations, Grading criteria and Cases; **Show all expectations** reveals the complete expectations.
2. Use **Expectations**, **Grading criteria** and **Cases** to move through one draft. Enter responsibilities, expected behavior and at least one criterion. Criteria choose direct checks, judge or human review; critical-failure flags and grading guidance describe how to assess work, not an assessment already performed.
3. Select a case in the outline or **Add case**. Optionally add standalone cases with a name, **Task for the agent**, expected outcome and one or more applicable criteria. **Enabled for future evaluations** stores whether to include the case; it does not run it. Starting conditions and artifact references describe agent-visible inputs. Reference answers/checks belong under **Grading references and checks**, labeled as grading-only material.
4. Enter the required change reason in the persistent footer and select **Save profile** in the persistent action bar. Profile revisions are independent of agent revisions; saving does not alter operating instructions, existing instances or execute cases. **Cancel** leaves editing; **Back to agent** leaves the workspace. Both ask before discarding unsaved changes.

Use **Profile revision** in the context panel (open **Details** on phones) to inspect immutable history. Edit always starts from the latest profile, not the historical selection. A conflict preserves the draft; **Reload latest** explicitly discards it after confirmation, so copy needed changes before reloading. Archived agents remain readable and read-only. Archiving during an edit retains the in-memory draft but locks editing/saving. Drafts are not durable across page reloads. An absent profile is **Not configured**, not passed.

Artifacts are references only, not uploads, verified files or access grants. Each requires a nonblank name (up to 200 characters), reference (2,048) and SHA-256 (exactly 64 lowercase hexadecimal characters). The service stores the supplied hash; it does not fetch or verify the artifact. Evaluator-only labeling is not a separate human permission: company users who can inspect the profile can read that material. Profile access never grants access to referenced private evidence.

#### Profile API and limits

Authenticated company-session endpoints:

- `GET /api/agents/:id/evaluation` returns `{ profile, revisions }`, with a nullable latest profile and newest-first revision metadata.
- `GET /api/agents/:id/evaluation/revisions/:revision` returns `{ profile }`.
- `POST /api/agents/:id/evaluation` accepts `SaveEvaluationProfileInput` from [`src/shared/evaluations.ts`](../src/shared/evaluations.ts) and returns `{ profile }`.

First save uses `expectedRevision: null`; subsequent saves use the loaded profile revision. Retry identical requests with the same `requestId`; changed reuse or stale revision returns 409. An identical replay returns the originally saved revision, not necessarily the latest. Archived agents reject new saves. Agent/company identity and author are resolved server-side; there is no native agent profile-editing tool in this slice.

The API requires nonblank responsibilities, expected behavior, change reason, criterion descriptions and case names/prompts/outcomes. Criterion/case IDs are unique UUIDs; each case selects unique existing criterion IDs. Limits are 100 criteria, 100 cases and 20 artifact references per case. Responsibilities, expected behavior, prohibited actions and grading guidance allow 10,000 characters; criterion descriptions 2,000; case names 200; change reason 1,000; prompt, starting conditions, expected outcome, reference answer and checks 20,000 each. Parsed save JSON must be at most 200 KiB. Invalid fields return 400; an oversized parsed profile returns 413.

This slice has no runner, real-conversation evidence picker, grading/results screen or execution authorization. The broader contract includes standalone and real-use evaluation, but stored cases are not completed evaluations.

### Permissioned agent management

WP-046 adds disabled-by-default management rights through a human-session API; there is no grant-management screen or seeded Doctor grant. The interface below documents the implementation slice, not a successful live trial. Doctor's target and direct-save mode still require confirmation before enabling access. Proposal/promotion and automatic evals are not included.

**Grant administration.** Any fully authenticated company member can inspect/change company grants under the existing equal-capability human policy. Use same-origin JSON requests; never give an agent a browser session. `GET /api/agent-management/grants` returns `{ grants, history, saves }`: current versioned policies, human grant-change audit and agent-save receipts. Save reasons/evidence are untrusted agent-supplied text, not verified eval results; the history includes request fingerprints containing submitted tuning text and is company-visible. Receipts are retained for replay safety, not pruned when the hourly quota window expires. `POST` to that endpoint returns `{ grant }` and accepts:

```json
{
  "editorId": "<immutable editor ID>",
  "targetId": "<immutable target ID>",
  "expectedVersion": 0,
  "requestId": "<stable human request ID>",
  "reason": "Enable a reviewed narrow grant",
  "policy": {
    "editorRevision": 1,
    "action": "save",
    "fields": ["instructions"],
    "maxSavesPerHour": 1
  }
}
```

The revision and limit above are illustrative, not trial defaults. `expectedVersion` is 0 for a new editor/target pair; thereafter use the returned current version. Set `policy: null` to revoke, retaining the pair's current version, a reason and a new request ID. Identical retries reuse the original request ID and payload; changed content or stale versions conflict (409). Policy action is `read` or `save`; save requires a nonempty field list drawn from `instructions`, `provider`, `modelId`, `thinkingLevel`. Every policy requires an explicit limit of 1–100 committed saves per rolling hour.

Editors and targets may have tools, extensions, skills, MCP connections or management grants. The default agent can be a target. Targets must remain active, in the same company and distinct from the editor; these conditions are rechecked when acting. Grants pin the editor revision: both its current definition and acting instance must match. After editing the editor, wait for base adoption and explicitly re-grant the current revision. An old or automatically upgraded instance does not inherit its former grant.

**Native tools.** Tool visibility alone grants nothing. `agent_management_read` with no arguments lists up to 100 currently eligible granted targets and returns `total`/`nextOffset`; pass `{ offset }` to continue. `{ targetId, revision? }` reads identity and tuning fields from the current or specified historical revision. Unauthorized targets are not returned by listing. There is no general agent API-call tool.

`agent_management_save` accepts `{ targetId, operationId, expectedRevision, reason, evidence?, patch?, restoreRevision? }`. Supply exactly one nonempty `patch` or positive `restoreRevision`; patch keys must be granted fields. Instructions retain the 50,000-character cap and model/thinking changes retain normal validation. Evidence is at most 20 opaque references (2,000 characters each); it is not fetched and grants no access. Unknown fields, capability/connection/skill changes and live-rollout flags are rejected.

A successful save returns a compact acknowledgement with operation ID, target before/after revisions, timestamp and grant version; full attribution, evidence and retry fingerprints remain in the human-inspectable save history, not the tool response. Retry an uncertain result with the **same operation ID and identical payload in the same agent instance**. Receipt replay uses the original company/instance/definition and payload even after that instance adopts a newer base revision. It retains original revision attribution and precedes current grant/quota checks, including after revocation, and never creates another revision or consumes quota; changed content conflicts. Operation IDs are instance-scoped, not a cross-conversation retry mechanism. New saves use the current expected target revision; stale revisions conflict. The applicable grant's hourly limit counts committed saves across that editor's targets; exhaustion returns 429 with a retry time.

**Restoration.** Read the desired historical revision and latest target revision, then save with `restoreRevision` set to the historical revision and `expectedRevision` set to the latest. Restoration copies only the granted tuning fields into a new forward revision and counts as a save. It does not rewrite history, restore ungranted fields or undo external effects. The restored forward revision is adopted by active instances at a safe idle boundary. Revoke the grant separately if further edits should stop. Stop/cancellation does not undo an already committed save.

Permission checks do not isolate an agent with host shell/state access; cwd is not a sandbox. Inspect both agents' effective access before enabling a trial. Source/build checks and the standing zero-tests policy do not establish successful Doctor edits, replay/revocation behavior or deployment.

### Developer

**October 8 default migration:** startup archives Dash/Dispatch (`default`) rather than deleting it, retaining historical revisions and existing conversation instances. Archived agents remains available for inspection. Project defaults selecting it switch to Developer, with duplicates removed; other selections, empty defaults, membership and existing chats stay unchanged. New projects and chats without an explicit selection use Developer. An archived Developer is reactivated with its saved configuration intact. This migration does not switch existing instances to Developer or overwrite their settings. Functional migration qualification is outstanding in the [handoff](handoff.md#developer-default-and-dash-retirement--october-8-2026).

The built-in Developer is the company default after service startup. Existing saved settings are preserved. If Developer is absent, its initial provider/model/thinking come from the retired default when available, otherwise the service/Pi defaults. Select Developer and choose Start chat to use Pi's `read`, `write`, `edit`, and `bash` tools. Its name, description, instructions, model, and thinking level use the normal editor; saving preserves its coding tools and applies base updates to existing active instances at the next safe idle boundary, as well as new instances. Developer cannot be archived, but can be targeted by permissioned agent management with an explicit human grant.

New agents with coding tools start in the configured workspace, so they can use the project already on disk. Root `npm run dev`, `npm start`, and `npm run preview` default to this repository root. Set `DISPATCH_WORKSPACE_DIR=/absolute/path/to/project` before starting the service to choose another existing checkout or Git worktree. A standalone service defaults to its launch directory. Missing or non-directory workspaces fail startup. Participants shows the saved absolute path. The project working-directory setting described below overrides this default for new instances in that project; existing instances keep their saved paths.

On startup, idle existing agents still using Dispatch’s generated `runtime/workspaces/<conversation ID>` folders switch to the configured workspace. Their history, other settings, and old files stay intact, including any repository cloned into an old folder. Custom working directories are preserved. Unfinished deliveries, native tasks, or queued input retain their old directory for recovery; restart again after they finish to apply the migration. Later workspace-setting changes affect new agents and still-eligible legacy instances only.

Agents sharing a checkout must coordinate edits and Git operations. Use separate Git worktrees for parallel coding, and set the workspace explicitly when launching a separate instance with its own state directory. Dispatch does not create worktrees or clone repositories automatically.

Coding tools run on the service machine with the service account's access, including paths outside the working directory. This first setup is for trusted local use on M1 Air; the directory is not a sandbox. Tool activity and follow-up text appear under one agent heading. Bash appears as an open terminal with the command above its live output, then its recorded result and completion status. Select the terminal header to collapse it. Long output scrolls inside the terminal; scroll up to read without following new output. Errors and full-output file paths appear below the output. A completed follow-up that only repeats the terminal output is omitted from the display; explanations remain visible. Raw call/result and assistant records remain in the selected Pi storage; tool activity has no debug-data option. Other tools without a custom presenter keep a generic output disclosure. Stop uses Pi's cancellation; an interrupted shell/file operation is not guaranteed to be undone or to execute only once during recovery.

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

The editor's Files and commands capability selects native local coding tools for new instances and safe idle base upgrades of active instances. Newly selected MCP connections still require explicit existing-instance assignment. Switching between editor and Settings preserves the draft; reloading or ending the sign-in session does not.

## Chat and workspace

Messages use a compact, left-aligned flow with distinct participant avatars, author names, agent badges and timestamps. Hover a message or focus its actions to reveal Reply in thread and Copy; narrow and touch layouts keep these actions visible. An existing reply summary shows its participants, count, and last reply. Reply opens the thread beside its highlighted parent, or in a full-height phone panel. Replies remain visible to everyone in the conversation.

Conversations initially use the workspace with the context panel closed. Open participants from the header, then select a person or agent for details. Close the context panel to restore the conversation's width. The main composer names its conversation; each thread has a separate Reply to thread composer. Generic tool activity uses a readable summary and observed status; expand it for the original tool identifier, arguments, and results. Native command and file presentations remain available.

The message composer formats Markdown as you type or paste: headings, lists, quotes, bold/italic text, links, and code stay editable in place. Copying selected content retains its Markdown formatting. Paste inside a code block keeps the text literal. Desktop Enter sends; Shift+Enter inserts a line. Enter on a touch-primary device inserts a line; use Send to submit. The toolbar contains a lower-left + attachment menu, an arrow-only Send button and, during active work, Stop. Main-message and individual reply-thread drafts stay with each open chat. Messages over 100,000 characters including formatting must be shortened before sending.

Use **+** to pick files/images, or paste an image into the message or reply composer. The top-left preview row shows image thumbnails or named files; remove a preview to leave it out of the message. Wait for uploads to finish before sending; a message may contain attachments without text. Limits are 10 files, 10 MiB per file and 25 MiB total per message. Main and thread drafts remain separate; they are not saved across reloads.

**Uploading shares the file immediately with authorized conversation members, before Send.** Removing a preview does not delete the uploaded file; it remains a conversation asset. Verified PNG/JPEG/GIF/WebP images up to 4 MiB can reach agents as images (8 MiB total per delivery/history read). Larger originals remain previewable/downloadable, but require a smaller upload for agent use. Omitted images are identified explicitly; agents can retrieve total-budget omissions individually. These application limits do not guarantee provider acceptance, and validated UTF-8 files can be read through their attachment tool. Other files, including PDF/Office/binary formats, are download-only; upload does not mean an agent can interpret them. SVG is download-only, not displayed inline or exposed as agent-readable text. See [the attachment contract](spec.md#message-attachments).

Conversations are visible only to their human members within the installation’s company. New chat opens a chooser for one or more company agents and an optional conversation name. Enter a name of up to 200 characters (surrounding whitespace is trimmed), or leave it blank to use the existing first-message preview. An explicit name stays as entered, including “New conversation”; it is shared with other members and can be changed later with Rename. A failed creation keeps the name and selected agents for retry. Selecting an agent in Participants opens its saved configuration and per-agent usage. Add participants invites existing active company people or available agents; newcomers can read the full public history. Each agent has an independent working context. Agents consider messages from humans and other agents and may remain silent.

To mention someone, type **@** in a message or reply and start typing their name.
Select a suggestion with the arrow keys and Enter/Tab, or click/tap the person.
The name appears highlighted within your text. Escape dismisses the picker;
deleting the highlighted name removes the mention. Enter selects a suggestion
while the picker is open, then
returns to its normal send behavior. The picker includes current participants and
available company agents. **Invite on send** identifies an agent not yet in the
conversation: selecting it only adds a draft token; sending invites it and posts
your message together. Deleting the token before Send cancels that invitation.
The new agent can read the full public history, considers the inviting message,
and remains a participant afterward. Mentioning an existing participant does not
change access or require an answer. Invite people through Participants instead.

Agents waiting to publish show **Listening**. An agent with the speaking turn shows **Responding**; **Working** includes concurrent model requests, analysis and tools without holding that turn. Ordinary tool-call commentary stays private; deliberate progress posts and admitted final answers are public. Prepared contributions keep their place through final conversational review and publication. Agents read intervening messages and can revise or discard their draft; unchanged history needs no extra review call. Human typing pauses publication without discarding the answer. Further research releases the speaking turn. Explicit posting tools initially report pending while sibling tools finish, not posted. Mentions give an agent first opportunity when the conversation is free. Human typing and sending are always available, and abandoned typing indicators expire automatically. This policy spans the conversation and its reply threads.

- Sending appends a public message and admits native delivery tasks for the other agent members. Each agent processes its deliveries in order. Retry a failed network request with the same logical request ID; a changed message gets a new ID. Reusing an ID with different content returns a conflict.
- Stop all cancels admitted deliveries and agent responses through Pi, preserving public messages and committed tool output, not unpublished assistant drafts or partials. Messages sent while stopping remain in the composer for retry after Stop finishes; a later message resumes participation. Failure and Stop are distinct from completed answers.
- Closing a main tab, browser tab, or live connection stops observation only. Pi continues admitted work. Reopening restores the current saved state without replaying every missed event.
- Restarting the service invokes native Pi recovery. An interrupted provider request can run again from its committed checkpoint, rather than continuing the exact streamed token; another provider charge is possible.
- The right column follows the active main tab. Participants exposes each agent’s saved configuration and usage. Narrow screens expose navigation and context through panels; per-chat drafts remain in browser memory while switching layouts and tabs.

### Chat Definition of Done

**Source-published in `89f9ff7`; runtime and rendered UI qualification pending.** Open **Participants** from the chat header (or **Details** on a phone). Under **Definition of Done**, choose **Set criteria** or **Edit criteria**, enter Markdown and choose **Save criteria**. To clear, remove the text and save. **Cancel** discards the edit after confirmation when changed. Drafts remain in browser memory while switching open tabs or responsive layouts, not across a reload. After any save error or conflicting edit, review the saved criteria using **Review latest; keep my draft** before saving again; a lost response may follow a successful save.

Optional shared Markdown criteria guide all chat participants; checklists are supported. Only authorized human participants can edit them. Clearing criteria leaves chat history intact. Criteria do not declare the chat complete, stop agents or authorize additional work. Agents receive the saved value on their next shared-context refresh; saving alone does not activate them. See [the contract](spec.md#chat-definition-of-done).

#### Agent editing capability

**Source-published in `b400e4a`; runtime/rendered qualification pending.** In **Agents**, edit the definition, open **Capabilities**, select **Edit Definition of Done** and save a new revision. It is off by default. Existing instances adopt definition changes at their next safe idle boundary; an active instance's currently applied permission remains in effect until that adoption. Saving a definition is not evidence that a running instance has already upgraded.

Enabled active participants use `conversation_definition_of_done` in their current chat only:
- Read with `{}`; the result is `{ markdown, revision }`.
- Save with `{ markdown, expectedRevision, operationId }`, using the saved revision and a nonempty operation ID of at most 200 characters. Markdown is limited to 20,000 characters before trimming; empty text clears it.
- Retry identical edits with the **same** operation ID. A replay returns its original result, which may be older than current criteria; read again for current state. Changing the text or expected revision under that ID conflicts. After a stale-revision error, read and review before starting a new logical edit with a new ID.

Tool calls recheck active membership and the instance's applied capability, including receipt replay; Stop transitions block calls. This capability edits shared criteria, not authority, task completion or human approval. Agents without it still receive criteria through shared context. See [the opt-in contract](spec.md#opt-in-agent-definition-of-done-editing).

### Adding another agent instance

**Implemented in candidate `a3a7fdf`; runtime/UI qualification outstanding ([WP-050](handoff.md#wp-050--multiple-agent-instances-and-supplemental-instructions)).** Use Participants → Add instance, or the picker's explicit add-another action. Select the definition, optionally name the instance (for example, Developer · Backend), and supply additional instructions. Inspect its base and instance instructions separately in Participants. Supplements are creation-only; they do not edit the shared definition, alter siblings or grant permissions.

Confirming **Add instance** commits membership immediately, unlike **Invite on send**. Deleting its inserted mention or abandoning the later message does not remove that member; use Remove from conversation. Closing a nonempty instance form asks before discarding its separate instance draft; conversation drafts remain intact. Errors retain the form for retry.

Adding an instance alone does not start a model response; send a public message to activate it. Each instance has separate working context but reads the shared public history and considers new messages. Mention the specific instance to request attention; ordinary mentions do not create duplicates. Coding instances share configured files, so coordinate task ownership or separate worktrees. Removing one instance leaves siblings active.

API: `POST /api/chats/:id/instances`, JSON `{ requestId, agentDefinitionId, name?, instructions? }`, returns `{ ...snapshot, createdParticipantId }`. Name limit: 100 characters; supplement: 50,000. Use the returned ID, not a participant-list diff. Retry identical requests with the same ID; replay after removal returns that historical ID without recreating it. Changed input needs a new request ID. New creation conflicts while a same-definition instance is Removing. Only participating humans can create duplicates. Ordinary invitations reuse an existing instance; ambiguous definition mentions return 409, so select a participant directly.

### Removing a conversation agent

**Implemented in candidate `54a9d3b`; runtime/UI qualification outstanding ([WP-049](handoff.md#wp-049--remove-conversation-agents)).** Open Participants, select the agent, choose **Remove from conversation**, and confirm **Remove**. Removal cancels only that instance's queued and running work; other agents continue. Its messages, tool history and saved identity remain visible. Removing becomes Removed when cleanup finishes; retry a reported cleanup failure. The agent stays fenced while cleanup is incomplete. Re-addition during Removing returns a conflict; finish or retry cleanup first.

Removal does not archive its company definition or undo file changes, external actions or charges. Unlike Stop all, sending a later message does not reactivate it. To add the definition again, explicitly invite it through Participants or an **Invite on send** definition mention. This starts a fresh instance with the current saved definition and full public history; the old instance remains historical. Use a new invitation request ID for this deliberate re-addition; replaying the original successful invitation does not add it again. Agents cannot reverse the removal themselves. Human access is managed separately.

The endpoint is `POST /api/chats/:id/participants/:participantId/remove` with JSON body `{}` and refreshed snapshot response. Retry using the same participant ID, not a replacement instance's ID. Agent snapshots expose `membership` (`active`, `removing`, `removed`) and optional `removalError`. Only an authenticated participating human can remove an agent; project read-all access alone is insufficient.

Sessions last at most twelve hours and expire after thirty minutes without an authenticated request. Stream heartbeats do not extend idle expiry. Expiry or revocation ends protected access; agent work remains owned by the service.

The left rail selects Chats, Agents, or Account and changes both the sidebar and main content. It never adds tabs. Chats retains its open conversations and selected tab while you visit another section; open agent/account forms also remain in memory. Agents lists saved agents in its sidebar, and Account links to its settings sections. Reloading returns to Chats.

Within Chats, the main tab strip appears when multiple conversations are open. Close a view with the × on its tab, or focus the tab and press Delete. With one view open, the entire tab header is absent. Use New chat in the sidebar to open another conversation as a new tab, preserving the existing tabs. On narrow screens, open the sidebar with Menu in the bottom bar.

Above 1100 pixels, use the left rail’s conversations and details icons to hide or show either side. Drag either inner divider to resize it, or focus the divider and use Left/Right (Shift for larger steps) or Home/End. These choices last while the workspace is open; reloading restores the defaults. Phone Menu and Details controls live in the bottom bar and open panels.

Hover or focus a conversation row to open its actions menu on the right. Touch layouts keep the menu button visible. The menu includes Rename, Move to project, Pin/Unpin, and Archive/Restore. Pinned conversations stay above the others within each group. Archive hides a conversation from the regular list without deleting it or stopping work; use Archived conversations at the bottom of the sidebar to reopen or restore it. Pin, archive and project choices are personal to your account, including when the conversation has other members.

Choose **Rename** from a conversation's actions menu (including archived and project lists), edit its current title, and select **Save name**. Titles are trimmed and must contain 1–200 characters. **Cancel** leaves the title unchanged; a failed save keeps your input and shows an error. Unlike pin, archive and project choices, the new title is shared with all members. It changes only Dispatch's display labels, not messages, agent context or tool directories.

### Projects

Choose **New project** inside Chats, enter a name, and select **Create project**. This creates an empty shared project with you as manager; see [Shared projects](#shared-projects) for access and defaults. Names can be reused and contain up to 100 characters. Unassigned chats appear under **Without a project**.

Select a project name to see its conversations in the main area; use the chevron to expand or collapse its sidebar group. Search finds both project names and conversation titles. **New chat** in the project view opens the starting-agent chooser and keeps that project as the destination. The sidebar's **New chat** also uses the current project's context (including the project of the active chat); starting from an agent or the welcome view makes an unassigned chat.

Chats created in a project stay in that project. Moving existing chats into or out of projects is unsupported. Unassigned chats retain their explicit membership and history. Archiving keeps project binding; active counts exclude archived chats.

Projects remain inside Chats and can open alongside conversation tabs. On phones, **Menu** opens the same project controls. New-project input remains available if a responsive layout change closes its popover; reopen New project to continue. Shared-project settings support name, membership and default-agent edits. Project descriptions, deletion UI, files and automatic context sharing remain outside this slice. Omarchy still uses its existing deployment until a later authorized update.

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
| `DISPATCH_WORKSPACE_DIR` | Default directory for new workspace-using agents unless their project selects a directory; root launchers default to the repository root, standalone service to its launch directory. Relative values resolve from the service launch directory. |
| `DISPATCH_DATA_DIR` | Writable local authentication, connections, attachments and runtime ownership state; also Pi records in SQLite mode. Root launchers default to `.local/state/dispatch`; PostgreSQL requires an explicit separate path. |
| `DISPATCH_PI_STORAGE` | Pi storage backend: `sqlite` (default) or opt-in `postgres`; see [PostgreSQL development](#postgresql-development-wp-042). |
| `DISPATCH_POSTGRES_URL` | Private database connection URL; required only for `postgres`, with host/database and no query or fragment. |
| `DISPATCH_POSTGRES_STORE_ID` | Stable logical-store identity; required only for `postgres`. 1–200 ASCII letters/digits/dots/underscores/colons/hyphens, starting with a letter or digit. |
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

In default SQLite mode, the state directory contains `auth.sqlite`, `auth.key`, and `runtime/` with Pi storage and its ownership lock. Back up the authentication database and encryption key together, along with the complete runtime directory, including `runtime/attachments/` blobs and their native Pi metadata. Attachment references without their blobs cannot be restored by rebuilding; missing bytes return 410. Stop the service before a simple file-copy backup so SQLite journals are settled. A missing encryption key must be restored; generating another key cannot decrypt existing TOTP factors. Do not copy these files into build inputs or source control.

## Agent and skill bundles

**Source-published; bounded manual archive round-trip evidence recorded.** See [manual qualification evidence and limits](handoff.md#portability-manual-qualification--october-8-2026). In Agents, choose **Import / export** to open Agent bundles.

- **Export:** select agents and optional additional skills, enter a package ID/version, then **Download ZIP**. Assigned skills use the exact selected revisions. Connections and credentials are excluded; inspect instructions for private information before sharing. This is not a project or installation backup.
- **Import:** choose a bundle ZIP, inspect definitions/instructions, model requirements, capabilities, skills and excluded connections. Resolve blockers, then explicitly allow the listed capabilities and choose **Import copies**. Imports create independent definitions and do not replace the default agent or alter existing chats. Configure connections separately.
- **Retry:** after an uncertain failure use **Retry same import**, retaining the operation ID and file. Hiding/reopening the dialog preserves this state while the workspace component remains mounted; a page reload does not preserve it. Replacing a file after an uncertain attempt warns that the earlier import may have completed. After success, **Import another copy** deliberately starts a new operation and requires authorization again.

### Developer starter

**Source-published; manual starter import demonstrated.** See [manual qualification evidence and limits](handoff.md#portability-manual-qualification--october-8-2026). The Developer starter uses repository-owned guidance, files/commands only and no skills or connections. Choose a **Model** and its supported **Thinking** level explicitly, then **Preview starter**. The generated package is `dispatch-starter-developer` version `1.0.0`; it enters the ordinary archive preview/authorization/import flow rather than modifying the existing default. Review capabilities before creating your independent copy. This is not a copy of a live Developer's settings; the demonstrated import does not qualify every model/provider combination.

### GitHub bundles

**Source-published; bounded real GitHub import/update/conflict/retry checks recorded.** See [manual qualification evidence and limits](handoff.md#portability-manual-qualification--october-8-2026). In Agent bundles, choose **GitHub**. Destination **New independent copy** imports new local records; selecting an existing tracked installation previews its update. Enter public GitHub owner/repository, package directory (empty for root) and a full 40-character commit SHA, not a branch/tag, then **Preview commit**.

Inspect Last imported, Local now and Incoming definitions, blockers, warnings, capability changes and retained local authority. Approve definitions/capability changes explicitly, then **Import copy** or **Apply update**. Updates preserve local connections and active instances adopt changed base definitions when idle. Divergent local/upstream edits to the same definition block the whole update, even when different fields changed; **Preview independent copy** offers a separate import instead. Removed-upstream definitions remain local, not archived/deleted.

After an uncertain response use **Retry same operation**. Changing destination/source or requesting another preview warns before abandoning uncertain retry identity. Closing/reopening the dialog and switching modes retain choices and retry IDs while the workspace stays mounted; page reload does not restore the browser's operation ID. Unapplied previews expire after 30 minutes or can be replaced by newer previews (at most three and 32 MiB per actor/company; 64 MiB total). Preview again if expired/replaced. A successful operation's receipt stays replayable with the same IDs after preview removal; another copy requires a new preview. Fetch is bounded to 30 seconds total, 512 KiB/file and 8 MiB combined UTF-8 manifest/Markdown data, without redirects or credentials. Private repositories, arbitrary hosts, branch/tag resolution and executable installation are unsupported.

Authenticated routes:

| Route | Request/result |
| --- | --- |
| `POST /api/bundles/starters/developer` | `{ provider, modelId, thinkingLevel }` → `{ archive, filename }`; archive is base64 ZIP |
| `GET /api/bundles/github` | `{ installations }` |
| `POST /api/bundles/github/preview` | `{ source: { owner, repository, commit, path }, installationId? }` → actor/company-bound durable preview |
| `POST /api/bundles/github/apply` | `{ previewId, requestId }` → installation/result mapping |

Apply references exactly the server-saved preview, not browser package content or a refetched commit. Preserve the request ID for retries. These routes do not make GitHub a live dependency of imported agents. See [update contracts](spec.md#github-sources-and-updates) and [acceptance evidence](handoff.md#github-bundle-imports-and-updates--october-8-2026).

### Bundle archive profile

Use Dispatch-generated archives or construct the restricted format, not arbitrary ZIP output. The archive contains `dispatch.json` and only its referenced UTF-8 `.md` instruction files; agent/skill keys are package-local. The reader never extracts files or executes code.

Limits: 8 MiB archive and total expanded file contents, 512 KiB per file, 201 entries, and at most 100 agents/100 skills. JSON instruction text is additionally limited to 50,000 characters per definition. ZIP entries must be regular stored or deflated files, with matching local/central headers, sizes and CRC. Extra fields, comments, data descriptors, ZIP64, encryption, directories/symlinks, duplicate or unsafe paths, trailing data and unreferenced files are unsupported. Many general-purpose ZIP tools add unsupported metadata; rejection does not imply their ZIP is corrupt.

### Bundle API

Authenticated JSON routes use base64 archive bytes, not multipart uploads:

| POST route | Request | Response |
| --- | --- | --- |
| `/api/bundles/export` | `{ id, version, agentIds, skills: [{ id, revision }] }` | `{ archive, filename }` |
| `/api/bundles/preview` | `{ archive }` | Parsed bundle, blockers and warnings |
| `/api/bundles/import` | `{ archive, requestId }` | Imported agent/skill ID mapping |

Reuse the same `requestId` and contents for the same import; changed contents under the same operation conflict. Use a new ID only for a deliberate additional copy. Native receipts are actor/company-scoped. Transport base64 increases request size and is not encryption. See [the first-slice contract](spec.md#first-archive-slice) for atomicity and compatibility requirements.

### Host-installed capabilities

Capabilities are distributed separately from agent bundles. Source-published `64298d7` includes private `@dispatch/pi-capabilities` JS/types for Pi Durable 1.0.4; it is not published to npm or automatically installed by import. Follow [the artifact README](../capabilities/README.md) for build/pack, provenance and approved-host integration. Explicit extension/tool selection and compatible host credentials/backend/environment remain required. Packaging checks alone do not verify installation, execution or restart; bounded independent-host observations are recorded in the [manual qualification evidence and limits](handoff.md#portability-manual-qualification--october-8-2026).

## Project historical archives

**Source-published, with subsequent browser fixes and bounded history/attachment, authorization and retry evidence.** See [manual qualification evidence and limits](handoff.md#portability-manual-qualification--october-8-2026). Separate from agent ZIP bundles and installation recovery. The data-only UTF-8 JSON format is `dispatch-project-content`, version `1`, containing project name, public chats/threads, historical authors and referenced attachment bytes as canonical base64 with size/SHA-256 checks. Limits: 32 MiB serialized archive, 10 MiB/file, 100 chats, 10,000 messages and 1,000 files total. No ZIP extraction or executable installation.

Export requires project-manager access, selects chat IDs and rechecks authorization/membership before return; missing referenced bytes fail rather than creating an incomplete archive. Inspect content and historical author labels before sharing. Import creates a new project with only the importing human as manager, no default agents, source memberships or private model state. History remains read-only, not resumed conversations or new submissions.

In the Projects navigation choose **Import project history**, select a `.json` archive, inspect counts/historical authors and **Review archived content**, then explicitly approve content/destination access and **Import as new project**. After an uncertain response use **Retry same import**; replacing the file asks before discarding the prior operation. Closing/reopening retains mounted state, not page reload.

On a project, **Export history** lets managers select current chats, acknowledge privacy and **Download history** (`project-history.json`, compact JSON). **Previously imported history is always included in full**, independently of current-chat selection; review it before sharing. **View imported history** shows the read-only archive. Attachment buttons download bytes as files, not inline executable content.

Authenticated candidate routes:

| Route | Request/result |
| --- | --- |
| `POST /api/projects/:id/export` | `{ chatIds: string[] }` → `{ archive }` (JSON object) |
| `POST /api/project-archives/preview` | `{ archive: string }` (serialized JSON) → `{ preview }` (counts/historical authors) |
| `POST /api/project-archives/import` | `{ archive: string, requestId: string }` → `{ project }` |
| `GET /api/projects/:id/history` | `{ archive }`, or null when no imported history; requires project read access |

Preview is a summary, not a durable reviewed-content token; import sends the archive again. Keep the same archive and request ID for uncertain retries: changed content with a reused ID conflicts. Replay still requires destination read access. Immutable restricted blobs are saved before atomic project/pointer/receipt admission; failed admission can leave non-visible orphan files. Back up the complete state/runtime directory, including project archive blobs. See [project contract](spec.md#project-content-and-operational-recovery) and [acceptance evidence](handoff.md#project-content-portability--october-8-2026).

## Offline installation recovery

**CLI source-published at `64298d7`; source-reviewed instructions, not verified recovery.** This is secret-bearing installation material, not a shareable project archive. SQLite only; PostgreSQL, symlinks/special files and overlapping roots are rejected. See [recovery contract](spec.md#project-content-and-operational-recovery) and [acceptance evidence](handoff.md#installation-backup-and-restore--october-8-2026).

Before any authorized operational use, stop supervisors, services, auth CLI, provider refreshers and every other writer. The runtime lock is only an additional guard. Fence the original executor before recovery. These acknowledgments are operator assertions, not automatic shutdown/proof; documentation does not authorize stopping a live service.

Prepare a restricted JSON plan with `storage: "sqlite"`, `codeRevision` identifying the deployed immutable revision, and `roots: [{ role, path }]`. Require exactly one each of `state`, `workspace`, `pi-agent`; optional roles are `connection-config` and `operator-config`. Include every external workspace/configuration/credential dependency explicitly. The current CLI accepts exactly one workspace root; it does not discover project overrides or historical instance paths. If required agent data spans additional independent directories, do not treat this archive as a complete recovery set: arrange separate consistent, restricted backups of those directories and preserve their saved paths. Roots must exist and be disjoint; nest neither backup nor restore destination inside a source. Destination must not exist and its parent must exist. Do not commit a real installation plan: paths can disclose private configuration.

After building the candidate, commands from repository root are:

```sh
node packages/web/build/service/server/recovery-cli.js backup --plan PLAN.json --destination NEW_BACKUP_DIRECTORY --writers-stopped
node packages/web/build/service/server/recovery-cli.js restore --backup BACKUP_DIRECTORY --destination NEW_RESTORE_DIRECTORY --writers-stopped --original-fenced --paths-reviewed --code-revision REVISION
```

Backup includes the listed roots and SQLite sidecars, omitting ephemeral runtime-owner lock files. It writes numbered roots plus `manifest.json`, SHA-256 inventories and restricted permissions. Protect the directory and transfer medium as credentials. Checksums detect changed bytes, not malicious provenance: use only trusted recovery material.

Restore requires the exact manifest code revision and creates numbered root directories plus `RECOVERY.json`. It neither overwrites nor starts anything. Before manual startup reconcile stored absolute working-directory/credential paths, origin/company, external environment secrets and compatible runtime/extensions/configuration. A copy is not automatically relocatable or ready to run. Never run original and restored owners together. Copied files/directory entries are synced before publishing completion JSON via a synced `.pending` file and rename. Failure can leave an incomplete restricted destination: a `.pending` file is not a completed manifest; inspect incomplete output, never start it. Missing dependencies in the operator plan are not discovered automatically. A disposable backup/restore/browser-reload rehearsal is recorded in the [manual qualification evidence and limits](handoff.md#portability-manual-qualification--october-8-2026); power-loss durability and active-task recovery remain unverified.

## Application API

`POST /api/chats/:id/preferences` accepts any combination of boolean `pinned`/`archived` and nullable `projectId`, and returns the current chat snapshot. Any human member may update their own conversation preferences; the destination project must belong to that same user/company. `GET /api/chats` includes archived records and project membership so the browser can present active, archived, and grouped lists.

`POST /api/chats/:id/definition-of-done` accepts `{ markdown: string, expectedRevision: number }` and returns `ChatSnapshot`. Markdown is limited to 20,000 characters before trimming; blank clears the criteria. Snapshots expose `definitionOfDone: { markdown, revision }`, defaulting to empty text and revision 0 in existing chats. Use the saved revision; successful saves increment it, and stale revisions return 409. Following an uncertain response, read the current snapshot before deciding whether another save is needed; this endpoint has no request-ID replay receipt. Read-only observers cannot save. Saves change metadata only, not messages or agent activation.

`POST /api/chats/:id/title` accepts `{ title: string }` (trimmed, 1–200 characters) and returns `ChatSnapshot`. Any authenticated human member may rename the shared display title. The original creation title is preserved so renaming does not invalidate creation retries.

`POST /api/projects` accepts `{ requestId, name }` and returns `{ project }`. A project contains `id`, `name`, and `createdAt`. Retrying the same request ID and trimmed name returns the original project; changed content returns 409. `POST /api/chats` accepts optional `projectId` (null or omitted means unassigned). Chat creation retries compare the original creation project, even after the conversation has moved. Names are labels; stable UUIDs identify projects.


All `/api` access requires a fully authenticated session except the authentication flow endpoints. Mutations require same-origin requests; bodies are JSON except multipart attachment uploads. Protected commands validate input; unavailable resources return 404 across identity boundaries.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Company, default agent, available model choices and supported thinking levels, provider readiness |
| `GET/POST /api/chats` | List conversations you belong to / create with a request ID |
| `GET/POST /api/projects` | List private projects / create a name-only project with a request ID |
| `POST /api/chats/:id/title` | Rename the shared Dispatch display title |
| `POST /api/chats/:id/definition-of-done` | Save or clear shared Markdown criteria with an expected revision |
| `POST /api/chats/:id/preferences` | Set pin/archive flags or assign, move, or remove project membership |
| `GET /api/chats/:id` | Recent public previews, participants, sanitized activity disclosures and history cursor |
| `GET /api/chats/:id/history` | Page older main/thread public history |
| `GET /api/chats/:id/detail/message/:item` | Complete public message or JSON download |
| `GET /api/chats/:id/detail/activity/:item` | Paired activity-detail blocks or complete JSON download |
| `POST /api/chats/:id/messages` | Admit a message idempotently; return a snapshot with status 202 |
| `POST /api/chats/:id/attachments` | Upload one multipart `file`; return `{ attachment }` |
| `GET /api/chats/:id/attachments/:attachmentId` | Session/access-checked image or download |
| `POST /api/chats/:id/stop` | Conversation-wide native cancellation; return the current snapshot |
| `POST /api/chats/:id/composing` | Publish expiring human typing presence; no draft text |
| `GET /api/chats/:id/events` | SSE `snapshot` events; `session-ended` closes access on invalidation |
| `GET /api/people` | Active company people available for invitation |
| `POST /api/chats/:id/participants/:participantId/remove` | Remove one agent instance; JSON `{}`, refreshed snapshot on completion |
| `POST /api/chats/:id/instances` | Human-only explicit instance creation; snapshot plus `createdParticipantId` |
| `POST /api/chats/:id/participants` | Invite company agents or people with an idempotent request ID |
| `GET/POST /api/agent-management/grants` | Inspect company grant/change/save history / versioned human grant update or revocation |
| `GET/POST /api/agents` | List company definitions / append a revision using optimistic concurrency |
| `GET /api/agents/:id/connections` | Read observed per-agent MCP status and the discovered tool catalog |
| `POST /api/agents/:id/connections/:connection/reconnect` | Retry initialization/discovery for a configured connection; body `{}` |
| `POST /api/agents/:id/archive` | Archive using the expected revision |
| `/api/auth/*` | Enrollment, sign-in, recovery, session and factor management, logout |

`POST /api/chats` accepts `agentDefinitionIds` (one or more), or the legacy singular `agentDefinitionId`. Message commands accept `threadId`, participant-ID `mentions`, and optional
`agentMentions` containing at most 50 company agent-definition IDs. Participants
invitation commands likewise accept at most 50 `agentDefinitionIds` per request.
Active instances are reused even after definition archival; only creating new
instances requires an active definition. For an invitation mention,
the draft Markdown uses `[@Name](mention:agent-definition%3A<encoded definition ID>)`.
Submit the corresponding definition in `agentMentions`; do not put it in `mentions`.
The server authorizes and invites/reuses those agents, rewrites invitation links to
resolved participant IDs, and commits the message and native deliveries together.
Retry the unchanged full command with its original `requestId`; do not call the
participant-invitation endpoint separately before sending. Invitation commands accept `{ requestId, agentDefinitionIds?, userIds? }`. The service binds public authorship to the authenticated human or native agent instance.

Attachment uploads return `{ attachment: Attachment }`, where metadata contains `id`, `name`, `mimeType`, `size` (bytes), `kind` (`image`, `text` or `file`) and a session/access-checked `url`. Send commands accept `attachmentIds` (at most 10 unique IDs, 25 MiB total), scoped to the same conversation and uploaded by the sender. Their Markdown `text` may be empty when attachments are present. Uploaded IDs may be reused in later messages by their uploader; duplicate IDs within one message are rejected. Retries retain both the send request ID and attachment IDs; changing attachment identity under the same request ID returns a conflict. Message snapshots include `attachments`. Shared limits and metadata are exported from `src/shared/contracts.ts`.

Agents use `conversation_attachment` with `attachmentId` and optional zero-based character `offset`. Verified images return native image content; text returns at most 12,000 characters with `textLength`, `truncated` and `nextOffset` for continuation. Download-only files return metadata with `readable: false`, not extracted content. Attachment names/content are untrusted conversation data, not instructions.

The composing command accepts `{ clientId, sequence, active }`, where each mounted composer uses its own UUID and increasing sequence number. It returns `{ ok: true }`. Only authenticated conversation members may publish presence; the service derives their identity. A true signal expires six seconds after receipt. Sending messages is independent of presence updates, and failed presence must not disable Send.

A public message can include `aliases`, prior IDs for a reconciled duplicate of the same native reply. History lookup and reply targets accept those IDs; the visible history retains one message and combines its replies. Raw native records remain intact.

### Paged chat presentation

<a id="paged-chat-presentation-performance-candidate"></a>

**Published and locally installed at `e87c0ab`, October 8; scoped verification and demonstration complete.** The [performance package](handoff.md#chat-presentation-performance--october-8-2026) tracks exact source/build revisions, scoped real-service measurements, delivery receipts and workload/platform limitations. The API table reflects this paged transport; older installations retain their prior full-history GET/SSE behavior until updated.

- Chat opening and mutation responses carry recent main-timeline previews plus `history: { before, generation }`, not the entire transcript. Choose **Load older** for earlier content. Threads have independent paging, a separately supplied root, and authoritative reply counts.
- `GET /api/chats/:id/history` accepts optional `threadId` (root ID or alias, at most 300 characters) and opaque `before` (at most 1,000 characters). Response: `TranscriptPage` with `messages`, `activities`, `threadId`, `generation`, nullable `before`, and optional `revision`/`root`/`replyCount`. The runtime includes its current presentation revision for thread refresh tracking; this does not replace the opaque cursor or alias-generation check. Use the returned cursor unchanged. Invalid or invalidated cursors return 409 / `HISTORY_CHANGED`; discard the stale page cursor and reload the current timeline. Alias-map generation changes invalidate loaded pages so suppressed duplicates do not survive.
- The implementation targets 40 timeline items and a 256 KiB page budget including the separate root, with 24 KiB message previews. Large messages carry `truncated: true` and **Download complete message** rather than silently discarding their stored body, including the separately displayed thread root. **Copy message** fetches the complete text for a truncated preview; browser text selection still sees only mounted preview content. These are presentation budgets, not a proven bound on complete snapshots, participant metadata or every exceptional item; observed byte-bound qualification is recorded in the package.
- Activity rows initially show a compact **Agent · Activity · N records** button (**Working** while active). Select it to load and expand the recorded activity on demand; opening it does not rerun the work. This reduces initial loading/rendering, not access to stored history. `GET /api/chats/:id/detail/activity/:item` returns `{ items, before, total }`; optional nonnegative integer `before` pages older logical blocks. Calls/results are paired before paging; pages target at most 20 blocks / 256 KiB, and oversized blocks become a **Download** placeholder. **Older activity**, **Latest activity**, and **Download complete activity** are separate actions. `detail/message/:item` returns the complete public message; `?download=1` on either detail route downloads `chat-detail.json`. Complete detail/download responses are intentionally outside preview budgets. Keep downloads private when their content is sensitive.
- SSE starts with `snapshot`, then `delta`. Deltas contain `baseRevision`, current metadata in `snapshot`, changed `messages`/`activities`, and `removedMessages`/`removedActivities`; omitted `participants` means unchanged. Apply each delta only against the matching chat and last delivered stream revision, not a newer HTTP mutation response. Preserve native `timelineOrder` as the tie-break for equal timestamps; do not substitute lexicographic ID order. A missing reset or revision gap requires reopening GET/SSE. A new SSE connection starts fresh; no Last-Event-ID replay guarantee is introduced. Removal from the recent live window does not delete separately loaded historical pages or native history.

After a dependency-changing local update, refresh existing tabs if Vite reports mixed old/new dependency errors. Copy unsent drafts before refreshing: drafts remain memory-only, not reload-persistent.

All history/detail reads and stream delivery retain current session/company/chat authorization and public-content sanitization. Browser virtualization bounds mounted rows, not retained native history; ordinary browser find/copy can only see currently mounted content. The exact shared types are `src/shared/contracts.ts`, `src/shared/chat-updates.ts`, and `src/shared/activity-page.ts`.

The precise shared types are in `src/shared/contracts.ts` and `src/shared/auth-contracts.ts`. See [runtime.md](runtime.md) for native storage, cancellation, and request identity. The browser never sends an authoritative user or company ID for access checks.

## Dependency updates and later deployment

The runtime pins Pi Durable, Pi AI, Chord, Pi Coding Agent, and Pi MCP to 1.0.4. Keep these directly used packages aligned when upgrading so the application and native harness share compatible provider, document, and credential implementations. After installing an updated lockfile, restart the development launcher to load the new runtime; frontend hot reload alone does not replace the persistent backend.

Use exact versions in the owning manifest and commit the root dependency lock. To update `npmDepsHash` in `packages/web/nix/package.nix`, temporarily set `lib.fakeHash`, run `nix build`, replace the placeholder with the reported actual hash, then rebuild. Never commit a placeholder. Toolchain changes through `nix flake update` also require a build.

Installation-specific hosting, artifact pins and deployment evidence belong in the owning infrastructure repository; the [handoff](handoff.md#wp-043--isolated-palm-postgresql-trial) links the isolated Palm trial and its qualification limits. This does not establish deployment of the latest source. Loopback development cannot be opened directly from a phone; real-device access requires an authorized reachable environment. CI and release automation are unconfigured. Follow the [testing policy](spec.md#testing-policy) for permitted verification.

### Agent skills

In the agent editor, Skills lets you create reusable text playbooks and explicitly select revisions for that agent. Creating a skill does not select it. Save the agent revision to apply selected skills to new instances and safe idle base upgrades of active instances. Editing a skill alone does not upgrade assignments; select the newer revision deliberately, then save the agent definition.

Only assigned skills are advertised to the model, which can call `load_skill` with the advertised ID. No Files and commands capability is required. Unassigned IDs are rejected by the loader. This is not filesystem isolation for coding agents.

`GET /api/skills` returns the company's latest skill revisions. `POST /api/skills` creates or revises a text skill with name, description, instructions and requestId; updates also require id and expectedRevision. Agent saves accept `skills: [{ id, revision }]` (up to fifty). The text-skill editor does not upload supporting files or enable scripts. Agent/skill definition imports use the separate [bundle workflow](#agent-and-skill-bundles).

#### Bundled browser and dogfood skills

In development, the backend hot reloads when the watched checkout receives these changes; no manual restart is needed. Source publication alone does not verify catalog availability or assigned-skill loading; see [the recorded evidence and remaining checks](handoff.md#bundled-agent-browser-and-dogfood-skills).

The browser-skill integration seeds **Agent browser** (agent-browser core) and **Dogfood** (exploratory QA) text playbooks from pinned upstream 0.38.2 once per company. In the agent editor, select the desired skill revisions and save the agent; neither skill is automatically assigned. Assign both for a QA agent that needs browser-operation and bug-reporting guidance. Editing a skill alone preserves existing snapshots; explicitly saving newer assignments on the agent definition applies them to new instances and safe idle base upgrades of active instances. Startup does not overwrite user-edited skill revisions.

Loading either playbook requires no Files and commands capability, but **executing agent-browser does** require an authorized command tool and an independently installed, reviewed CLI, Chrome and recording prerequisites on the execution host. This integration supplies no Browser capability and installs nothing. Before use, check the executable/version and recording support; missing prerequisites are a blocker, not permission to install or upgrade tooling.

Use only explicitly authorized targets/accounts. The current pilot uses disposable loopback state; broader targets need separate approval. Keep unique owned sessions, close them after the run, and retain account-bearing evidence privately under gitignored `.local/` with directories 0700/files 0600. Start recordings after authentication and scrub secrets/sensitive URLs before sharing. Verify actual outcomes: an exit code of zero or a “Saved” message is not a QA pass. Credential-safe enrollment/TOTP entry remains unverified; do not copy upstream secrets-in-CLI-arguments examples.

Pinned upstream provenance, licensing and the distinction between upstream text and Dispatch guidance belong in [the source provenance guide](../server/skills/agent-browser/README.md). Required dogfood report/taxonomy material is embedded; optional upstream filesystem references are not automatically available. Definition/Markdown imports use the [bundle workflow](#agent-and-skill-bundles); arbitrary supporting-file packages and script execution are not supplied by these playbooks.

### Shared projects

Select a project to search its chats by title or show only Active chats. Status and last activity come from the current chat summaries. The right-hand Project details panel lists members and default agents; managers open Project settings there. On phones, open Details in the bottom bar. Search and settings drafts remain available while switching views.

New project now creates an empty shared project with you as its manager. Project settings lets managers rename it, select default agents and add/remove members or managers. Keep at least one manager. Members can read every project conversation, including history from before they joined, and participate. Removing membership denies later requests and snapshot delivery; previously delivered information cannot be recalled. Already admitted agent work is not canceled.

**Project working directory (source-published October 8; type/build checks passed, runtime/rendered qualification pending):** managers can set **Working directory** in Project settings to an absolute existing directory on the executing service host. This is not a path on the browser computer; in a cloud installation it must exist on the worker host. Leave it blank to use `DISPATCH_WORKSPACE_DIR`. Saving affects new agent instances, including later invitations, not existing instances or their resumed work. The setting does not clone repositories, move files or isolate filesystem access; use explicit Git worktrees and coordinate shared-checkout edits. Missing directories fail at execution rather than being recreated. Project-content exports omit this host-local setting; configure it separately after import.

**Implemented October 8; browser behavior and rendered UI remain unverified (see [WP-053](handoff.md#wp-053--project-row-chat-creation-and-shared-only-projects)):** the compose icon on a shared-project sidebar row starts a fresh chat in that project with its default agents and focuses the message box, without a setup dialog. Its tooltip is **New chat in [project name]**. Existing tabs/drafts stay intact; the new chat does not inherit another chat's history. The action requires project participation, not read-only access.

For custom setup, **New chat** opens the chooser. Default agents are preselected when starting a chat in the project; adjust the selection before creating it, including selecting none for a people-only conversation. Existing conversations keep their own participants and configuration. Add human access through project settings, not the conversation invitation picker. Default agents are not an allowed-agent restriction.

**Shared-only decision, October 8:** personal groupings are no longer a supported product workflow; their obsolete API/UI paths have been removed. Shared projects cannot receive existing chats or move their chats to another audience in this slice. Removing personal-group support does not automatically expand chat access.

Operators can set `DISPATCH_READ_ALL_PROJECT_USER_IDS` to comma-separated stable user IDs from the company's authenticated people directory. The default is empty. These users can read all shared projects in their company but cannot participate or manage settings without explicit membership. The grant excludes standalone conversations and legacy personal groupings. Changing it requires a backend restart. No grant for Ben or another person is inferred from a display name or provisioned by this release.

API: `POST /api/projects` with `{requestId,name,kind:"shared"}`; `POST /api/projects/:id` with `{requestId,expectedRevision,name,members:[{userId,role}],defaultAgentDefinitionIds,cwd?:string|null}`. `cwd` omission preserves the saved directory; blank/null clears the project override. `GET /api/projects` returns shared projects and current participation/management flags. Creation requires `kind: "shared"`; omitted/other kinds are rejected. `POST /api/chats` uses `sharedProjectId` for the project audience. Obsolete `projectId` input (including null) is rejected by chat creation and preference updates, not reinterpreted. Preferences accept pin/archive changes only. Historical request fingerprints are preserved; this is not a native-history purge. Omitted agent selections resolve project defaults; explicit selections override them. Retries retain the original request object. Project-save replay still requires current manager access and returns current state; losing your own access can therefore prevent replay even when the original save committed.

The UI refreshes project/conversation lists periodically and on return to the page; active stream denial clears its displayed snapshot. This is not a mechanism for erasing content already received. Broad coding tools, company-shared definitions and connections remain separate confidentiality boundaries: do not treat project permissions alone as protection for restricted files or credentials. Multi-user authorization and device behavior still require functional qualification before a restricted-data rollout.


### Image generation

Enable **Image generation** in an agent's Capabilities and save a new revision. Assign the seeded **Image generation** skill separately for prompting guidance. Saving these selections updates active participants at the next safe idle boundary; history and instance instructions remain intact. Files and commands is not required for generation itself. The service's configured workspace must exist and OpenAI platform credentials must be available through its existing Pi credential configuration. ChatGPT/Codex subscription credentials are not substituted.

`generate_image` generates from a prompt or edits workspace reference PNGs with an optional mask. It defaults to `gpt-image-2.5-sunburst`; specify another supported model explicitly when needed. References leave the workspace for OpenAI processing. The tool also returns generated image pixels for the agent to inspect before presenting them. Outputs and run metadata remain workspace files; no gallery, automatic conversation attachment, or cleanup job is added. Metadata may contain private prompts and reference paths, so protect workspace storage and backups. The repository ignores its root `imagegen/` output directory; this prevents accidental commits, not filesystem access or publication. Share intentional outputs through the attachment workflow.

Generation may incur provider charges. There is no automatic retry. After interruption, inspect the existing run record and outputs before deciding whether to request another generation. An incomplete record or locally cancelled request does not prove OpenAI stopped or avoided a charge. Rewind does not delete outputs or reverse charges. Skill guidance is not a permission grant or a guaranteed workflow.

### Sharing generated files from agents

After generating a file, an agent calls `conversation_attach` with its workspace-relative path. This snapshots the file privately and returns an attachment ID. The agent then includes that ID in `conversation_post`'s `attachmentIds`. Preparation alone does not share the file; it becomes readable by conversation members only when the post is admitted. The same workflow supports ordinary generated files as well as images, using the existing 10 MiB per-file, 25 MiB per-message and 10-file limits.

Do not paste base64 into messages or treat workspace paths as browser links. A stopped or discarded draft leaves its prepared files private. Retained prepared/orphan blobs may consume storage; no automatic cleanup is promised. The tool omits `input_fidelity` for generation and GPT Image 2/2.5 edits. It forwards an explicitly supplied value only for supported legacy edit models. Provider rejections identify a safe parameter name when available. For localized edits, supply a PNG alpha mask matching the first reference: transparent pixels mark the edit region. Inspect output pixels and text before publishing; neither a prompt nor a mask proves unchanged regions are pixel-identical. A revised shared skill must be explicitly selected and saved on an agent definition; active conversation instances adopt that selection at the next safe idle base upgrade.

## Web research

In the updated application, open **Agents → Edit → Capabilities**, select **Web reading**, **Web search**, or both, and save. Web reading exposes `web_read` for `open`, `find` and `click`; Web search exposes `web_search` for `search_query`. Active instances adopt the saved selections at the next safe idle base upgrade. Files and commands, MCP connections and skills are not required.

Direct public HTML/text URL reads need no API key or paid retrieval API; normal model/network costs remain. Search additionally requires an Exa credential grant in **Settings → Secrets** and may incur Exa charges. Search-only agents receive snippets and source URLs, not full-page evidence; enable Web reading too if they must open results. This is independent of the Exa MCP skill/connection and does not inherit its credentials.

Existing combined Web research assignments migrate to both capabilities without changing credential grants. To allow reading only, uncheck Web search and save. Historical evidence is preserved; disabled reading cannot be bypassed by using a saved reference. Legacy `web_run` remains only for persisted-call compatibility, with current permission checks.

Call `web_read` with `open`, `find` and `click` arrays. For example:

```json
{"open":[{"ref_id":"https://example.com/docs"}],"response_length":"short"}
```

Use the returned `web_…` reference for subsequent reads and literal finds. `open` accepts `lineno`; `find` accepts `pattern` and optional starting `lineno`; `click` accepts the page reference and its numbered link `id`. Lines and links start at 1. Short/medium/long windows contain 20/60/120 display lines. `refresh:true` fetches a new snapshot rather than changing the saved one. Search results are snippets; open them before claiming full-page evidence. Cite source URLs with normal Markdown links.

References are private to the agent's working conversation, not portable across participants. Snapshots remain stored with native conversation state; there is no automatic expiry. Evidence is retained without application-imposed text/link/body caps; pagination bounds presentation only. No application-imposed request deadline is added; Stop supplies cancellation. Memory/storage and upstream provider limits still apply. Interrupted batches are not automatically repeated, even if they include cached reads; a new retrieval may repeat charges. Completed saved snapshots remain accessible.

Direct extraction is not a browser: JavaScript-only pages, authenticated content, PDFs and image interpretation are unsupported. Public HTTP(S) only; private/local destinations and nonstandard ports are blocked. Websites and search content remain untrusted evidence. Extraction can omit layout or content; respect truncation/error markers and do not claim an inaccessible page was read.

### Exa search credentials

Open **Settings → Secrets**. Choose encrypted storage and enter an Exa API key, or select the server's fixed `EXA_API_KEY` environment source. Select the agent definitions allowed to use it, then save. Enable **Web search** on those agents separately; the grant does not enable either capability. Environment-only installations now need this explicit assignment; an unset grant never inherits the server key.

Only the saving user manages their credential. Grants cover the definition's existing and future instances and conversation audiences. Replacing a stored key takes effect on subsequent search calls without restarting agents. Changing the process environment still requires relaunching the server. “Configured” is not provider verification. A conflict means another tab changed these settings; reload before saving again.

Disconnect removes local access for every assigned agent, without falling back to another credential. Revoke the API key at Exa separately if needed. Already-running requests and saved search results remain. Direct URL reading does not need an Exa key. Back up `connections.sqlite` and `connections.key` together using the existing connection-store backup procedure. Codex configuration and arbitrary vault commands are not imported automatically.
