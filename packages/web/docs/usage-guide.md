# Dispatch Web usage guide

Dispatch Web provides company sign-in, invite-only shared conversations on stock Pi Durable, shared named agent definitions, and a branded desktop/mobile workspace. This is a local development implementation. Source/type/build checks are permitted; functional and browser qualification are deferred under the [testing policy](../../../CONTRIBUTING.md#testing-policy).

## Start development

Use Nix with `nix-command` and `flakes` enabled. Install Nix before using the application tooling. Open a new terminal after installing Nix. An existing terminal can use `/nix/var/nix/profiles/default/bin/nix` directly.

From the repository root:

```sh
nix develop
npm ci
npm run dev
```

The current local development instance uses `http://localhost:5174` (verified October 11, 2026). The launcher still defaults to port 5173; to select 5174 explicitly on a future start, use `DISPATCH_WEB_PORT=5174 npm run dev`. Use the URL reported by Vite for an already-running frontend; do not start another service against the same state just to change ports. The development launcher runs Vite on localhost and the API/Pi service on `127.0.0.1:3001`, proxying `/api` through Vite. Frontend-only edits hot reload without restarting Pi. Node watches the service entry point and its imported modules, including the shared contracts used by the service. Changes to those files send SIGTERM and wait for the old backend to exit before starting its replacement against the same state. Shutdown drains Pi work and releases provider session resources, including cached model WebSockets and their idle timers, before the old process exits. The frontend stays running through that brief backend interruption. Pi owns recovery of interrupted native work; a restart is not an uninterrupted model or tool session. Browser disconnection does not restart the Pi owner.

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

## 0.3.0 Mac qualification

The checks below used fresh disposable state. Upgrading retained state from an earlier version and restoring a backup into 0.3.0 remain unverified; successful fresh installation or restart does not establish either.

On October 12, 2026, the published `dispatch-0.3.0-darwin-arm64.tar.gz` (SHA-256 `59855cf1fe8ca7bee60e6143b43b4232c331365175b22c2af4d61ac6585b2a00`) was exercised on Apple M1/macOS 27.0.1 with disposable state, without changing any shared service. Bundled-runtime startup with a minimal environment and no Nix/Homebrew passed. Browser enrollment, sign-out/sign-in, saved project/spec/chat readback after controlled SIGTERM/relaunch, and one real OpenAI model response with persisted chat content passed. Enrollment used Chrome's virtual CTAP2 authenticator, not a physical passkey device; desktop 1440×900 and phone 390×844 walkthroughs are scoped evidence, not full-app responsive/accessibility acceptance.

Known presentation limit: on the 390 px model-chat screen, a long automatic title made the empty composer placeholder wrap into the attachment-button row; message/reply content remained readable. A separate guarded SIGTERM interruption observed a running native generation and delivery; the same task IDs completed after relaunch without a user-abort flag. Browser readback confirmed one human message and one completed reply after reload, without resending. This is one tool-free admitted-generation recovery path, not mid-token continuity, tool replay safety, exactly-once billing, forced-crash recovery or backup restoration. AWS installation remains unqualified; Both GHCR packages are public, with anonymous pulls verified against the reviewed digests; registry references are in the [release notes](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.3.0) and the [Windows quick start](../../../README.md#windows-with-wsl2). Private receipts: `.local/release-030-install-developer/README.md`, `.local/release-030-browser-249989/README.md`, and `.local/release-pi-review/9e8acef/` (controlled/active restart lifecycle and task-outcome receipts). Do not publish enrollment links, account credentials or provider keys with evidence.

On the same date, the identical checksum-verified Mac archive passed isolated installation/startup on a MacBook Pro with Apple M4 Max (64 GB), macOS 27.0.1 build 26A434: version 0.3.0, fresh invitation creation and HTTP 200 serving with a minimal environment. Virtual-WebAuthn enrollment and one real model response also passed against that M4 backend, with Chrome running on the M1 host through an SSH tunnel rather than on the M4 itself. After controlled idle SIGTERM/relaunch, the same project/spec revision, human message and model reply remained, the session stayed authenticated, and sign-out/sign-in with the registered virtual passkey passed. This is saved-state persistence, not M4 active-generation recovery or backup restoration. Private receipts: `.local/release-030-m4-developer/README.md` and `.local/release-030-m4-browser-249989/README.md`. The M1 active-generation result above is separate.

## 0.3.0 Windows/WSL2 qualification

On October 12, 2026, the checksum-verified published Linux/AMD64 controller archive started in an isolated Windows 11 VM with Ubuntu 24.04 WSL2, Docker Engine and Compose 2.40.3. The documented archive load/retag/foreground-Compose route, fresh invitation creation, HTTP 200 serving and signed-out session HTTP 401 passed from WSL and Windows PowerShell. The container ran as user 65532 with a read-only filesystem and host-loopback-only publication, using a fresh project/data volume without changing the existing installation.

Virtual-WebAuthn enrollment and one real model response passed against that backend, with Chrome on the M1 host through an SSH tunnel—not Windows Edge or a physical passkey device. A controlled idle stop/start exited cleanly after SIGTERM (code 0 in about 0.381 seconds), then reopened the same named volume. The session, same spec revision and single model reply survived; sign-out/sign-in with the registered virtual passkey also passed. Docker persists provider environment variables in daemon metadata; shell forwarding is not memory-only. The temporary provider file and owned credential-bearing container were removed, and browser/tunnels closed; the separate disposable volume and sanitized receipts were retained. This cleanup is not a secure-erasure guarantee. Private receipts: `.local/release-030-wsl-claude/README.md` and `.local/release-030-wsl-browser-249989/README.md`. This does not qualify Docker Desktop, unattended reboot startup, active-generation recovery on WSL, forced-crash recovery or backup restoration.

## First account and sign-in

Authentication errors include a support reference. Operators can find the matching `authentication_failed` JSON record in the service's stderr/CloudWatch logs. It includes the endpoint, HTTP status, error code, safe rejection category, bounded browser user-agent and an ALB trace root when available. Passkey categories distinguish an unrecognized credential, user-handle failure, signature rejection, challenge/origin/RP mismatch, user verification, counters and credential changes. Public errors remain generic; never ask someone to send their passkey, password, verification code or recovery code for diagnosis. ALB access logs, when separately enabled, add request-level evidence but do not contain application verification reasons. The browser user-agent does not identify the passkey provider.

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

### Application provider setup

**Implemented; source/build, scoped browser checks and local OpenAI OAuth chat/tool use pass. Broader account lifecycle qualification remains unverified.** Settings → Model providers manages installation-wide credentials shared by workspace agents. Any fully authenticated installation user can manage them; setup prompts and attempts belong to the initiating session. OpenAI offers ChatGPT OAuth or an API key; Claude and Fireworks initially offer API keys. A previously stored Claude OAuth grant may still show its stored status, but **Replace key** uses the supported API-key method; OAuth reconnect is not offered. Select OpenAI for OpenAI agents. Available models come from Pi; saving a credential is not proof that an account can use every catalog model.

Open **Settings → Model providers** (on phones, **Menu → Model providers**), or the direct `/?section=model-providers` link. Choose **Connect**, **Change account**, **Replace key**, or **Reconnect** on the provider card. Choose its authentication **Method**, select **Continue**, and follow Pi's prompts. **Disconnect** requires confirmation; an active setup can be restored through **Resume setup**. Use **Reload status** after an uncertain response rather than starting another authorization blindly. For OpenAI OAuth, follow the provider sign-in link and, when prompted, paste the **full loopback callback URL** into Dispatch. With a remote backend the callback may not load in your browser; copy its address rather than sharing it in chat, screenshots or support logs. Startup requires `PI_OAUTH_CALLBACK_HOST` to be unset or exactly `127.0.0.1` and pins the listener to that address. Do not publish a callback port to make remote sign-in work. API keys are entered in protected fields and are never redisplayed. Account information appears only when returned by the provider. Modern OpenAI OAuth does not supply a verified account identity through the current Pi interface; its client ID is not an account name.

“Key saved” and “Authorized” describe stored credentials, not a live connection test. “Reconnect required” identifies an interrupted credential update that cannot safely be reused. Storage outages or decryption failures require operator diagnosis, not automatic deletion/reconnection. Replacement keeps the old account until a successful save. For an interrupted update, explicitly disconnect its uncertain local credential before starting a new connection. Cancellation stops waiting for input; an exchange already admitted to the provider may still complete and save. Reload status before retrying an uncertain result.

Disconnect removes Dispatch's stored credential; it does **not** revoke the upstream key or grant. Revoke provider access separately when needed. Pi can still resolve operator-supplied environment or model-file credentials after local deletion: the provider then shows **Externally managed**, not disconnected. Those credentials must be changed or removed by the operator outside Settings. Changing installation-wide credentials affects agents using that provider, not their saved provider/model selections or past messages.

**Credential storage:** app-managed providers use encrypted application storage. Connect through Settings even if Pi is already configured separately: Dispatch does not import OAuth grants from Pi's `auth.json` or modify that file. Connecting in Dispatch does not revoke a separate upstream grant. The local adapter stores `providers.sqlite` and `providers.key` under the application state directory; keep the database and matching encryption key together in restricted backups. Use a coordinated all-writer shutdown/backup procedure, not a live file copy. Losing the key prevents decryption. PostgreSQL installations retain their existing externally keyed encrypted store. Existing Pi model/settings files continue to supply configuration as described below.

Application API (authenticated same-origin requests):

| Endpoint under `/api/model-providers` | Request / result |
| --- | --- |
| `GET /` | `{ providers, attempt }`: stored status, supported methods, model catalog, opaque revision and this session's active attempt or `null` |
| `POST /:providerId/connect` | `{ type, revision }` → login attempt |
| `GET /attempts/:id` | Current session-bound attempt |
| `POST /attempts/:id/answer` | `{ promptId, value }` → updated attempt |
| `POST /attempts/:id/cancel` | `{}` → attempt after admitted work settles |
| `POST /:providerId/disconnect` | `{ revision }` → refreshed `{ providers }` |

Use the latest opaque revision; a stale revision returns 409 and requires reloading status. Attempts belong to their initiating session, and only an active attempt needs polling. After a lost Connect response or browser reload, reload provider status to recover the current session's active attempt instead of replaying Connect. Attempts are ephemeral server state; a backend restart requires a fresh setup after reviewing stored status. Completion refreshes the application's model configuration. Provider setup unavailable on an installation returns 503. See [acceptance evidence](handoff.md#model-provider-setup--october-10-2026).

### Claude Agent SDK setup

**Local integration candidate; authenticated execution and Stop/recovery acceptance pending.** The Agent SDK execution backend runs official Claude Code under a Pi-owned task. It is separate from Settings → Model providers: a Claude API key saved there or a historical Pi OAuth grant does not sign in the SDK runner. See the [runtime boundary](runtime.md#claude-agent-sdk-integration).

Native sign-in must happen on the execution host, under the operating-system account and configuration directory the runner uses. Follow Anthropic's [installation and authentication guidance](https://code.claude.com/docs/en/authentication). With the official CLI installed:

```sh
claude auth login
claude auth status --text
```

These commands authenticate and inspect Claude Code, not Dispatch. Complete the browser/code flow in Claude Code's terminal; do not paste tokens, callback URLs or login codes into chat or Dispatch's secrets/provider fields. Authentication status can contain account information; keep it out of shared logs and screenshots.

If using a separate native profile, use the same `CLAUDE_CONFIG_DIR` for login, status and execution. Each native profile has its own settings, session history and subscription login. On macOS, native credentials normally use Keychain; other platforms and the macOS fallback use Claude Code's protected credential file. Dispatch must not extract or copy those credentials. A successful terminal login under another account or profile does not establish runner readiness. The candidate runner does not inherit Dispatch's API/cloud credentials or filesystem `apiKeyHelper` settings. An owner-controlled wrapper selected by `DISPATCH_CLAUDE_EXECUTABLE` can initialize the owner's native environment and `exec` the unmodified official binary. Its launch/initialization and joined shutdown were interactively verified with SDK 0.3.296/Claude Code 2.1.296 on October 12, without credentials or a model prompt. Actual API-key/cloud authentication and inference remain unverified; do not forward Dispatch's global credentials.

Configure the local service's runner binding before starting SDK work:

| Service environment variable | Purpose |
| --- | --- |
| `DISPATCH_CLAUDE_USER_ID` | Required Dispatch user ID owning the native environment, not an Anthropic account ID/email. The owner must be an active human participant with current chat/project participation access. |
| `DISPATCH_CLAUDE_HOME` | Optional native profile home; defaults to the service environment's home. This changes profile lookup, not the subprocess's operating-system identity or filesystem permissions. |
| `DISPATCH_CLAUDE_CONFIG_DIR` | Optional native configuration directory, passed as `CLAUDE_CONFIG_DIR`; use the same directory for CLI login/status. Without an override, the runner uses the service environment's native profile settings. |
| `DISPATCH_CLAUDE_EXECUTABLE` | Optional path to an official, unmodified Claude Code executable or owner-controlled wrapper that executes it; otherwise use the SDK's packaged executable. |

While signed in as the intended owner, inspect `GET /api/auth/session` on this installation and use `user.id` for the binding; do not share the entire response. Restart the local service with the selected configuration. Dispatch does not verify that the native Anthropic account matches this user ID: the operator must bind the correct user's environment. Missing owner configuration, absent participation or revoked access blocks SDK execution. Changing the owner after admission rejects a saved execution checkpoint; it does not silently transfer work to another subscriber.

In Agents → Edit → Model, choose **Runtime → Agent SDK**, an Anthropic model and its supported Thinking level, then save. SDK model choices do not require Pi Anthropic credentials and do not prove native account/model access. Existing definitions without an execution backend use Pi; updates reach existing instances at their safe idle adoption boundary. Native login alone neither changes the saved backend nor connects Dispatch's provider card. Hosted workers reject SDK execution in this candidate; setting local environment variables does not provision per-user hosted authentication.

If Dispatch reports authentication failure even though `claude auth status` says logged in, repeat `claude auth login` under the configured runner account/profile. Status alone does not prove the provider will accept an inference request. Model-unavailable errors require an account-accessible SDK model; usage/rate-limit errors require checking the native account's limits. Shared status uses fixed error categories rather than raw provider diagnostics; inspect native sessions privately and do not publish their contents.

After interrupted execution, inspect workspace/external effects before retrying. Pi's durable task state and an SDK session ID do not back up the native session files or guarantee exactly-once shell effects. A run interrupted before its result is committed must not be described as completed or silently resent. Stop/restart acceptance remains pending.

### Pi configuration and agent defaults

The service uses Pi's public `ModelRuntime` from the pinned coding-agent package. Before the provider-setup cutover it reads the operator's Pi credential/model files from `~/.pi/agent`; the candidate above replaces credential ownership for app-managed providers. Pi owns credential resolution and serialized refresh, including OAuth. Secrets stay on the service and do not enter browser snapshots, Git, build artifacts, or the Nix store.

When seeding the company's default agent for the first time, explicit `DISPATCH_PROVIDER`, `DISPATCH_MODEL`, and `DISPATCH_THINKING` override Pi's `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`. Without either configuration, the fallback is `openai` / `gpt-6-sol` / `off`; the provider still needs credentials. `DISPATCH_PI_AGENT_DIR` selects a different existing Pi configuration directory. Provider environment credentials supported by Pi can also be supplied to the service. Use Personal Vault's process injection for secrets rather than putting them on the command line or in committed files.

Developer (`developer`) is the default agent and includes local coding tools. It is saved on first startup and can be edited in Agents just like other definitions; subsequent restarts or changes to the service defaults do not overwrite it. The Agents section creates company-shared definitions with instructions, provider/model, and supported thinking levels. Each save produces a new immutable revision. New instances copy that configuration; existing active instances adopt base updates at the next safe idle boundary, preserving identity and history. A stale edit returns a conflict. Archived definitions cannot start new chats or be edited; user-driven archive restoration is not supported (the Developer default migration below is a startup exception). Configuration restoration for an eligible active target is described under [permissioned agent management](#permissioned-agent-management).

**Update policy:** saved does not mean applied. In Participants, **Base revision applied** identifies adopted instructions/model/capabilities/selected skills; a newer saved base revision shows Pending until adoption succeeds. Instance connections lists actual MCP assignments separately, with Pending update for queued connection work. Supplements and workspace paths survive upgrades. No remove/reinvite is needed. A failed application retains the old configuration and reports a safe error; reconciliation retries on later eligible boundaries and startup. Candidate source/build evidence does not establish runtime or rendered acceptance.

In Agents, New agent is at the top of the sidebar, followed by Find an agent and the saved-agent list. Select an agent to read its description and instructions; the right column shows its saved configuration. Start chat opens the starting-agent chooser with that definition selected. Hover or focus an agent's row for Edit and, for non-default agents, Archive; touch layouts keep the actions visible. Archived agents is at the bottom of the sidebar and supports inspection, not restoration. The default agent keeps its Default tag and cannot be archived.

New agent opens an editor with the saved default agent's model/thinking values. Fill in the sections described under [authoring navigation](#agent-overview-and-authoring-navigation); Discard and Create agent/Save new revision stay below the scrolling form. The right column previews the unsaved draft and distinguishes changes from the saved revision for existing agents. Choosing another agent or starting a new edit asks before discarding unsaved changes. Switching to Projects, Chats or Settings, hiding a column, or changing screen size preserves the open editor. On phones, Start chat fills its row and the agent view includes a short model/thinking/tools summary; Details exposes the full configuration.

Instructions format Markdown while you type or paste, using the same editor as chat. Headings, lists, quotes, emphasis, links and code remain editable. Enter adds a paragraph or list item; Shift+Enter adds a line. Use Create agent or Save new revision to save. Saved instructions stay rendered when viewing the agent. Instructions remain Markdown text; formatting may normalize when edited. Drafts over 50,000 characters including Markdown formatting stay editable and show an error until shortened. Unsupported editor syntax remains text, and drafts are not saved across page reloads.

### Agent overview and authoring navigation

The Agents sidebar has a named ellipsis menu for Edit and, except for the default agent, Archive. Select an agent to read its instructions, skills and connections. **Overview** and **Evaluations** share that agent context. **Edit agent** opens one draft with Identity, Instructions, Model, Capabilities, Skills and Connections shortcuts. These shortcuts scroll to sections without saving. Instructions offers bold, italic, inline code and list formatting; Markdown remains the stored format. The desktop Configuration column opens with the editor and shows draft values; phones expose it through **Details**. **Discard** and **Save new revision** remain in the footer.

Switching back to **Overview** retains an evaluation draft in memory. To discard it, use the evaluation editor's **Cancel** or **Back to agent** and confirm when asked. Reloads still lose in-memory drafts.

### Agent evaluation profiles

WP-047 adds a separate Evaluation profile section for saved agents. Focused disposable-data demonstrations cover persistence, conflict recovery and desktop/390 px rendering; broader accessibility, real-device and crash-recovery qualification remain outside that evidence. md#wp-047--agent-evaluation-profiles-and-editor).

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

### Connect an MCP server

1. Open **Settings → Connections → Connect server**, or **Agents → Edit → MCP connections → Add connection → Connect another server**.
2. Enter a name and the server's Streamable HTTP URL. HTTPS endpoints can use any path; HTTP is supported only on loopback. Choose the authentication method documented by the provider: **OAuth**, **Bearer token**, **Custom headers**, or **No authentication**. Token and header values are entered in password fields and stored encrypted by the service.
3. For OAuth, continue to the provider's sign-in/consent window. **Advanced OAuth settings** accepts optional space-separated scopes and a registered client ID/secret when automatic client registration is unavailable; it shows the callback URL to register. Blank scopes use the server's advertised requirements. Dispatch does not create an upstream account or agent.
4. Choose the connection in the agent editor, review the shared-conversation notice, and choose new instances only or new and existing instances. **Save new revision** commits the selection. Connecting alone does not grant an agent access.

Connections are reserved for one definition and use the configured provider authority. Participants, including later invitees, can receive connected content; teammates can edit the shared definition. MCP server/tool names and OAuth scopes are shown when available; a discovered tool list does not prove permission to perform every operation. Existing operator-managed connections remain on their definitions and are edited through their manifest.

**Discard** abandons staged definition changes. An unused connection remains in Settings. **Disconnect** disables future Dispatch access for all bound instances. For OAuth providers that advertise revocation, it also revokes the tokens; retry a pending revocation. Without that endpoint, or for pasted credentials, Dispatch removes its stored credentials and tells you to revoke them with the provider separately. Reauthorization keeps the scope ceiling; use a new connection to change endpoint, authentication method or permissions.

The editor's Files and commands capability selects native local coding tools for new instances and safe idle base upgrades of active instances. Newly selected MCP connections still require explicit existing-instance assignment. Switching between editor and Settings preserves the draft; reloading or ending the sign-in session does not.

## Chat and workspace

Messages use a compact, left-aligned flow with distinct participant avatars, author names, agent badges and timestamps. Hover a message or focus its actions to reveal Reply in thread and Copy; narrow and touch layouts keep these actions visible. An existing reply summary shows its participants, count, and last reply. Reply opens the thread beside its highlighted parent, or in a full-height phone panel. Replies remain visible to everyone in the conversation.

Conversations initially use the workspace with the context panel closed. Open participants from the header, then select a person or agent for details. Close the context panel to restore the conversation's width. The main composer names its conversation; each thread has a separate Reply to thread composer. Generic tool activity uses a readable summary and observed status; expand it for the original tool identifier, arguments, and results. Native command and file presentations remain available.

The message composer formats Markdown as you type or paste: headings, lists, quotes, bold/italic text, links, and code stay editable in place. Copying selected content retains its Markdown formatting. Paste inside a code block keeps the text literal. Desktop Enter sends; Shift+Enter inserts a line. Enter on a touch-primary device inserts a line; use Send to submit. The toolbar contains a lower-left + attachment menu. **October 10 update (published; authenticated integration unverified):** the lower-right arrow sends; while agents work with no local draft, it becomes a Stop square. Typing or adding an attachment switches it back to Send; clearing all draft content restores Stop if work continues. An unsendable draft keeps a disabled Send arrow, not Stop. Editor Enter never activates Stop. The Stop tooltip is “Stop all responses in this chat”, even in a thread. Sending a new draft does not implicitly cancel existing work. Pending Stop prevents repeated cancellation; failure preserves input and offers recovery. See [implementation evidence](handoff.md#single-composer-sendstop-action--october-10-2026). Main-message and individual reply-thread drafts stay with each open chat. Messages over 100,000 characters including formatting must be shortened before sending.

**Hosted hotfix candidate:** Send clears the submitted text immediately and shows a bounded **Sending…** preview above the main or thread composer, including attachment names. This is not confirmation that the message is saved. One send is allowed in flight per composer. Failures restore the submitted text unless you have typed a newer draft; uncertain failures retain the original retry identity. Pending state and drafts are browser-memory only, not preserved by reload. Deployment and focused UI evidence are tracked in [the hotfix handoff](handoff.md#hosted-request-path-hotfix--october-9-2026).

Use **+** to pick files/images, or paste an image into the message or reply composer. The top-left preview row shows image thumbnails or named files; remove a preview to leave it out of the message. Wait for uploads to finish before sending; a message may contain attachments without text. Limits are 10 files, 10 MiB per file and 25 MiB total per message. Main and thread drafts remain separate; they are not saved across reloads.

Image attachments appear uncropped inline; select the image or filename to open the original.

Validated UTF-8 attachments named `.patch` or `.diff` display expanded Pierre unified diffs in the message, including target-file headers. Use **Hide diff / Show diff** to collapse or reopen the preview and **Open patch** to open the immutable original in a separate tab. Preview size is limited to 256 KiB; malformed patches or loading/rendering failures show a fallback with the original link. These are read-only previews: file paths are display labels, not filesystem lookups or apply targets. Agents publish a patch with `conversation_attach`, then include the returned attachment ID in `conversation_post`; preparation alone is private. Published attachments and their previews remain available after reload.

**Uploading shares the file immediately with authorized conversation members, before Send.** Removing a preview does not delete the uploaded file; it remains a conversation asset. Verified PNG/JPEG/GIF/WebP images up to 4 MiB can reach agents as images (8 MiB total per delivery/history read). Larger originals remain previewable/downloadable, but require a smaller upload for agent use. Omitted images are identified explicitly; agents can retrieve total-budget omissions individually. These application limits do not guarantee provider acceptance, and validated UTF-8 files can be read through their attachment tool. Other files, including PDF/Office/binary formats, are download-only; upload does not mean an agent can interpret them. SVG is download-only, not displayed inline or exposed as agent-readable text.

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

### Agent project-chat context

**Published; local interactive acceptance passed.** Distributed PostgreSQL behavior remains runtime-unqualified; see [qualification scope](runtime.md#project-chat-qualification). Project-chat context uses two read-only native tools: `project_chats` discovers chats in the caller's current project; `project_chat_read` reads a selected chat's public context. The project is resolved server-side, not supplied by the agent. Archived chats remain discoverable. A chat without a project cannot use this as access to other unbound chats.

- `project_chats({ cursor?, limit? })`: paged metadata (`id`, `title`, `createdAt`, `updatedAt`, `url`); continue with returned `nextCursor`. Limit is 1–100. No Definition of Done or personal archive/pin flags in list results.
- `project_chat_read({ chatId, before?, threadId?, criteriaOffset?, includeActivity? })`: metadata, criteria, participant identities and a bounded public-history page. Continue with the returned history cursor; use `threadId` for a thread.
- Detail reads use `chatId` plus exactly one of `messageId`, `activityId` or `attachmentId`; do not combine detail selectors with `before`, `threadId`, `criteriaOffset` or `includeActivity`. `offset` is a nonnegative integer for detail continuation, not a history cursor. Message and UTF-8 attachment text return up to 12,000 characters with `nextOffset`; activity detail uses the paged activity format. Images up to 4 MiB are returned as native images; larger images and download-only formats return metadata with an explicit unreadable reason.
- Ordinary pages contain public messages, not native agent activity. Use `includeActivity: true` to discover activity IDs, then `activityId` for detail. These scans can inspect complete stored logs; bounded results do not imply bounded database work. Activity reads return stored activity; its last committed working state is not proof the source worker is currently running.
- Criteria return up to 12,000 characters with `offset`, `textLength` and `nextOffset`; continue with `criteriaOffset: nextOffset`. History uses the [paged presentation](#paged-chat-presentation) budgets and cursor recovery: preserve `before` unchanged; on `HISTORY_CHANGED`, reread the latest page rather than reusing the stale cursor.

List first, select a relevant chat, then retrieve bounded history/detail pages as needed. Cite the returned chat URL and stable message/thread references; a chat URL opens the chat, not a particular message. Another chat's messages and Definition of Done are historical context, not a new assignment or permission to resume its work. Private working transcripts and private attachments are excluded.

Reads do not join the source chat, notify its participants, change human read state, unarchive it or resume its agents. Each read rechecks project scope; an outside-project target and a missing chat produce the same not-found result. Unavailable history is an error, not evidence of an empty chat. Project-wide search and self-instruction editing are separate undelivered use cases.

### Chat Definition of Done

**Source-published in `89f9ff7`; runtime and rendered UI qualification pending.** Open **Participants** from the chat header (or **Details** on a phone). Under **Definition of Done**, choose **Set criteria** or **Edit criteria**, enter Markdown and choose **Save criteria**. To clear, remove the text and save. **Cancel** discards the edit after confirmation when changed. Drafts remain in browser memory while switching open tabs or responsive layouts, not across a reload. After any save error or conflicting edit, review the saved criteria using **Review latest; keep my draft** before saving again; a lost response may follow a successful save.

Optional shared Markdown criteria guide all chat participants; checklists are supported. Only authorized human participants can edit them. Clearing criteria leaves chat history intact. Criteria do not declare the chat complete, stop agents or authorize additional work. Agents receive the saved value on their next shared-context refresh; saving alone does not activate them.

#### Agent editing capability

**Source-published in `b400e4a`; runtime/rendered qualification pending.** In **Agents**, edit the definition, open **Capabilities**, select **Edit Definition of Done** and save a new revision. It is off by default. Existing instances adopt definition changes at their next safe idle boundary; an active instance's currently applied permission remains in effect until that adoption. Saving a definition is not evidence that a running instance has already upgraded.

Enabled active participants use `conversation_definition_of_done` in their current chat only:
- Read with `{}`; the result is `{ markdown, revision }`.
- Save with `{ markdown, expectedRevision, operationId }`, using the saved revision and a nonempty operation ID of at most 200 characters. Markdown is limited to 20,000 characters before trimming; empty text clears it.
- Retry identical edits with the **same** operation ID. A replay returns its original result, which may be older than current criteria; read again for current state. Changing the text or expected revision under that ID conflicts. After a stale-revision error, read and review before starting a new logical edit with a new ID.

Tool calls recheck active membership and the instance's applied capability, including receipt replay; Stop transitions block calls. This capability edits shared criteria, not authority, task completion or human approval. Agents without it still receive criteria through shared context.

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

**Navigation at `20f44b0` (October 11; [bounded qualification](#projects-navigation-qualification)):** the far-left rail orders **Projects → Agents → Chats**; **Settings** opens account/provider/tool settings near the bottom. Section links support opening a new tab. Projects and Chats retain their open views while switching sections; unsaved forms remain in memory, not durable storage. Explicit project, chat and section URLs choose the destination; without one, the app still opens Chats.

Within Chats, the main tab strip appears when multiple conversations are open. Close a view with the × on its tab, or focus the tab and press Delete. With one view open, the entire tab header is absent. Use New chat in the sidebar to open another conversation as a new tab, preserving the existing tabs. On narrow screens, open the sidebar with Menu in the bottom bar.

Above 1100 pixels, use the left rail’s conversations and details icons to hide or show either side. Drag either inner divider to resize it, or focus the divider and use Left/Right (Shift for larger steps) or Home/End. These choices last while the workspace is open; reloading restores the defaults. At narrow widths, Projects places **Menu** upper-left; other sections retain their bottom-bar Menu. **Details** opens the supporting panel. Project details start closed; project settings use the main area.

Hover or focus a conversation row to open its actions menu on the right. Touch layouts keep the menu button visible. The menu includes Rename, Move to project, Pin/Unpin, and Archive/Restore. Pinned conversations stay above the others within each group. Archive hides a conversation from the regular list without deleting it or stopping work; use Archived conversations at the bottom of the sidebar to reopen or restore it. Pin, archive and project choices are personal to your account, including when the conversation has other members.

Choose **Rename** from a conversation's actions menu (including archived and project lists), edit its current title, and select **Save name**. Titles are trimmed and must contain 1–200 characters. **Cancel** leaves the title unchanged; a failed save keeps your input and shows an error. Unlike pin, archive and project choices, the new title is shared with all members. It changes only Dispatch's display labels, not messages, agent context or tool directories.

### Projects

Open **Projects → New project**, enter a name, and select **Create project**. This creates an empty shared project with you as manager; see [Shared projects](#shared-projects) for access and defaults. Names can be reused and contain up to 100 characters. Unassigned chats appear under **Without a project**.

Use **Search projects** to filter the loaded list by name, then select a project in Projects to open its overview. In Chats, project folders still group conversations; their names link to Projects and the chevron expands/collapses the conversation group. Chat search finds project names and conversation titles. **New chat** in the project view opens the starting-agent chooser and keeps that project as the destination. The sidebar's **New chat** also uses the current project's context (including the project of the active chat); starting from an agent or the welcome view makes an unassigned chat.

Chats created in a project stay in that project. Moving existing chats into or out of projects is unsupported. Unassigned chats retain their explicit membership and history. Archiving keeps project binding; active counts exclude archived chats.

Project creation, overview, settings and spec viewing live only in Projects, not beside chat tabs. Legacy project/settings/spec URLs still open the project there. On phones, **Menu** offers the same destinations and the current section’s sidebar. New-project input remains available if a responsive layout change closes its popover; reopen New project to continue. Shared-project settings support name, membership and default-agent edits. Project descriptions, deletion UI, files and automatic context sharing remain outside this slice. Omarchy still uses its existing deployment until a later authorized update.

#### Projects navigation qualification

Claude's authenticated walkthrough at `20f44b0` (October 11) reported these results. Source review/builds are separate evidence; raw captures remain local.

| Walkthrough | Result and limit |
| --- | --- |
| Rail order; project management out of Chats; project-folder navigation | Verified in the reported walkthrough. |
| Legacy project/settings/spec URLs, chat and Agents links; switching between two open projects | Verified; only the active project was visible. |
| Unsent chat text across Projects → Agents → Chats | Verified; temporary input removed afterwards. |
| Project-page rendering at 1440×900, 1280×720, 768×1024 and 390×844 | Designer reviewed captures with no blocking visual findings; pixels alone do not qualify every control or scrolling path. |
| Corrected Menu at 390/768 px; choose Chats and dismiss | Interaction verified by Claude; Designer closed the visual finding on refreshed captures. |
| Unsaved project-settings edit across Projects → Agents → Chats → Projects; discard without saving | Verified. Native confirmation was accepted programmatically because the browser tool cannot click it; reload confirmed the persisted name was unchanged. |
| Cmd-click Projects from a chat with unsent text | Verified: Projects opened in a new browser tab; the original chat and draft stayed unchanged. |
| Close one of two project tabs, then switch to Chats | Verified: the remaining project stayed active; Chats showed no project page. The last tab has no close control because the strip hides with one view, matching Chats; last-tab closure is unavailable, not a tested success. |
| Spec-content draft retention across sections | Not checked at `20f44b0`: directory-backed viewing was unsupported. See [later local-file qualification](#local-spec-editing-qualification); no broader intent-editor acceptance inferred. |

This qualifies only the navigation/management slice. Official-spec storage is [database-owned Markdown](#shared-projects), with [separate qualification](#database-spec-qualification); activation and the default opening destination remain open. Spec-led automation and chat file editing are not delivered by this change.

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
| `DISPATCH_CONTAINER_LOOPBACK_HTTP` | `0` (default) or `1`; opt-in HTTP loopback-origin mode for a container published only on the desktop host's loopback address. Allows a non-loopback container-internal bind; does not allow non-loopback HTTP origins. |
| `DISPATCH_COMPANY_ID`, `DISPATCH_COMPANY_NAME` | Installation company identity/display name; defaults `dispatch` / `Dispatch` |
| `DISPATCH_PI_AGENT_DIR` | Pi credential/model/settings directory; defaults to `~/.pi/agent` |
| `DISPATCH_PROVIDER`, `DISPATCH_MODEL`, `DISPATCH_THINKING` | Explicit default-agent model settings |
| `DISPATCH_CLIENT_DIR` | Optional static-client location for a custom service launcher |

Use HTTPS for any non-loopback origin. Native HTTP configurations must bind to loopback. For a single desktop container, `DISPATCH_CONTAINER_LOOPBACK_HTTP=1` permits a non-loopback internal bind while retaining an HTTP loopback browser origin. The app cannot inspect the host's port publication; it emits a startup warning, and the operator must publish only on host loopback (for example `127.0.0.1:3001:3001`). This is not a network-serving mode. To serve other machines, use HTTPS with a matching `DISPATCH_ORIGIN`.

The root [Compose file](../../../compose.yaml) uses this opt-in and loopback-only publication, a named data volume, a read-only container filesystem and temporary `/tmp`. It requires `DISPATCH_IMAGE` for the chosen platform; use a verified registry digest when pulling, or the local tag from the checksum-verified [0.3.0 release archive](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.3.0). Both GHCR packages are public and anonymous digest pulls were verified. The controller reference is `ghcr.io/dispatchlabs-ai/dispatch:0.3.0@sha256:95d0ea8ac2ca38396329e32b5a11ab7a2eaf531ccfa8b1c2dff7041a01beee33`; set it as `DISPATCH_IMAGE` and run `docker compose pull` instead of loading/retagging the archive. The separate Ubuntu worker reference is `ghcr.io/dispatchlabs-ai/dispatch-worker:0.3.0@sha256:8b12bfafb652330caec396af8060aa6d00772c2e96f71b866a031ef54f5f36c2`; the desktop Compose file does not start it. Worker conversations and hosted AWS operation remain unverified for 0.3.0. The 0.3.0 controller archive records `dispatch-web:uncommitted`; retag it as described in the Windows quick start before configuring Compose. The isolated Windows 11/Ubuntu 24.04 WSL2 backend passed startup, virtual-WebAuthn enrollment/sign-in, model use and saved-state readback after an idle restart; see [0.3.0 Windows/WSL2 qualification](#030-windowswsl2-qualification) for browser location and limits. The earlier 0.2.0 `b8dda02` AMD64 controller has installation/startup and native Windows Edge login-page evidence on Ubuntu WSL2; account enrollment and model use remain unverified. With Docker Engine inside that WSL2 guest, keep `docker compose up` in a foreground terminal: detached startup alone did not keep WSL alive after its last shell exited. Docker Desktop's different lifecycle is not separately qualified. See the [Windows quick start](../../../README.md#windows-with-wsl2). Do not bind-mount your host home directory into an agent workspace. Keep persistent data when replacing the image; `docker compose down -v` deletes named volumes and is not an upgrade step.

Keep company identity and state together; changing the company ID does not migrate accounts or conversations. Custom origin/port settings must be shared by the service, frontend, and account CLI. Passkeys enrolled for localhost do not transfer to a different domain; arrange recovery/re-enrollment before changing the browser origin.

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

Apply references exactly the server-saved preview, not browser package content or a refetched commit. Preserve the request ID for retries. These routes do not make GitHub a live dependency of imported agents. md#github-bundle-imports-and-updates--october-8-2026).

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

Reuse the same `requestId` and contents for the same import; changed contents under the same operation conflict. Use a new ID only for a deliberate additional copy. Native receipts are actor/company-scoped. Transport base64 increases request size and is not encryption.

### Host-installed capabilities

Capabilities are distributed separately from agent bundles. Source-published `64298d7` includes private `@dispatch/pi-capabilities` JS/types for Pi Durable 1.0.4; it is not published to npm or automatically installed by import. Follow [the artifact README](../capabilities/README.md) for build/pack, provenance and approved-host integration. Explicit extension/tool selection and compatible host credentials/backend/environment remain required. Packaging checks alone do not verify installation, execution or restart; bounded independent-host observations are recorded in the [manual qualification evidence and limits](handoff.md#portability-manual-qualification--october-8-2026).

## Project historical archives

**Source-published, with subsequent browser fixes and bounded history/attachment, authorization and retry evidence.** See [manual qualification evidence and limits](handoff.md#portability-manual-qualification--october-8-2026). Separate from agent ZIP bundles and installation recovery. The data-only UTF-8 JSON format is `dispatch-project-content`, version `1`, containing project name, public chats/threads, historical authors and referenced attachment bytes as canonical base64 with size/SHA-256 checks. Limits: 32 MiB serialized archive, 10 MiB/file, 100 chats, 10,000 messages and 1,000 files total. No ZIP extraction or executable installation.

Export requires project-manager access, selects chat IDs and rechecks authorization/membership before return; missing referenced bytes fail rather than creating an incomplete archive. Inspect content and historical author labels before sharing. Import creates a new project with only the importing human as manager, no default agents, source memberships or private model state. History remains read-only, not resumed conversations or new submissions.

Open **Settings → Import & export → Choose file**. Choose or drop one `.json` project archive, then **Continue** to inspect counts/historical authors and **Review archived content**, then explicitly approve content/destination access and **Import as new project**. After an uncertain response use **Retry same import**; replacing the file asks before discarding the prior operation. Closing/reopening retains mounted state, not page reload.

In **Settings → Import & export → Select project**, choose a project you manage. The project’s **Export history** shortcut opens the same flow. Both let managers select current chats, acknowledge privacy and **Download history** (`project-history.json`, compact JSON). **Previously imported history is always included in full**, independently of current-chat selection; review it before sharing. **View imported history** shows the read-only archive. Attachment buttons download bytes as files, not inline executable content.

Authenticated candidate routes:

| Route | Request/result |
| --- | --- |
| `POST /api/projects/:id/export` | `{ chatIds: string[] }` → `{ archive }` (JSON object) |
| `POST /api/project-archives/preview` | `{ archive: string }` (serialized JSON) → `{ preview }` (counts/historical authors) |
| `POST /api/project-archives/import` | `{ archive: string, requestId: string }` → `{ project }` |
| `GET /api/projects/:id/history` | `{ archive }`, or null when no imported history; requires project read access |

Preview is a summary, not a durable reviewed-content token; import sends the archive again. Keep the same archive and request ID for uncertain retries: changed content with a reused ID conflicts. Replay still requires destination read access. Immutable restricted blobs are saved before atomic project/pointer/receipt admission; failed admission can leave non-visible orphan files. Back up the complete state/runtime directory, including project archive blobs. See [project portability evidence and limits](handoff.md#project-content-portability--october-8-2026).

## Offline installation recovery

**CLI source-published at `64298d7`; source-reviewed instructions, not verified recovery.** This is secret-bearing installation material, not a shareable project archive. SQLite only; PostgreSQL, symlinks/special files and overlapping roots are rejected. See [implementation evidence and limits](handoff.md#installation-backup-and-restore--october-8-2026).

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
| `GET/POST /api/projects` | List accessible shared projects / create an empty shared project with a request ID |
| `GET/POST /api/projects/:id/spec` | Read current/exact database Markdown / manager-only Save with `{ requestId, expectedRevision, content }`. See [spec API and recovery](#shared-projects). |
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
- Activity rows initially show a compact **agent-name** button with a disclosure arrow. Select it to load and expand the recorded activity on demand; opening it does not rerun the work. Empty live-only groups are omitted from the transcript; participant status remains separate. Counts and Activity/Working labels are not displayed. Current working/responding agents appear separately by name with a small animated indicator; Listening uses a static icon. Completion, failure and Stop remove the live indicator. Reduced-motion preferences suppress continuous animation. Failed detail loads stop loading and offer **Retry**; already loaded output remains visible during background refresh. This reduces initial loading/rendering, not access to stored history. `GET /api/chats/:id/detail/activity/:item` returns `{ items, before, total }`; optional nonnegative integer `before` pages older logical blocks. Calls/results are paired before paging; pages target at most 20 blocks / 256 KiB, and oversized blocks become a **Download** placeholder. **Older activity**, **Latest activity**, and **Download complete activity** are separate actions. `detail/message/:item` returns the complete public message; `?download=1` on either detail route downloads `chat-detail.json`. Complete detail/download responses are intentionally outside preview budgets. Keep downloads private when their content is sensitive.
- SSE starts with `snapshot`, then `delta`. Deltas contain `baseRevision`, current metadata in `snapshot`, changed `messages`/`activities`, and `removedMessages`/`removedActivities`; omitted `participants` means unchanged. Apply each delta only against the matching chat and last delivered stream revision, not a newer HTTP mutation response. Preserve native `timelineOrder` as the tie-break for equal timestamps; do not substitute lexicographic ID order. A missing reset or revision gap requires reopening GET/SSE. A new SSE connection starts fresh; no Last-Event-ID replay guarantee is introduced. Removal from the recent live window does not delete separately loaded historical pages or native history.

After a dependency-changing local update, refresh existing tabs if Vite reports mixed old/new dependency errors. Copy unsent drafts before refreshing: drafts remain memory-only, not reload-persistent.

All history/detail reads and stream delivery retain current session/company/chat authorization and public-content sanitization. Browser virtualization bounds mounted rows, not retained native history; ordinary browser find/copy can only see currently mounted content. The exact shared types are `src/shared/contracts.ts`, `src/shared/chat-updates.ts`, and `src/shared/activity-page.ts`.

The precise shared types are in `src/shared/contracts.ts` and `src/shared/auth-contracts.ts`. See [runtime.md](runtime.md) for native storage, cancellation, and request identity. The browser never sends an authoritative user or company ID for access checks.

## Dependency updates and later deployment

The runtime pins Pi Durable, Pi AI, Chord, Pi Coding Agent, and Pi MCP to 1.1.0. Keep these directly used packages aligned when upgrading so the application and native harness share compatible provider, document, and credential implementations. After installing an updated lockfile, restart the development launcher to load the new runtime; frontend hot reload alone does not replace the persistent backend.

Use exact versions in the owning manifest and commit the root dependency lock. To update `npmDepsHash` in `packages/web/nix/package.nix`, temporarily set `lib.fakeHash`, run `nix build`, replace the placeholder with the reported actual hash, then rebuild. Never commit a placeholder. Toolchain changes through `nix flake update` also require a build.

Installation-specific hosting, artifact pins and deployment evidence belong in the owning infrastructure repository; the [handoff](handoff.md#wp-043--isolated-palm-postgresql-trial) links the isolated Palm trial and its qualification limits. This does not establish deployment of the latest source. Loopback development cannot be opened directly from a phone; real-device access requires an authorized reachable environment. CI and automatic release publication are unconfigured; use the [lockstep SemVer workflow](../../../CONTRIBUTING.md#versioning-and-releases) for version/changelog preparation. Follow the [testing policy](../../../CONTRIBUTING.md#testing-policy) for permitted verification.

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

Select a project to search its chats by title or show only Active chats. Status and last activity come from the current chat summaries. The right-hand Project details panel lists members and default agents; use the project overview’s **Project settings** action for management. On phones, open Details in the bottom bar. Search and settings drafts remain available while switching views.

New project now creates an empty shared project with you as its manager. Project settings lets managers rename it, select default agents and add/remove members or managers. Keep at least one manager. Members can read every project conversation, including history from before they joined, and participate. Removing membership denies later requests and snapshot delivery; previously delivered information cannot be recalled. Already admitted agent work is not canceled.

**Project spec authority:** official intent is versioned Markdown stored only in Dispatch's database with project data. No repository file, directory or path is needed for authoring; there is no live file synchronization or second editable master. Projects tends intent; Chats retains execution details/questions and working-copy file editing. Save persists content, not adoption or agent work. Broader activation policy remains unresolved in the authoritative project document.

**Write or edit:** open **Projects → project → Write spec** for a first spec, or **Edit spec** for existing Markdown. **View spec** opens the same Spec destination read-only. Choose **Source**, edit, and **Save** → see **Saved · Revision N** and recover that revision after reload. Managers edit; readers inspect. **Preview** renders the current draft. Save retains the selected view, caret and Undo; drafts are browser-memory input, not durable unsaved recovery. Copy important unsaved text before closing or refreshing.

**Conflict/access recovery:** an error keeps the draft and blocks stale Save. Use **Copy draft**, then **Reload spec** and reconcile against current content. Reload confirms discarding changes and replaces input only after a successful read. Failed clipboard access leaves source selectable. **Discard** restores the loaded revision, not current head. A newer-revision notice distinguishes the editor's revision from the latest project state; reload explicitly rather than silently rebasing.

**Unconfirmed Save:** the server may already have committed. **Retry save** repeats the original request ID, expected spec revision and exact content. A valid receipt returns the originally saved revision/time—even if a later revision exists—not a new write or newer text attributed to the first operation. An uncertain import similarly offers **Retry import**. Do not change/reuse an operation ID with different content or silently substitute refreshed versions. Permission is rechecked on replay. Save does not write files, change settings, commit/push or launch agents.

**Legacy import:** an existing file reference produces a review/import state, not an empty first-spec editor. Review **Preview / Source → Import spec** → create database revision 1 with provenance and retire the active reference in the same transaction. The reviewed source version/digest and project revision bind the operation; unrelated repositories, working directory, membership and defaults remain unchanged. Missing/unavailable/changed sources require recovery, not an empty import. The source file is not modified; after import it is no longer consulted as live intent. Legacy settings requests cannot clear database Markdown or reinstate file authority. This is migration support, not normal file-path setup.

**Workspace configuration remains separate:** Project settings → **Add repository** accepts credential-free HTTPS repository URLs and editable display names; names are not checkout folders. Multiple repositories are supported and duplicate normalized URLs are rejected. Review auto-filled names before Save. **Save project** persists settings, not Markdown, cloning, repository-access verification or agent launch. Settings conflicts require reopening/reviewing current settings. The working directory is described below. Project-content archive operations are separate from the spec-authoring API and must not be assumed to export/import this database document.

**Agents:** `conversation_project_spec` reads the current chat's project through current membership; it cannot select another project. Omit revision to obtain current, then continue using the returned revision and nextOffset as offset until nextOffset is null. Passing a saved revision reads it exactly; do not mix pages across heads or assume the first page is complete. Revision 0 / initialized false means no saved document; legacyImportRequired indicates migration, not approval to replace old intent with empty text. Reading a spec grants no authority to adopt it, expand scope or execute its backlog. Hosted workers use backend mediation, not a disk copy; interactive hosted coverage remains separate from source review.

**Spec API:**

- `GET /api/projects/:id/spec` → `{ spec }`; optional `?revision=N` reads an exact saved revision. No saved document is revision 0.
- `POST` the same route with `{ requestId, expectedRevision, content }` → `{ spec }`, manager-only. Spec revisions are independent of settings revisions. Reuse the identical request after an uncertain response; changed reuse/stale new saves return conflicts. Responses identify the saved revision/content hash and available import provenance.
- `GET /api/projects/:id/spec/legacy` returns the reviewed configured source for migration only.
- `POST /api/projects/:id/spec/import` with `{ requestId, expectedProjectRevision, sourceVersion, contentHash }`. Use the reviewed project revision and version/commit; contentHash is SHA-256 of reviewed UTF-8 text. Do not silently substitute current values during retry.
- Markdown must be valid UTF-8, contain no NUL and be at most 512 KiB. Save creates immutable revisions and actor/company-scoped receipts with current mutation permission checks.

#### Database spec qualification

October 11 candidate checks cover `f346543` / `e4dd806`, with imported-response repair at `588d908` and integrated code/changelog at `820f94b`. TypeScript/application/capability and Apple Silicon Nix build/flake checks passed again after the repair. Designer reviewed four-size entry/recovery layouts, including genuine unconfirmed-save recovery; this did not qualify Preview/Source width consistency. Claude also verified reads in newly created chats for Dispatch Web and a disposable project. The database-spec slice was published through `18706d7`; this is not hosted deployment acceptance. Source/build checks are separate from browser evidence; no automated tests ran. Raw screenshots and ledgers remain local.

| Walkthrough/boundary | Reported coverage |
| --- | --- |
| Empty project → Write spec → Save → reload | Claude verified on disposable content: no path setup, revision 1 persisted, direct Edit/View links appeared. |
| Save → continuing typing / Undo | Claude verified retained caret and Undo on disposable content. |
| Another save wins → conflict | Claude verified stale Save blocked, draft retained, Copy draft/Reload offered and newer content preserved. |
| Successful Save with injected acknowledgment failure → Retry save | Claude verified original revision/time returned without duplicate revision. Fault injection is not a real outage or every newer-head retry scenario. |
| Authorized Dispatch Web import | Revision 1 exactly matches the held `04d0bfc` Markdown; reference retired atomically. Pi's independent read-only comparison confirmed unrelated settings unchanged. No content Save on the real project. |
| Imported document → current/exact HTTP read → Edit/Discard | Initial HTTP 500 exposed escaped transaction-owned provenance. At `588d908`, Claude confirmed both reads and the real editor; discarded without saving. Source re-review by Pi/Deslop passed; no re-import/data change. |
| Existing-chat native agent read | Documenter read all 15,970 characters in revision-1 pages at offsets 0/12000, same source digest, final nextOffset null. Claude/Pi also reported matching reads. |
| Brand-new native project chat | Claude verified chat 204728 returned Dispatch Web revision 1 and the imported digest; chat 204575 returned the disposable project's own revision 12. Neither changed spec/settings. Existing-chat pagination remains separately verified. |
| Hosted worker interaction, access loss | Hosted mediation/current access checks source-reviewed, not interactively qualified here. |
| Responsive entry/editor/recovery | Designer completed entry/editor, conflict and actual unconfirmed-save visual review at 1440, 1280, 768 and 390 px, plus migrated Dispatch Web captures; no blocking clipping/overlap. At 390 px, Retry save wraps and remains visible. These image checks do not replace Claude’s separately reported interactions or human design acceptance. Chris subsequently rejected the narrower Preview; the original review missed Preview/Source width consistency. |
| Preview ↔ Source uses available panel width | Correction `e3a5ac5`: Claude measured equal panel/Preview/Source widths at 1440 (1032 px) and 390 (358 px), with no page-level horizontal overflow. Read-only switches left the imported revision unchanged. Other widths were not remeasured for this correction. |

This qualifies neither spec-led automation nor chat working-copy editing. Save does not acquire new execution authority. Data migration, application publication and walkthrough acceptance are distinct.

#### Local spec editing qualification

**Superseded historical coverage:** `cfe4aab` supported editing an existing designated local file, not first-spec authoring. Claude verified Save/reload, file/reference conflicts, caret/Undo, uncertain no-write confirmation, Discard recovery and path boundaries; Designer reviewed four sizes. Mid-edit access revocation and listed failure cases were not browser-qualified. That file-write implementation is removed by database ownership. See the [historical qualification](https://github.com/dispatchlabs-ai/dispatch/blob/0378f39/packages/web/docs/usage-guide.md#local-spec-editing-qualification); do not apply its file-version/equality retry rules to database revision receipts.

**Project working directory (source-published October 8; type/build checks passed, runtime/rendered qualification pending):** managers can set **Working directory** in Project settings to an absolute existing directory on the executing service host. This is not a path on the browser computer. Worker-hosted instances use their worker workspace rather than this project override. Leave it blank to use `DISPATCH_WORKSPACE_DIR`. Saving affects new agent instances, including later invitations, not existing instances or their resumed work. The setting does not clone repositories, move files or isolate filesystem access; use explicit Git worktrees and coordinate shared-checkout edits. Missing directories fail at execution rather than being recreated. Project-content exports omit this host-local setting; configure it separately after import.

**Implemented October 8; browser behavior and rendered UI remain unverified (see [WP-053](handoff.md#wp-053--project-row-chat-creation-and-shared-only-projects)):** the compose icon on a shared-project sidebar row starts a fresh chat in that project with its default agents and focuses the message box, without a setup dialog. Its tooltip is **New chat in [project name]**. Existing tabs/drafts stay intact; the new chat does not inherit another chat's history. The action requires project participation, not read-only access.

For custom setup, **New chat** opens the chooser. Default agents are preselected when starting a chat in the project; adjust the selection before creating it, including selecting none for a people-only conversation. Existing conversations keep their own participants and configuration. Add human access through project settings, not the conversation invitation picker. Default agents are not an allowed-agent restriction.

**Shared-only decision, October 8:** personal groupings are no longer a supported product workflow; their obsolete API/UI paths have been removed. Shared projects cannot receive existing chats or move their chats to another audience in this slice. Removing personal-group support does not automatically expand chat access.

Operators can set `DISPATCH_READ_ALL_PROJECT_USER_IDS` to comma-separated stable user IDs from the company's authenticated people directory. The default is empty. These users can read all shared projects in their company but cannot participate or manage settings without explicit membership. The grant excludes standalone conversations and legacy personal groupings. Changing it requires a backend restart. No grant for Ben or another person is inferred from a display name or provisioned by this release.

API: `POST /api/projects` with `{requestId,name,kind:"shared"}`; `POST /api/projects/:id` with `{requestId,expectedRevision,name,members:[{userId,role}],defaultAgentDefinitionIds,cwd?:string|null}`. `cwd` omission preserves the saved directory; blank/null clears the project override. An omitted `repositories` field preserves the list; a submitted array replaces it. Legacy `spec` input is migration compatibility only: it cannot clear database Markdown or reinstate a file master after import. A new save requires the current `expectedRevision`; stale revisions return 409. `GET /api/projects` returns shared projects and current participation/management flags. Creation requires `kind: "shared"`; omitted/other kinds are rejected. `POST /api/chats` uses `sharedProjectId` for the project audience. Obsolete `projectId` input (including null) is rejected by chat creation and preference updates, not reinterpreted. Preferences accept pin/archive changes only. Historical request fingerprints are preserved; this is not a native-history purge. Omitted agent selections resolve project defaults; explicit selections override them. Retries retain the original request object. Project-save replay still requires current manager access and returns current state; losing your own access can therefore prevent replay even when the original save committed.

The UI refreshes project/conversation lists periodically and on return to the page; active stream denial clears its displayed snapshot. This is not a mechanism for erasing content already received. Broad coding tools, company-shared definitions and connections remain separate confidentiality boundaries: do not treat project permissions alone as protection for restricted files or credentials. Multi-user authorization and device behavior still require functional qualification before a restricted-data rollout.


### Image generation

**Subscription image routing implemented; authenticated generation remains unverified.** Enable **Image generation** in an agent's Capabilities and save a new revision. Assign the seeded **Image generation** skill separately for prompting guidance. Active participants adopt these selections at the next safe idle boundary, preserving history and instance instructions. Files and commands is not required for generation itself; a writable configured workspace is required.

In the updated build, connect **Codex images** through **Settings → Model providers** for subscription images. This is a separate Codex OAuth grant: keep the existing OpenAI chat connection unchanged and do not copy Codex CLI credentials. The newer [Sign in with ChatGPT direct-use grant excludes image generation](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md); signing in again to that chat connection does not enable images. [Codex's built-in image generation](https://learn.chatgpt.com/docs/image-generation) counts toward general Codex usage limits.

`generate_image` accepts `provider: "openai-codex"` for Codex subscription images (default model `gpt-image-2`) or `provider: "openai"` for the separately billed OpenAI Images API (default `gpt-image-2.5-sunburst`). Without an explicit provider, it prefers a configured Codex connection; otherwise OpenAI requires API-key authentication. Provider failure does not trigger a request through another route. Codex generation and reference-image edits use JSON requests; masks and `input_fidelity` are rejected before submission. The API-key route retains its supported mask and legacy fidelity options described below. Hosted Codex [credential authorization](runtime.md#image-credentials) is source-reviewed; hosted execution remains unverified.

Local qualification on October 12, 2026: source reviews, TypeScript/build, Apple Silicon Nix build and flake checks passed. A manually driven synthetic-provider console observed Codex generation/edit routing, account headers, API-key mask/fidelity transport, rejection of the chat OAuth grant and unsupported Codex controls, and no fallback after a provider refusal. The isolated provider UI showed the new connection and native sign-in-method prompt on desktop and a 390 px phone layout; sign-in was cancelled before authorization. These observations do not establish token acceptance, real generation or hosted execution.

References leave the workspace for provider processing. The tool returns generated pixels for inspection; outputs and run metadata remain workspace files. No gallery, automatic conversation attachment or cleanup job is added. Metadata may contain private prompts and reference paths, so protect storage and backups. The repository ignores its root `imagegen/` directory; this prevents accidental commits, not access or publication. Share intentional outputs through the attachment workflow.

Generation consumes subscription usage or incurs API charges; the tool does not return or estimate them. There is no automatic retry. After interruption, inspect the existing run record and outputs before deciding whether to request another generation. An incomplete record or locally cancelled request does not prove the provider stopped or avoided usage/charges. Rewind does not delete outputs or reverse charges. Skill guidance is not a permission grant or a guaranteed workflow.

### Sharing generated files from agents

After generating a file, an agent calls `conversation_attach` with its workspace-relative path. This snapshots the file privately and returns an attachment ID. The agent then includes that ID in `conversation_post`'s `attachmentIds`. Preparation alone does not share the file; it becomes readable by conversation members only when the post is admitted. The same workflow supports ordinary generated files as well as images, using the existing 10 MiB per-file, 25 MiB per-message and 10-file limits.

Do not paste base64 into messages or treat workspace paths as browser links. A stopped or discarded draft leaves its prepared files private. Retained prepared/orphan blobs may consume storage; no automatic cleanup is promised. On the API-key route, the tool omits `input_fidelity` for generation and GPT Image 2/2.5 edits. It forwards an explicitly supplied value only for supported legacy edit models. Provider rejections identify a safe parameter name when available. For localized API-key edits, supply a PNG alpha mask matching the first reference: transparent pixels mark the edit region. Inspect output pixels and text before publishing; neither a prompt nor a mask proves unchanged regions are pixel-identical. A revised shared skill must be explicitly selected and saved on an agent definition; active conversation instances adopt that selection at the next safe idle base upgrade.

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

### Named agent secrets

**Source-published through `611adf6`, October 9:** type/build and focused local storage/UI/Git fixture checks passed. An AWS consumer deployed October 10 with bounded HTTPS/readiness evidence; hard-refresh an updated installation before use. Hosted secret workflows and real private cloning remain unverified (the latter credential-blocked). See [acceptance status](handoff.md#named-agent-secrets--october-9-2026).

1. In **Settings → Secrets → Named secrets**, enter **Name** and **Value**, then **Create secret**. Saved values are write-only. **Edit → Replace value → Save secret** rotates the value; leave blank to preserve it. **Delete** removes the secret and all grants. On a revision conflict, **Reload** before retrying.
2. In **Agent screen → Secrets**, check/uncheck your owned secrets to grant/revoke access immediately, independently of the agent editor’s Save/Cancel. One secret can serve multiple named agents and their current/future instances. Copies/imports do not inherit grants. Enable **Files and commands** separately for the Git tools.
3. For private GitHub cloning, use a fine-grained token restricted to the intended repositories with Contents read access. Ask the agent to use `secrets_list` for granted IDs/names, then `git_clone` with `secretId`, `repository` (GitHub HTTPS URL) and `destination` (a new workspace-relative directory whose parent exists). Never paste the token into chat, clone URLs or shell arguments. Git errors are suppressed; check permissions/URL/grant and inspect partial destinations before retrying.

Replacement/revocation affects later uses, not credentials already disclosed; rotate those at GitHub if necessary. No environment injection or plaintext retrieval tool is provided. Grants are not isolation between agents sharing a worker. This tool clones only—not authenticated fetch/push, submodules or persistent storage. Worker replacement may lose the checkout. Hosted workers require HTTPS backend transport for secret use. Exa settings remain separate.

### Exa search credentials

Open **Settings → Secrets**. Choose encrypted storage and enter an Exa API key, or select the server's fixed `EXA_API_KEY` environment source. Select the agent definitions allowed to use it, then save. Enable **Web search** on those agents separately; the grant does not enable either capability. Environment-only installations now need this explicit assignment; an unset grant never inherits the server key.

Only the saving user manages their credential. Grants cover the definition's existing and future instances and conversation audiences. Replacing a stored key takes effect on subsequent search calls without restarting agents. Changing the process environment still requires relaunching the server. “Configured” is not provider verification. A conflict means another tab changed these settings; reload before saving again.

Disconnect removes local access for every assigned agent, without falling back to another credential. Revoke the API key at Exa separately if needed. Already-running requests and saved search results remain. Direct URL reading does not need an Exa key. Back up `connections.sqlite` and `connections.key` together using the existing connection-store backup procedure. Codex configuration and arbitrary vault commands are not imported automatically.
