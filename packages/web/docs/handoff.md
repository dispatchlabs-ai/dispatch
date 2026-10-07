# Dispatch Web implementation handoff

The local implementation covers company authentication, stock Pi Durable chat, the branded desktop/mobile workspace, and named agent definitions. [spec.md](spec.md) defines the current contracts; [usage-guide.md](usage-guide.md) explains operation. The [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/) maintains product intent and decision history. Shared conversations are implemented locally in [WP-024](#wp-024--shared-conversations); [WP-026](#wp-026--listen-before-responding) adds listening and speaking turns. Functional qualification remains deferred.

## Current testing policy

Chris requested **zero tests during this stage**, then clarified that future coverage should focus on end-to-end and API tests once useful behavior is stable enough to lock in. Follow the [testing policy](spec.md#testing-policy). Do not add or run tests, smoke checks, or browser acceptance procedures now. Source review, TypeScript checks, and builds are permitted. The acceptance outcomes below define intended behavior; they are not permission to start test work.

No test suites or test frameworks are retained. Functional, security-flow, recovery, and real-device qualification of the integrated revision remains deferred. Successful type/build checks do not establish those outcomes. Earlier WP-001 evidence is historical.

## UI/UX review follow-up

Chris requested an independent Claude review after the integrated build. The [October 3 review](ui-ux-review.md) combines source inspection with 13 authenticated desktop and 390×844 phone screenshots. This specifically authorized visual review does not qualify keyboard, touch, authentication, recovery, or streaming flows and does not lift the zero-tests policy.

The original review recorded deviations in readability/contrast, shared design tokens, truthful connection status, and account-form state preservation, plus additional navigation, tab visibility, defaults, and content-hierarchy gaps. The subsequent [WP-006](#wp-006--resolve-the-uiux-review-findings) implements the accepted fixes; the review document preserves the historical findings and their resolution status. Apply the accepted [UI implementation rules](spec.md#ui-implementation-rules) to subsequent UI work; session-expiry draft retention and in-place identity re-checks remain proposed decisions. Screenshots stay in the canonical checkout's ignored `.local/ui-ux-review/2026-10-03/` directory.

## October 7, 2026 — Background development and backend reload

Chris requested that the local development instance run in the background and reload the backend when needed. `scripts/dev.ts` uses Node's native dependency watcher for the service, retaining Vite's independent frontend hot reload. Node sends SIGTERM and awaits process exit before replacement; the existing shutdown closes Pi, MCP connections and authentication resources and releases runtime ownership. No application recovery engine, process limit or machine startup service is added. The [usage guide](usage-guide.md#background-development) records detached start, logs and graceful stop commands.

Acceptance: frontend-only edits do not restart Pi; edits to loaded backend dependencies restart only the backend; previous ownership is released before replacement; the launcher can remain detached from the terminal and can stop both children. Source/deslop review and TypeScript/application/Nix checks are required. Startup/process observations will be recorded separately from automatic-reload and in-flight recovery qualification; no tests are added or run under the current policy.

Evidence: source/deslop review confirmed that backend imports exclude frontend components, Node 24.21.0's watcher awaits the prior child's exit, and the service uses its existing graceful shutdown. `nix develop --command npm run check`, `nix build --no-link`, and `nix flake check` passed on Apple Silicon. The existing Vite chunk-size advisory remains; Linux was not built. Diff/whitespace review, 74 local file links and the new documentation anchor passed. Automatic reload, shutdown during active tool work and native recovery were not exercised; build/source checks do not qualify them.

## Decisions and ownership

- Use TypeScript, React Router framework SPA mode, React/Vite/Tailwind, and shared Base UI primitives with original Dispatch artwork and local Inter.
- Keep a persistent Node/Hono service separate from frontend hot reload. One process owns each Pi directory, enforced by an OS-backed SQLite ownership lock without limiting concurrent agents.
- Use stock Pi Durable 1.0.4 through its public interfaces. Pi owns admission, native entries, execution, cancellation, and recovery. Dispatch owns identity, access checks, transport, and presentation.
- Serve one company per installation. Users have equal capabilities, invite-only conversations, private projects, and shared agent definitions. Role-based access control remains future work.
- Require password/TOTP or a user-verified passkey, with restricted invitation/recovery flows and opaque sessions. The local operator provisions accounts; there is no application administrator role.
- Keep desktop rail/sidebar/main tabs/full contextual column/bottom bar. Mobile uses navigation and context panels, preserving active work and drafts.
- Prefer explicit service model configuration, then existing Pi settings/credentials. The first agent has no tools. Named agent revisions are immutable and copied into new chats.
- Prioritize local development. Omarchy deployment, pilot retirement, additional tools/integrations beyond Developer, handoffs, background triggers, and schedules are deferred to separately specified packages.

## Coordinated work

Chris's October 3 instruction to implement the discussed work authorizes the coordinator to complete these packages, using isolated subagent worktrees as useful. It supersedes the earlier stop-for-review between packages for this request. Source/type/build review follows the current testing policy.

### WP-002 — Company authentication

Implementation: `server/auth.ts`, the `server/auth/` helpers, account CLI, shared auth contracts, and browser authentication/account components.

Intended outcomes:

- Invitation enrollment, password/TOTP and verified passkey sign-in, and account security work through the same service boundary.
- Missing, partial, expired, revoked, or invalid authentication cannot read protected data or subscribe to it. WebAuthn requires server-verified user verification; challenges and TOTP counters cannot be replayed.
- Recovery grants restricted factor enrollment before application access. Operator reset suspends old factors and sessions. Credentials, recovery material, and mutable state stay outside source/build outputs.
- Users can manage factors after recent authentication and revoke sessions; deleting the last complete sign-in method is rejected.

Source review covers asynchronous verification/flow cancellation, atomic challenge/counter consumption, cookie/session policy, and company/user boundaries. Browser/authenticator qualification is deferred.

### WP-003 — Durable chat service

Implementation: `server/runtime.ts`, storage ownership, API/SSE adapter, shared native snapshot contracts, and provider credential integration. [runtime.md](runtime.md) explains native ownership and request identity.

Intended outcomes:

- Independent private conversations support sending, streaming, Stop, and saved history without flattening native Pi records.
- Browser disconnect and main-tab closure stop observation only; reconnect replaces state with the current native snapshot. Session invalidation closes access.
- Repeated logical requests keep their IDs. Matching retries reuse native admission; changed payloads with the same ID return 409. Stop/failure stay distinct, including before the first token and when follow-ups are queued.
- Service reopening installs the registry and calls Pi recovery. Interrupted provider work can be retried from its committed checkpoint. A second process cannot own the same directory.

Source review covers native API usage, subscriber backpressure and cleanup, failure summaries, request fingerprints, and lifecycle ownership. Final runtime/recovery/API qualification is deferred.

### WP-004 — Branded desktop/mobile workspace

Implementation: shared browser controls, official SVG assets/tokens, authentication screens, chat/native entry rendering, workspace tabs/context, and responsive CSS.

Intended outcomes:

- Desktop follows the supplied sketch with a full contextual column. Narrow screens retain every workflow through accessible navigation/context panels.
- Main-tab changes immediately change contextual content/action targets. Late results for an inactive chat cannot replace the active context; closing tabs chooses or clears the remaining context.
- Drafts and pending logical request IDs remain tied to their chat during layout/tab changes. Markdown, native entries, loading, failure, Stop, and connection states render meaningfully.
- Logos keep their original proportions and correct background variants, with readable colors, visible focus, and local Inter.

Source review covers component/state ownership and CSS structure. No browser, touch, keyboard, zoom, virtual-keyboard, or passkey-device acceptance runs are authorized now.

### WP-005 — Named agents and integration

Implementation: company catalog/editor/archive, immutable revisions, startup/configuration scripts, locked dependencies, Nix client/service output, and operator docs.

Intended outcomes:

- Company users create/edit named agents, choose provider/model and supported thinking level, and start independent conversations from them.
- Stale revision edits return conflicts; archived definitions reject editing/new chats. Existing conversations keep their original configuration. The default definition is service-configured and read-only.
- Root development, built-app, and account commands use the same default company, state, and browser origin. Nix output contains no credentials or writable state.
- The integrated revision is source-reviewed, passes TypeScript/build checks, and is committed/pushed with maintained docs and wiki evidence.

### WP-006 — Resolve the UI/UX review findings

Chris authorized coordinated subagent fixes on October 3 after the independent review. Scope covers the accepted UI implementation rules and actionable review findings; proposed session-expiry draft retention and in-place identity re-checks remain separate product/security decisions.

Use token-based CSS for component styling, with shared native-control styles and Base UI interaction primitives. Tailwind remains available to the existing build, but feature components do not mix utility styling with this convention. Preserve the original Dispatch artwork and the brand palette; annotate darker accessible semantic colours beside their tokens.

Acceptance criteria:

- Text uses the shared type scale in `rem`, at least 12 px at the default root size. Source colour pairs meet the spec's contrast requirements; focus, selection, errors, and current navigation remain distinguishable. Controls share styling and primary phone targets reach 44×44 CSS px.
- The active main tab stays visible with discoverable overflow. Keyboard focus does not activate a chat. Closing tabs is keyboard-accessible and warns before discarding unsaved form/chat input. Main-tab and layout changes preserve form state and transcript position.
- Connection labels describe observations accurately and connection problems appear within chat content. Native transcript/setup/tool records retain their distinctions behind human-readable labels and appropriate details disclosures.
- Conversations retain their saved agent name after later definition changes. Main destinations have meaningful headings, and contextual columns use a consistent header and explicit empty states.
- Known-invalid factor removal is unavailable with an explanation. Enrollment originally captured a recognizable passkey label; WP-022 supersedes that requirement. New agent drafts use the service default model and thinking level.
- Review the rendered integrated desktop and 390 px phone UI. Record source/type/build evidence separately from unverified keyboard, touch, recovery, and authentication flows; no tests or acceptance suite are authorized by this package.

Implementation source is committed at `1e20c65`. Focused subagents implemented shared styles, workspace/chat presentation, and account/agent forms in separate worktrees; the coordinator integrated immutable agent names and guarded draft settlement by request identity and edit version. The behavior-preserving deslop review removed obsolete CSS overrides and utility mixing, retained native Pi execution/state ownership, and formatted the affected JSX for review. A second source review found no remaining actionable issue in the delayed-response fix.

Evidence on October 3, 2026:

- Integrated `npm run check` passed frontend/service/tooling TypeScript and production client/service builds. `nix build` and `nix flake check` passed on Apple Silicon (`l32bj125lbqgbc4vhhfiifndabkr5psz-dispatch-web-0.1.0.drv`); Linux remains unbuilt.
- Source colour arithmetic gives a minimum 5.22:1 for body/muted/status text across the defined pale surfaces, 3.99:1 for focus, and 3.42:1 for control borders. These are source-palette calculations, not a device accessibility audit.
- The coordinator and visual subagent reviewed six authenticated 390×844 phone captures, two 1000×900 intermediate captures, and a 1440×1000 desktop Run & usage capture. Readable text, labeled phone actions, visible selection, consistent contextual headers, correct new-agent defaults, and the last-factor explanation were observed. Captures are in the canonical checkout's ignored `.local/ui-ux-fixes/2026-10-03/`; the oversized `chat-desktop.jpg` capture is excluded from evidence.
- No tests, API smoke checks, or browser acceptance suite ran. Keyboard/focus sequences, touch, virtual keyboard, long-transcript scrolling, dirty-form confirmation, delayed network settlement, enrollment/authenticator flows, and recovery remain unqualified by execution. Source changes implement their accepted rules, but still images do not prove them.

The [historical review's resolution summary](ui-ux-review.md#resolution--october-3-2026) separates implemented fixes from proposals and optional preferences.

## WP-007 — Main tab controls

**Accepted October 3, 2026:** Chris requested the close × on its own tab and no visible main tab when only one view is open. This supersedes WP-006’s detached current-tab close control.

Acceptance criteria:

- Multiple open views show individual close buttons within each closable tab. Delete retains the existing keyboard close action without adding a keyboard Tab stop for each close button.
- One open view hides the main tab strip, including the extra phone row. New chat, navigation, contextual actions, and the active content remain available.
- Revealing an active tab includes its close button. Closing down to one view retains mounted content and returns focus to the workspace; unsaved-input confirmation remains in force.
- Apply source/diff review and the behavior-preserving deslop procedure, then TypeScript and production/Nix builds. No tests are authorized; keyboard and dirty-form interaction outcomes remain unverified.

October 3 evidence: source/diff and deslop review, `npm run check`, `nix build`, and `nix flake check` passed on Apple Silicon. The close control is a sibling of its tab button, avoiding nested interactive elements, and the single-view transition retains the existing panel instance. No tests ran.

## WP-008 — Conversation message alignment

**Accepted October 3, 2026:** after the tab refinement, Chris requested the familiar chat layout with the user on the right and the assistant on the left.

Acceptance criteria:

- User bubbles fit their content up to 85% of the transcript width and align right on desktop and mobile. Their label, timestamp, and copy action follow that alignment; message text stays left-aligned and wraps.
- Assistant responses stay left-aligned. Preserve chronological DOM order, role labels, native records, streaming, copy behavior, and draft state.
- Review the focused CSS change and rendered layout, then run TypeScript and production/Nix builds. No tests are authorized; broader chat interaction and device qualification remain deferred.

October 3 evidence: the focused CSS/deslop review, `npm run check`, `nix build`, and `nix flake check` passed on Apple Silicon. This changes no message rendering logic or durable state. No tests ran.

## WP-009 — Hideable, resizable desktop columns

**Accepted October 3, 2026:** Chris requested independent hiding and resizing for the left sidebar and right contextual column, at least on desktop. This supersedes the earlier exclusion of column resizing.

Acceptance criteria:

- Above 1100 CSS pixels, toolbar toggles hide and reopen each side independently. A hidden side takes no layout width, and the main content expands into the space.
- Drag the sidebar’s right edge or the contextual column’s left edge to resize. Focusable separators expose their controlled region, orientation, and current/minimum/maximum widths. Arrow keys resize by 16 px, Shift by 48 px, and Home/End select bounds.
- Sidebar widths range from 200 px to the smaller of 420 px or 25% of viewport width. Details range from 240 px to the smaller of 480 px or 30%; responsive bounds preserve main-content space. Desktop choices survive tab changes and temporary narrow layouts in memory.
- Preserve mounted views, drafts, scroll ownership, and contextual selection. Narrow layouts keep navigation and Details panels; persistent preferences across reloads are not included.
- Apply source/diff/deslop review, TypeScript and production/Nix builds, and rendered-layout review. No tests or broader browser acceptance suite are authorized.

October 3 evidence: source/diff/deslop review, `npm run check`, `nix build`, and `nix flake check` passed on Apple Silicon. Resize uses pointer capture and shared bounded width updates for pointer and keyboard input. Hiding changes layout styles without unmounting the columns. No tests ran; real-device and broader interaction qualification remain deferred.

## WP-010 — Tab-only header and sidebar chat creation

**Accepted October 3, 2026:** Chris clarified that the whole main header row must disappear with a single view, and that New chat belongs in the sidebar, opening new chat tabs. This supersedes the retained single-view toolbar in WP-007 and moves WP-009’s column toggles to the left navigation rail.

Acceptance criteria:

- Render the main header only for multiple open views. It contains tabs, their close controls, and overflow navigation; there is no New chat control there.
- The sidebar’s New chat creates and activates a new conversation tab without closing existing work. The existing creation/retry path remains unchanged.
- Desktop hide/show controls stay available in the left rail. Narrow layouts expose Menu and Details in the bottom bar, preserving sidebar access without an empty top row.
- Source/diff/deslop review, TypeScript and production/Nix builds, and rendered-layout review apply. No tests or broader acceptance suite are authorized.

October 3 evidence: source/diff/deslop review, `npm run check`, `nix build`, and `nix flake check` passed on Apple Silicon. Source review confirms creation appends a distinct conversation tab and preserves existing non-welcome tabs. No tests ran.

## WP-011 — Sidebar conversation actions

**Accepted October 3, 2026:** Chris corrected the prior request to remove “New conversation”; keep that label. Remove each sidebar row’s leading chat icon and show right-side pin/archive controls like the supplied reference.

Acceptance criteria:

- The search field matches the New chat button’s width and contains its magnifying glass, as subsequently requested by Chris.
- Row actions appear on hover/focus, remain discoverable on touch, and use named sibling buttons rather than nested interactive controls. Pinned conversations sort first and expose an unpin action.
- Authenticated owners can save pin/archive booleans via `POST /api/chats/:id/preferences`; reject invalid/empty patches and cross-owner access. Metadata persists in the existing native catalog, defaults safely for older records, and does not change transcripts or execution.
- Archive removes the row from the regular list while preserving open tabs, drafts, history, and running work. Archived conversations can be opened and restored through the sidebar’s archive view. Failed updates show an error without optimistic state loss; removing a row returns focus to the archive-view control.
- Source/diff/deslop review, TypeScript, production/Nix builds, and desktop/390 px rendered review apply. No tests run; persistence, authorization, keyboard, touch, and archive/restore flows remain unqualified by execution.

October 3 evidence: source/diff/deslop review, 20 local documentation file links, `npm run check`, `nix build`, and `nix flake check` passed on Apple Silicon. The sidebar is now a focused component with sibling row controls; obsolete row-button styling and imports were removed. No tests ran.

## WP-012 — Rail section navigation

**Accepted October 3, 2026:** remove the sidebar Dispatch logo. The rail controls the sidebar and main content; main content controls the contextual column. Rail selections must not create main tabs.

Acceptance criteria:

- Keep chat tabs scoped to Chats. Switching to Agents/Account changes both sidebar and main content, retaining the selected chat and open tabs when returning.
- Keep visited agent/account forms mounted and preserve drafts through section changes. Agents' sidebar selects a saved agent or the library; disable switching agent selection while an editor is open. Account links scroll to its existing settings without discarding forms.
- Remove the conversation sidebar brand block and its unused styles/prop. Keep the existing compact rail mark.
- Clear chat supporting content outside Chats. Pages without defined supporting views display the existing empty state; do not invent unrelated widgets.
- Apply source/diff/deslop review, TypeScript, production/Nix builds, and desktop/390 px rendered review. No tests; full interaction, focus, persistence, recovery, and device qualification remain deferred.

October 3 evidence: source/diff/deslop review, 20 local documentation links, `npm run check`, `nix build`, and `nix flake check` passed on Apple Silicon. The tab model now contains only chat/welcome views; section state preserves visited forms and the selected chat independently. No tests ran.

## WP-013 — Agents continuity with Chats

**Accepted October 3, 2026:** apply the lessons from Chats to the Agents screens, including placing New agent where New chat appears.

Acceptance criteria:

- Share sidebar search and CSS for creation, list spacing, rows, selection, right-side hover/focus actions, and 44 px touch targets. Put New agent at the top and Archived agents at the bottom. Remove the duplicate main creation button, catalog cards, and All agents entry.
- Initially select the default agent; show the selected definition's name, description, instructions, and supported actions in the main view. Match the chat object header, without creating rail tabs or an empty toolbar.
- Display saved agent configuration in the right column. Clearly distinguish saved configuration during editing, and clear old details for a new draft.
- Preserve service defaults, immutable revisions, conflict handling, discard confirmation, and mounted editor state during section/layout changes. Keep section search/archive state in the workspace. Default/archived definitions remain read-only and the existing archive contract is unchanged; no restore or pin contract is added.
- Apply source/diff/deslop review, local documentation link checks, TypeScript, production/Nix builds, and rendered desktop/390 px review. No tests; save/archive authorization, keyboard, touch, recovery, and real-device qualification remain deferred.

October 3 evidence: source/diff/deslop review, 20 local documentation links, `npm run check`, `nix build`, and `nix flake check` passed on Apple Silicon. Desktop and 390 px phone views were visually reviewed. Shared sidebar/search/header styling replaces separate catalog styling. No tests ran; save/archive, complete keyboard/touch flows, and recovery remain unqualified.

## WP-014 — Agents design corrections and Claude approval

**Accepted October 3, 2026:** Chris requested fixing the full [Agents design review](agents-design-review.md) and returning to Claude for design approval. This includes replacing the edit-time sidebar lock with dirty-draft confirmation. The optional second Start chat prompt is omitted: the existing primary action remains the single entry point.

Acceptance criteria:

- Align header/body gutters at wide and narrow sizes. Give the description, instructions, primary Start chat action, and populated supporting view a clear hierarchy.
- Group the editor into Identity, Instructions, and Model, make example placeholders explicit, use shared select styling, and keep Cancel/Create/Save actions visible below the scrolling form. No duplicate Back action.
- Show a live unsaved draft preview and distinguish saved settings from changed settings when editing a revision. Keep default-agent/service constraints and immutable revision/conflict semantics.
- Keep the sidebar usable while editing, asking before discarding a dirty draft when selecting, creating, editing, archiving, or cancelling. Preserve drafts across rail/layout changes, with save-time controls protected from simultaneous edits.
- Show phone model/thinking/tools facts and a full-row Start chat action; anchor navigation archive/sign-out at the bottom. Visually separate desktop column toggles from section destinations.
- Review rendered 1440/1700 px desktop and 390 px phone views, including lower form fields and pinned actions, and obtain Claude's explicit design verdict against fresh captures and source. Keep captures ignored.
- Run source/diff/deslop review, documentation link checks, TypeScript, production/Nix builds. No tests; save/archive, complete keyboard/touch, virtual-keyboard, and recovery qualification remains deferred.

Implemented October 3, 2026. Claude reviewed twelve initial desktop/phone captures and the affected source, then reviewed five final captures after N1–N5 refinements. The final [design approval](agents-design-approval.md#follow-up-re-review--october-3-2026) states: **Approved. No blocking design corrections remain.** The follow-up aligned action-bar contents to the form measure, shared the header divider and friendly model labels with Chats, reduced phone editor chrome while retaining Menu/Details, and removed repeated drawer headings.

Source/diff/deslop review preserves the service boundaries and replaces local editor-only state with one workspace-owned draft and one discard-action guard. TypeScript, production builds, Apple Silicon Nix build/flake checks, whitespace checks, and 32 local Markdown links/anchors passed. Screenshots are retained in ignored `.local/agents-design-fixes/2026-10-03/` in the canonical checkout. Capture 16 was freshly captured from the updated preview but is byte-identical to capture 01 because the selected-agent appearance did not change in the follow-up; Claude's historical observation is preserved in its report.

No tests ran. This is design/source approval, not functional acceptance: existing-agent editing, archived/custom-agent states, save/archive, conflict/error flows, full keyboard/touch, virtual keyboard, and recovery remain unverified.

## WP-015 — Editable default agent

**Accepted October 4, 2026:** make the default agent editable like other definitions. This supersedes earlier default read-only/service-managed constraints; archive protection stays in place.

Acceptance criteria:

- Seed a company-scoped default revision once in Pi's existing catalog during startup, using current service/Pi defaults. Existing saved default revisions survive subsequent startups without being overwritten.
- Use the existing editor, immutable revision append, validation, and stale-revision conflict path for all active agents. Show Edit on the default's main view and sidebar; keep its Default tag and omit/reject Archive.
- New chats copy the latest saved default configuration. Preserve every existing chat's recorded name, revision, and native agent configuration. New-agent drafts use the saved default's model/thinking values.
- Model choices and default-provider readiness follow the saved default, including after a save. Model credentials remain service-owned.
- Apply source/diff/deslop review, local documentation-link checks, TypeScript, production/Nix builds, and rendered desktop/390 px phone review. No tests; runtime save/conflict/restart behavior and keyboard/touch/recovery flows remain unverified.

October 4 evidence: TypeScript, production builds, Apple Silicon Nix build/flake checks, whitespace review, and 29 local Markdown links/anchors passed. Source/diff/deslop review removed the separate in-memory default and its save/lookup special cases, reusing the existing company-scoped revision path. Startup model validation applies when seeding; saved defaults are not replaced by later service settings.

Rendered default-agent detail/editor views were reviewed at 1440 px and 390 px. The default exposes the shared Edit action and editor, retains its Default tag, and offers no Archive action. Captures are ignored in `.local/editable-default-agent/2026-10-04/` in the canonical checkout. Shared tokens and controls were reused; contrast was not remeasured, and keyboard, touch, virtual-keyboard, save/conflict, existing-chat preservation, and restart/recovery qualification remain unverified. No tests or agent edit submissions were run.

## WP-016 — Copy the Coding extension

**Accepted October 4, 2026:** add the reusable prompt extension from Pi Durable example 26, using the installed package's public API and preserving upstream attribution/license.

Acceptance criteria:

- Export `Coding` from [server/extensions/coding.ts](../server/extensions/coding.ts), with the original preamble and environment-derived `cwd` section. Runtime activation and coding tools are a separate integration step.
- Apply source/diff/deslop review, documentation-link checks, TypeScript, production builds, and Apple Silicon Nix checks. Do not add or run tests; runtime behavior remains unverified.

October 4 evidence: source/diff/deslop review, local documentation file links, TypeScript, production builds, `nix build`, and `nix flake check` passed on Apple Silicon. The copied definition retains the upstream sections and adds only a public-package import, export, and attribution. No runtime wiring or UI changed. No tests were run; runtime behavior and Linux builds remain unverified.

## WP-017 — Register Developer

**Accepted October 4, 2026:** register a Developer coding agent using native Pi capabilities. Chris explicitly selected a local M1 Air workspace for this first implementation.

Acceptance criteria:

- Seed Developer once from the saved default model/thinking configuration, with `Coding`, `CodingTools`, and explicit read/write/edit/bash selections. Install implementations before recovery and resolve persisted names through Pi's registry when creating chats.
- Preserve capabilities across basic edits and preserve edited/archived Developer revisions on restart. Existing conversations retain their native configuration; legacy and newly authored basic agents remain chat-only.
- Give each Developer chat a persistent local workspace through `NodeExecutionEnv`, without another execution engine. Explain that service-account access is not sandboxed; remote sandboxes and shared deployment remain deferred.
- Reuse existing agent/editor and tool-transcript UI. Show actual tools and the chat workspace. Apply source/diff/deslop and local-link review, TypeScript, production/Nix builds, and rendered desktop/390 px review. No tests, API smoke checks, or browser acceptance flows; coding execution, replay/cancellation, edit/archive/restart persistence, and keyboard/touch remain unqualified.

October 4 evidence: TypeScript, production client/service builds, `nix build --no-link`, and `nix flake check` passed on Apple Silicon. Source/diff/deslop review retains Pi's registry, native configuration and task ownership; capability selection is server-owned metadata preserved by the existing revision path. Local documentation links and whitespace were checked.

The local service registered Developer with the saved GPT-6 Astra / Low defaults. Authenticated Developer detail/editor views and a blank Developer chat's workspace details were reviewed at 1440 px and 390 px. Six captures are ignored under `.local/developer-agent/2026-10-04/` in the canonical checkout. A blank chat was left open for Chris; no model request, coding task, agent edit, or archive was submitted. This is rendered-layout evidence, not functional qualification. Shared controls/tokens were reused; contrast was not remeasured. Coding execution, replay/cancellation, edit/archive/restart persistence, keyboard/touch, virtual keyboard, and Linux builds remain unverified under the current check policy.

## Integration evidence

On October 3, 2026, the integrated application source at [13875d1](https://github.com/dispatchlabs-ai/dispatch-web-next/commit/13875d1310af0118c52dedd7575d5b5ad095e89a) passed:

- `nix develop --command npm run check`: route-type generation, frontend/service/tooling TypeScript, production SPA output, and compiled service output.
- `nix build` and `nix flake check` on M1 Air: the Apple Silicon client/service artifact and declared type/build check. The x86-64 Linux output remains unbuilt.
- Source and diff review, whitespace checks, and 49 local Markdown link/heading checks. The behavior-preserving [deslop review](../../../.pi/prompts/deslop.md) simplified obsolete test configuration and corrected session transitions, native snapshot ordering, and contextual UI ownership.

No tests, API smoke checks, or browser acceptance checks were run for this final integration. Runtime/recovery, security-flow, and real-device qualification remain deferred. The source commit and this evidence are published together through the repository's normal `main` integration workflow; no shared deployment is part of this package.

## Earlier foundation evidence

## WP-001 — Local development foundation

**Scope:** implement the requested quick localhost environment on M1 Air. Use the previously proposed React Router framework-mode SPA with TypeScript, Vite, and Tailwind; npm workspaces and Nix share locked dependencies and Node 24. The startup page makes the current stage explicit. Dependencies are Nix and network access for initial downloads; there is no backend or credential prerequisite.

**Boundary:** no chat, login, Pi runtime, workspace shell, DNS change, pilot retirement, or Omarchy deployment in this package. Company access and durable execution requirements remain in force for their future feature packages. A component library is still unselected.

Acceptance criteria and October 3, 2026 evidence on M1 Air:

- Enter `nix develop`, install with `npm ci`, and start with `npm run dev` from the root. The locked shell provides Node 24.21.0. The frontend responds at `http://localhost:5173`; the listener is loopback only.
- Source edits hot reload without a Nix rebuild. A temporary status-text edit appeared in the existing browser tab without navigation, then the original text was restored and verified. Reload retains the working startup page.
- The page is readable at desktop and phone width without page-wide horizontal overflow. Browser checks covered desktop, intermediate, and an observed 390 CSS-pixel viewport. No input or touch controls exist in this slice; real-device keyboard/authentication acceptance remains with those features.
- `npm run check` passes route type generation, TypeScript, and the frontend build. `npm run preview` renders the generated SPA successfully; its files are byte-identical to the Nix artifact. No functional test suite or agent workflow is claimed.
- `nix build` produces the static artifact from locked inputs without application credentials, live services, or globally installed Node. `nix flake check` passes the declared build/type check, reusing the successful build when cached.
- Inspect the diff, check local documentation links and whitespace, and apply the behavior-preserving `/deslop` review. An independent frontend review found no actionable issue; the implementation contains only the tooling and static startup page needed for this package.

Apple Silicon macOS is verified for this earlier foundation. The declared x86-64 Linux output is not yet built or deployment-qualified. Chris subsequently authorized coordinated implementation of the remaining discussed packages. This evidence predates the zero-tests rule above.

## WP-018 — Bash terminal presentation

**Accepted October 4, 2026:** implement bash first, then review with Chris before designing custom views for other tools. Depends on WP-017. The snapshot projection joins each call to its native result and current live slot; `ToolActivityView` selects the bash terminal or a generic fallback. No service, runtime, tool, or durable-state contract changes.

Acceptance criteria and evidence:

- Command and combined stdout/stderr share one open terminal; native progress transitions to the recorded result. Diagnostics retain exit errors, stop/interruption messages, and spill-file paths; unmatched results remain visible. Source reviewed against Pi 1.0.1's public entry/live types and bash implementation. Streaming and lifecycle behavior remain unverified under the no-tests policy.
- Output is plain text and bounded by a scrolling viewport. Auto-follow respects reading position. Generic output renders only when its disclosure is open. Other tools receive no custom presenter in this package.
- Reviewed the authenticated existing `pwd` conversation at desktop and 390 px phone sizes; retained still captures under ignored `.local/bash-terminal/2026-10-04/`. Still captures establish layout only; keyboard, touch, virtual keyboard, long-running output, cancellation, reconnect/recovery, and screen-reader behavior remain unverified.
- Deslop source/diff review, local documentation links, TypeScript/production builds, `nix build`, and `nix flake check` passed on Apple Silicon. New terminal text contrast is at least 7.86:1; aqua command/focus indicators are at least 6.09:1 on their surfaces. Shared tokens, 12 px minimum text, native disclosures, and a 44 px terminal header follow the UI rules. Keyboard/touch and assistive-technology behavior remain unverified; Linux builds remain unverified. No tests were added or run.

October 4 refinement: Chris requested removing debug data even as an optional UI disclosure. Removed the terminal and generic-tool debug disclosures, including raw call-argument JSON; command/output/status and visible bash diagnostics remain. Native entries and SQLite persistence are unchanged. This supersedes WP-018’s initial debug-data option. Chris also requested attributing tool output to Developer: the agent heading now precedes tool activity, and consecutive assistant messages continue below it without a duplicate heading. Source/deslop and diff review, 25 local documentation links, TypeScript/production builds, `nix build`, and `nix flake check` passed on Apple Silicon. The existing `pwd` response was reviewed on desktop and at 390 px phone width, with captures `04-clean-phone.jpg` and `05-clean-desktop.jpg` in the same ignored evidence directory. No tests were run; the functional and platform limitations above still apply.

October 4 output refinement: Chris requested showing the output only once. The terminal remains the output surface; the immediately following completed text-only assistant message is hidden only when it exactly repeats that bash output, optionally inside one fenced code block. Non-text content, explanations, and incomplete/error responses remain visible. User messages and reset/compaction boundaries clear the comparison. The display reads the same shared output projection as the terminal and does not change Pi’s stored entries. Source/deslop and diff review, 25 local documentation links, TypeScript/production builds, `nix build`, and `nix flake check` passed on Apple Silicon. Reviewed the existing `pwd` response at desktop and 390 px phone width, with captures `06-once-phone.jpg` and `07-once-desktop.jpg` in the same ignored evidence directory. No tests were run; other matching cases, streaming/lifecycle behavior, keyboard/touch, and Linux remain unverified.

## WP-019 — Editable Markdown composer

**Accepted October 4, 2026:** replace the plain prompt field with live Markdown formatting, remove its double focus box, and remove the privacy sentence from the toolbar. Depends on the existing per-chat draft/send contracts. Lexical 0.52.0 supplies the editor, Markdown transforms, and undo history; Pi receives the same Markdown text message contract. The npm lock and Nix dependency hash pin the new dependencies.

Acceptance criteria and evidence:

- Headings, lists, quotes, emphasis, links, and code render as editable content. Plain clipboard text is parsed as Markdown; code-block paste is literal, and copy/cut serializes the selection as Markdown. Shift+Enter uses normal rich-text paragraph/list behavior; desktop Enter still sends and IME composition does not submit. Source reviewed against the pinned editor's public commands and transformers. Markdown spelling can normalize; unsupported constructs remain text.
- Each mounted chat retains its editor and workspace draft. External draft changes update content without applying DOM selection or re-parsing each keystroke; an acknowledged send clears undo history. The existing request IDs, retry state, draft-version protection, and backend limits remain intact. An oversized draft stays editable with a visible error and disabled Send.
- One outer focus indicator replaces the nested textarea outline. The toolbar has Send and active-run Stop without a privacy/status sentence. The editor grows to a bounded scrolling area; mobile input is 16 px with existing 44 px actions. Token contrast is at least 4.43:1 for the focus indicator on adjacent surfaces and 6.04:1 for new text/placeholder surfaces.
- Authenticated still-layout review covered the empty focused editor and a formatted sample draft on desktop and at 390 px. Captures are ignored under `.local/markdown-composer/2026-10-04/` in the canonical checkout. The preview draft was never submitted. Layout evidence does not qualify editing, copy/cut, undo, draft/retry/recovery, keyboard/IME, touch, virtual keyboard, or screen-reader flows; those remain unverified under the zero-tests policy.
- Source/deslop and full diff review, local documentation links, TypeScript/production builds, `nix build`, and `nix flake check` passed on Apple Silicon. The production home chunk is about 670 kB minified / 208 kB gzip and emits Vite's size warning; loading performance and Linux builds remain unverified. No tests were added or run.

### October 6, 2026 — Composer draft synchronization regression

Chris reported scrambled typing with two conversations open. The private trace in the canonical checkout's ignored `.local/composer-proof/sentence-repeat.json` recorded ten editor rebuilds; source/trace review found an older parent draft replacing newer local text and resetting selection. This is a frontend synchronization defect, not resolved by a backend restart. Raw captures remain local and are not committed.

The correction tracks the last committed parent value separately from the latest local Markdown. Mention/transformer-only renders no longer replay unchanged parent text; changed parent values are consumed in a layout effect rather than a delayed passive effect. Lexical is keyed by composer ID so switching threads isolates undo, selection and mention state even for identical draft text. Genuine external replacements and acknowledged-send history clearing remain supported; send settlement retains its request-ID/edit-version guards. Agent and skill document editors keep their existing replacement paths.

Pi Durable Expert and Deslop source reviews found no blocking issue or needed simplification. Deployer independently verified `npm run check` inside `nix develop`, `nix flake check`, `nix build`, and whitespace checks on Apple Silicon; Linux was not built. Logs remain ignored under the fix worktree's `.local/composer-checks/`. No tests were added or run. Repeating the two-conversation typing reproduction, send-clear/newer-input behavior, thread switching, document editing and desktop/390 px rendered review remain unverified; source review does not establish runtime editing correctness. No backend restart or deployment is implied.

## WP-020 — Write and edit diff cards

**Accepted October 4, 2026:** implement the [Pierre Diffs recommendation](https://wiki.dispatchworks.ai/wiki/write-tool-presentation/) for both native file tools. Depends on WP-018's call/result projection. `@pierre/diffs` 1.5.1 is pinned in the package and npm lock, with the matching Nix dependency hash. This is browser presentation; Pi's tools, stored entries and runtime ownership are unchanged.

Acceptance criteria and evidence:

- Write cards display the original call's path and full content as additions, including blank lines, with an explicit empty-file state. This applies to creates and overwrites. Until success, the card labels content as requested and retains native status, errors, images and diagnostics.
- Edit cards consume the successful native `details.patch`, with file line numbers and surrounding context. No current filesystem read or reconstruction from replacement snippets is involved. Missing patches retain native output and any recorded display diff. A local rendering boundary preserves recorded source if the formatted view fails. These paths were source reviewed against Pi Durable 1.0.1 and Pierre 1.5.1; failure, missing-data and empty-file behavior remain unverified under the zero-tests policy.
- One open card combines the path, operation and execution status with a unified diff. Shared tokens style the header, focus and addition/removal indicators. Code uses 12 px minimum text and wraps in a bounded scrolling region. The viewer is lazy-loaded; stable props/options and a shared local worker pool avoid repeating highlighting for unrelated snapshots, while each open card virtualizes its code. No custom concurrency limit was added.
- Authenticated still-layout review covered the existing `hello.md` write and subsequent edit at desktop and 390 CSS-pixel phone width. The original write shows all seven recorded lines as additions; the later edit shows its added bullet at file line eight with unchanged context. Captures are ignored under `.local/write-edit-diffs/2026-10-04/` in the canonical checkout. No model request or file operation was submitted. These are layout observations, not lifecycle or interaction qualification.
- Source/deslop review reused the terminal's diagnostic filtering for file outcomes and memoized the lazy viewer without remounting it for each streamed argument update. The full source/dependency/documentation diff and local links were reviewed. TypeScript, production client/service builds, `nix build`, and `nix flake check` passed on Apple Silicon; no tests were added or run.
- The lazy viewer chunk is about 532 kB minified / 148 kB gzip, plus a 214 kB worker entry and separately loaded language/theme assets. The main home chunk is about 674 kB / 209 kB gzip. These are build output sizes, not total first-use transfer or performance measurements; Vite reports large chunks. Large-file latency/memory/scrolling, red-removal examples, keyboard/copy, touch, Safari, screen-reader behavior, all syntax-token contrast and Linux builds remain unverified. The current active-view API still omits entries beyond reset/compaction boundaries; complete historical browsing is separate work.

## WP-021 — Read file cards

**Accepted October 4, 2026:** show how many lines were read and those lines themselves. Depends on WP-020's shared file card and viewer. The [read presentation decision](https://wiki.dispatchworks.ai/wiki/read-tool-presentation/) owns the intent. This changes the browser projection only; Pi's native read tool, stored records and runtime ownership are unchanged.

Acceptance criteria and evidence:

- Successful reads show the recorded path, returned line count, original line range and source. Numbering starts at the recorded offset, defaulting to one. Harness diagnostics stay outside the line count; native truncation metadata and the Pi 1.0.1 continuation diagnostic disambiguate a final blank line in a bounded excerpt. Partial lines are labeled. Missing calls use relative numbering with an explanation; empty output, errors, stop/interruption status and diagnostics remain explicit.
- Read uses the existing lazy Pierre viewer with a context-only hunk, neutral background and no addition/removal markers. This supplies original file numbers without loading a full file. Shared card styles, 12 px minimum text, a 44 px header, wrapping, a focusable bounded viewport, worker highlighting and virtualization are retained. No dependency, service, storage or concurrency-limit change is involved.
- Source/deslop review covers Pi Durable 1.0.1's read/truncation implementation and the shared output projection. The count follows returned content and native range evidence rather than the requested maximum. Existing entries receive the presenter without a tool rerun. Source fallback remains local to a failed formatted view.
- Authenticated still-layout review covers the existing seven-line `hello.md` read on desktop and at 390 CSS-pixel phone width. Captures stay in the canonical checkout's ignored `.local/read-file-cards/2026-10-04/`. No model request or file operation was submitted. Still images establish layout only.
- Source/deslop and full diff review, 31 local documentation links/anchors, TypeScript/production builds, `nix build`, and `nix flake check` passed on Apple Silicon. No tests were added or run under the zero-tests policy. Offset/limit/truncation, empty/error/missing-call paths, keyboard/copy/touch, screen readers, full syntax contrast, large-file performance, Safari and Linux remain unverified by execution. The existing active-view history boundary and Vite large-chunk warnings remain.

## WP-022 — Direct passkey enrollment

Chris requested removing the passkey-name hurdle on October 5, 2026, locally first. Omarchy remains pinned to its existing release until a later authorized deployment.

Scope: remove enrollment-only label state/input, omit the optional request field, and describe the browser/password-manager ceremony. Preserve WebAuthn verification, account display name, password/TOTP, recovery, existing labels, and Account/security management. The backend already defaults an omitted label to `Passkey`; no API or storage migration is needed.

Acceptance and evidence:

- Source review confirms signup and recovery enrollment no longer ask for a passkey name and still invoke native registration.
- The request remains compatible with the existing optional-field contract and server fallback.
- `npm run check`, `nix flake check`, and `nix build` passed on Apple Silicon macOS. Source/diff review confirms no service, schema, or security-policy changes.
- No tests or enrollment ceremonies run under the current zero-tests policy. Rendered desktop/390 px enrollment review remains unverified.

## WP-023 — Projects inside Conversations

**Accepted October 5, 2026:** implement Chris's approved ImageGen desktop design, with a required name only, many conversations per project, and at most one project per conversation. Scope and contracts are in [Projects in Conversations](spec.md#projects-in-conversations). This is local development; Omarchy stays on its existing deployment.

Acceptance criteria:

- New project, collapsible project groups, unassigned conversations, project name/list view, and project-aware New conversation match the approved desktop design and remain available at 390 px.
- Existing chats remain unassigned. Assign/move/remove membership preserves native history, ongoing work, agent configuration, working directories, open tabs and drafts. Existing pin/archive/restore and search remain usable.
- Pi owns storage transactions and execution. Both project and chat access enforce company/creator scope. Creation retries retain their original membership identity after later moves; failed operations keep form input and saved state.
- Review source/deslop, full diff, documentation links, frontend/service/tooling TypeScript, production build, Nix build and flake checks. Record rendered desktop/390 px evidence and all unverified outcomes below; add or run no tests under the standing policy.

Implementation and evidence (October 5, 2026):

- Implemented the project catalog, scoped API, nullable conversation membership, creation-request identity, grouped sidebar, name-only popover, project tabs/list, and move dialog. The approved image is saved with the specification.
- Source/deslop and full diff review completed. `npm run check`, `nix flake check`, and `nix build` passed on Apple Silicon macOS. Nix did not evaluate other systems; the existing Vite chunk-size advisory remains.
- Rendered layout review covered the authenticated New project form at desktop and 390 px, plus the actual project-list/sidebar components rendered with static sample props at desktop and 390 px. The sample preview had no API writes or interactive handlers. Local screenshots are in `.local/projects-layout/2026-10-05/` in the task worktree.
- No tests were added or run. Creation/moving persistence, ownership rejection, retries/recovery, live work preservation, keyboard flows, measured contrast, and real-device touch behavior remain functionally unverified under the standing policy. Build/source evidence does not establish runtime correctness.
- Local development only; no Omarchy deployment was performed.

## WP-024 — Shared conversations

**Implemented locally October 5, 2026; functional qualification deferred.** Chris accepted shared conversations and resolved activation, invitation authority, agent-instance continuity, and join-history access. The [shared-conversation specification](spec.md#shared-conversations) and [maintained decision](https://wiki.dispatchworks.ai/wiki/agent-collaboration-spaces/) are the product basis. This package depends on the existing authenticated native runtime, revisioned company agent definitions, tool presenters, and WP-023 projects.

Chris approved the [ImageGen designs](shared-conversation-designs.md) following his Slack reference and authorized implementation with subagents. The package includes the shared message flow, reply threads, starting agents, invitations and phones. Thread replies retain the same conversation membership and agent participation policy; the specification records the concrete contract.

Scope: allow humans and independent agent instances to participate in one visible conversation, choose starting agents, invite participants, share attributed public history, and use native Pi delivery/recovery. Keep the existing single runtime and local development environment. No Omarchy deployment, new agent-identity provider, remote sandbox, cross-store protocol, or numerical concurrency cap belongs to this package.

Implementation order within this package:

1. Define the native public-log, membership, instance, delivery and personal-preference records. Resolve the legacy-chat compatibility strategy and native transaction/cancellation boundaries against the pinned public API before implementing persisted changes. Preserve current IDs, saved agent revisions, history, workspaces, project assignments and ongoing work.
2. Implement the authenticated membership/message APIs, native agent invitation/public-post tools, full-history access, and Pi-owned durable delivery/reporter tasks. Each new public message is considered by other agent members, with silence allowed; stable message/recipient identities handle retries. Apply membership to snapshots and live subscriptions as well as commands.
3. Implement creation-time agent selection, the participant list and invitation controls, attributed public messages, author-scoped native tool/status presentation, and shared Stop behavior. Preserve existing desktop/mobile workspace, tabs, drafts, project context, and personal pin/archive state. Update the runtime and usage guides to the implemented contracts.

Acceptance criteria for implementation:

- A human can select the starting agent configuration within or outside a project and then invite human or agent members. An agent can bring an available company agent into its conversation; it cannot invite humans or act under a human author's identity.
- Human and agent participants can address one another in the shared history. There is no mandatory coordinator. Agents consider new messages from others and can remain silent without generating an empty public post or reply cycle.
- Instances retain independent working contexts and saved configuration revisions. Reusing the Developer definition does not merge private history or working directories across conversations.
- Joining grants access to all public history, including pre-join messages. Historical access survives native active-context compaction/reset; model-window preparation does not delete the public record. Public authorship and private working context remain distinct.
- Existing private conversations remain available with their original creator and saved agent. The compatibility strategy preserves native entries, working directories, current work, URLs, drafts and project organization. Sharing a chat does not share a private project or unrelated chats.
- Source review accounts for failed/uncertain requests, deduplicated delivery and public posting, native restart recovery, provider failures, membership checks, conversation-wide Stop, and browser reconnection. Do not substitute an in-memory observer or another execution engine for native durable work.
- Apply the spec's UI rules and behavior-preserving source/deslop review. Review actual rendered desktop and 390 px layouts. Record any unverified rule, keyboard/touch behavior, status/recovery flow, or accessibility property honestly.
- Review the full diff and changed local documentation links; run TypeScript/production checks, `nix build`, and `nix flake check` for the implementation revision. Add or run no tests, smoke checks, or browser acceptance flows under the standing zero-tests policy. Record functional outcomes as unverified unless separately authorized evidence establishes them.

Implementation: native shared document/public entries, per-instance bindings, delivery/reporter/Stop tasks, membership APIs and directory, sanitized public snapshots, agent chooser/invitation/mention controls, reply panels and per-thread drafts. Source review covers migration, request identity, transaction ordering, draft lifetime, image preservation, private-context exclusion and cancellation. Final check and layout evidence follows below; functional/API/authentication/recovery/keyboard/touch outcomes remain unverified under the zero-tests policy.


Qualification evidence (October 5, 2026):

- Integrated source/deslop review covered the native application boundary, scoped directory/membership checks, native draft lifetime, legacy retry reservations and queued work, Stop admission fencing, image preservation, stream-to-public-answer replacement, safe reset/compaction markers and per-chat supporting-state isolation. Removed a redundant directory lookup at the HTTP boundary; the runtime resolves invitations once against the authenticated company.
- Frontend/service/tooling TypeScript, production builds, `nix flake check` and `nix build` passed on Apple Silicon. The existing Vite large-chunk warning remains. These checks do not qualify runtime behavior; this revision’s x86-64 Linux build was not run.
- Rendered desktop and 390×844 stills reviewed the actual existing conversation/tool history and participant panel. Clearly labelled static samples using real components covered populated multi-agent discussion, reply threads, starting-agent choice and invitations; portal chrome in the chooser/invitation samples is a static equivalent. The invitation review found and corrected the Already here mismatch. No sample conversations, participants or messages were inserted into user state.
- Shared token styles, 12 px minimum type, labelled actions, native/Base UI controls and phone layouts were reviewed in source and stills. Keyboard, touch, IME/virtual keyboard, assistive technology, all empty/error/loading states, focus restoration, contrast measurements, long-history performance, streaming/retry/recovery and multi-user authorization flows remain unverified. No tests, smoke checks, model requests or browser/API acceptance procedures were run.
- Captures and sample scripts remain in ignored `.local/shared-layout/2026-10-05/` and the UI task worktree’s `.local/shared-layout/`; user-state backup is in the canonical checkout’s `.local/backups/shared-conversations-20261005-182617/`. The local service was updated; Omarchy and the pilot were not changed.

## WP-025 — Developer's Wiki connection

**Accepted October 5, 2026:** Chris selected per-agent connections and authorized
Developer's full personal-Wiki MCP access, including existing Developer instances.
See the [connection specification](spec.md#per-agent-mcp-connections). This package
uses the current local runtime and preserves the existing Omarchy Dispatch pilot.
Palm's focused playbook owns the dedicated credential/enrollment and operator
manifest; Dispatch owns the bridge, public status API and agent UI.

Acceptance criteria and evidence:

- A dedicated **Dispatch Developer** Wiki identity has independent Editor authority
  and all three read/trace/write scopes. Its private key stays on M1 Air. Enrollment
  uses the existing application-owned Wiki adapter and does not reuse Codex's key.
- Developer's definition selects the MCP extension and tools. Existing instances
  receive the explicitly authorized connection while preserving their model,
  instructions, working directories and histories. Other definitions do not inherit
  it. Native Pi documents hold catalog/bindings; Pi owns execution/recovery.
- Authenticated Agents views show endpoint, identity, current observed connection
  status, discovered access and actual tools. Reconnect is explicit; failures and
  stale status remain visible. Secrets do not enter the browser or model context.
- Source review covers configuration isolation, removed tools/connections, schema
  discovery failures, credential errors, cancellation, uncertain remote writes and
  close/reopen ordering. Remote operations use unsafe replay; no substitute durable
  execution engine or concurrency limit is added.
- Run source/deslop and full diff review, local documentation links, TypeScript and
  production builds, `nix build` and `nix flake check`. Review desktop and 390 px
  layouts. No tests, smoke requests or model-driven tool calls under the standing
  zero-tests rule. Record observed startup discovery separately from functional
  qualification of tools, renewal/revocation, interruption/recovery and interaction.

Implementation evidence (October 5, 2026):

- Source/deslop and diff review kept stock Pi responsible for execution, explicit
  per-conversation bindings for grants, and the maintained Wiki adapter responsible
  for credential renewal. One shared tool-summary formatter keeps internal provider
  IDs out of agent detail views; the connection card shows actual remote names.
- Clean `npm ci`, frontend/service/tooling TypeScript, production builds, Apple
  Silicon `nix build` and `nix flake check` passed. The existing Vite chunk warning
  remains; this revision's Linux build was not run. Local documentation links and
  whitespace checks passed.
- Palm's focused playbook enrolled the dedicated persistent identity and wrote
  only Developer's Wiki manifest entry. Ansible 2.21.3 syntax checking passed
  without connecting to hosts. Normal local startup authenticated as Dispatch
  Developer and discovered all nine tools. Read-only native metadata shows the
  `developer/wiki` binding on both existing Developer instances (23 and 97).
- The actual authenticated Agents page shows Developer revision 2 with Connected,
  Full access and nine tools; the default definition shows no connections. Desktop
  1440×1000 and phone 390×844 stills were reviewed, including the expanded catalog.
  Captures are ignored under the canonical `.local/developer-wiki/2026-10-05/`.
- Private auth/Pi state was backed up before startup under canonical
  `.local/backups/developer-wiki-20261005-201104/`. The local app uses its existing
  state and workspaces. Omarchy's Wiki received the public enrollment; the Omarchy
  Dispatch application and pilot were not changed.
- No tests, smoke requests, model prompts or remote tool-operation calls were run.
  Discovery is observed configuration evidence, not qualification of article/trace
  operations, writes, token renewal/revocation, cancellation, recovery, Reconnect,
  keyboard/touch, virtual keyboard, assistive technology or all error/loading
  states. Contrast and multi-user isolation remain unverified.

## WP-026 — Listen before responding

**Implemented, October 5, 2026; functional qualification deferred.** Chris accepted the [listen-first behavior](https://wiki.dispatchworks.ai/wiki/agent-collaboration-spaces/#section-listen-before-responding) and instructed implementation. This package depends on WP-024 and preserves the local-only and zero-tests policies.

Scope: native speaking-turn coordination, fresh shared context at every model request, coalesced consideration, independent background tool work, expiring human composing presence, and truthful participant states. Existing public history, native admissions, participant configuration, membership, drafts, threads and Stop remain intact. No Omarchy deployment or new execution engine is included.

Acceptance criteria and evidence:

- Source review must cover atomic competing claims, mention priority, non-fixed default order, fresh context after waits/tools, silence, deliberate posts, duplicate deliveries, admitted-submission recovery, cancellation/failure cleanup and Stop. Claims and waits belong to native Pi documents/tasks; ordinary tools do not retain the conversational turn.
- Human typing never blocks human sending. Review identity binding, multiple composers, out-of-order pulses, inactivity/disconnection expiry and independent draft lifetime. Presence contains no draft text and uses the same authenticated membership boundary as other chat commands.
- Review Listening/Responding/Working and human typing on rendered desktop and 390 px screens, using labelled static samples when necessary. Record unmeasured contrast, keyboard/touch, assistive technology, real-device and functional outcomes as unverified.
- Complete source/deslop and diff review, local documentation-link checks, TypeScript/client/service/tooling and production builds, `nix build` and `nix flake check`. Do not add or run tests, model requests, smoke checks or browser/API acceptance procedures.
- Record the exact publication and canonical synchronization result and local service update, preserving existing user state. Functional multi-user, streaming, provider failure, presence expiry and restart behavior remain unqualified without execution evidence.

Qualification evidence (October 5, 2026):

- Source/deslop review covered competing claims, mention ordering, fresh context, coalesced delivery, resumed native admissions, ordered human presence, Stop and owner-task cleanup. Public progress precedes tool execution, and final publication shares its freshness-check transaction. A shared recent-history formatter and shared presence component avoid duplicate behavior.
- Frontend/service/tooling TypeScript, production builds, Apple Silicon `nix build` and `nix flake check` passed on the revision integrated with Developer's Wiki connection (`0c6d026`). Clean `npm ci`, whitespace checks and all 43 local documentation links also passed. The existing Vite large-chunk warning remains; x86-64 Linux was not built.
- Desktop and 390×844 phone stills reviewed actual components with clearly labelled inactive samples for Listening, Responding, Working and human Typing, including participant details. Captures remain in the task worktree's ignored `.local/listen-layout/`; no sample messages were inserted into user state. Shared styling and labelled controls were reviewed. Keyboard/touch, IME, virtual keyboard, assistive technology, measured contrast, real-device behavior and all error/loading states remain unverified.
- No tests, smoke checks, model requests or browser/API acceptance procedures were run. Functional turn ordering, multi-user access, streaming, presence expiry, provider failure and restart recovery remain unqualified. These limits remain after the normal local startup.

- [Implementation `ba71416`](https://github.com/dispatchlabs-ai/dispatch-web-next/commit/ba7141673354f17f40225244814a924296f37cbf) was pushed normally to private remote `main`; remote equality was verified and the clean canonical M1 Air checkout fast-forwarded under the repository integration locks. The existing local launcher shut down gracefully, and state was backed up under canonical `.local/backups/listen-first-20261005-202329/` before restarting against the same state and workspaces. Startup reports the service on `127.0.0.1:3001` and Vite on localhost:5173. This is startup evidence, not functional qualification. Omarchy and the pilot were not updated.

### Duplicate reply correction — October 5, 2026

Chris reported two identical public replies per agent. Read-only inspection of the existing conversation found matching `final:<participant>:<generation>` and `answer:<participant>:<entry>` publications. The native document history recorded an empty first finalized array: chained assignment and push mutated the pre-copy array, so delivery could not see the first marker. The same pattern affected the first superseded marker.

- Assign complete finalized/superseded arrays in native transactions. Reconstruct missing final markers from owned generation records on startup; alias an older duplicate only when its native generation, author, thread and content match. Preserve raw entries, native admissions and replies, and accept old message IDs in history, open threads and saved-draft posting. Do not collapse deliberate repeated text.
- Use one public-message projection for snapshots and agent history/context. Keep original request fingerprints and existing membership boundaries. Review these changes with the source/deslop procedure and inspect the final diff and local documentation links.
- Run TypeScript/production builds, Apple Silicon `nix build` and `nix flake check`; inspect the existing repaired conversation on desktop and 390 px. No synthetic messages, model requests, tests or API/browser acceptance procedures. Record observed repair and layout evidence separately from unverified future-turn, restart, concurrency and interaction behavior.

[Implementation `d90ab5c`](https://github.com/dispatchlabs-ai/dispatch-web-next/commit/d90ab5c5346cd0b9ba33fc203398843d645a5819) passed frontend/service/tooling TypeScript and production builds (`npm run check`), Apple Silicon `nix build` and `nix flake check`, source/deslop review, documentation-link and whitespace checks. It was pushed normally to private remote `main`; remote equality was verified and the clean canonical M1 Air checkout fast-forwarded under the repository integration locks.

The local launcher shut down gracefully, and existing state was backed up under canonical `.local/backups/duplicate-replies-20261005-205033/` before restarting against the same state and workspaces. Read-only inspection of existing native records confirmed both duplicate pairs received canonical aliases and the missing final markers were restored. The existing conversation then displayed one reply per agent on desktop and at 390 px; ignored captures are in canonical `.local/duplicate-replies/`. Static component captures in task-worktree `.local/duplicate-layout/` also cover a reply thread opened through an older alias. Raw entries were preserved. No new messages or model requests were sent.

No tests or browser/API acceptance procedures ran. This is observed repair of the existing conversation plus build/source/layout evidence; future-turn publication, concurrency, broader restart recovery, thread interactions, keyboard/touch and real-device behavior remain unqualified. The existing Vite chunk-size advisory remains. This revision was not built on x86-64 Linux or deployed to Omarchy or the pilot.

### Publication simplification — October 6, 2026

Chris asked for a deslop pass after reviewing the duplicate-reply cause. The shared public log remains an application-defined Pi entry stream, distinct from agent working transcripts; this clarification corrects any implication that the UI directly renders only the built-in transcript.

- Keep successful final publication solely in `onYield`, where freshness and public append share a transaction. Delivery completion only updates status; it retains unpublished committed native output when the submission fails or is aborted.
- Remove `reported` and `finalized` member lists. Use persisted public message identities for publication checks, visible activity and interrupted-output retention. Final/progress checks share native generation identity; interrupted output retains native entry identity. Keep superseded-generation exclusions because those drafts have no public entry.
- Share interrupted-output selection between delivery failure and Stop. Preserve the native legacy reporter for work admitted before shared-conversation migration. Keep native task definitions, request receipts, membership boundaries, author/thread attribution and Stop fences intact.
- Run historical duplicate repair once per existing room before native resume; retain raw entries and old aliases, remove obsolete publication lists, and mark new rooms current. Normal publication must not use content-based deduplication.
- Review source and all affected callers, run TypeScript/production builds, Apple Silicon `nix build` and `nix flake check`, and inspect the diff and local links. Review the existing conversation on desktop and 390 px after the local update. No tests, synthetic messages, model requests or browser/API acceptance procedures under the standing policy.

[Implementation f5de4b2](https://github.com/dispatchlabs-ai/dispatch-web-next/commit/f5de4b2e028ef76bae01426683771f46d76af2fe) was pushed normally to private `main`, verified remotely and fast-forwarded into the clean canonical checkout. Source/deslop review, TypeScript/production builds, Apple Silicon `nix build` and `nix flake check`, whitespace and 32 local documentation links passed.

The canonical M1 Air service was restarted after a private state backup at `.local/backups/publication-cleanup-20261006-062053/dispatch`. Read-only metadata from the existing Pi database showed all five rooms at history version 1 with the obsolete member fields removed. All 89 raw entries retained the same SHA-256 digest, and existing message aliases were unchanged. The existing conversation rendered on desktop and at 390 px; captures remain private in `.local/publication-cleanup/desktop.jpg` and `phone.jpg` in the canonical checkout. This is evidence of the observed local migration and saved-history rendering only.

No tests, synthetic messages, model requests or browser/API acceptance procedures ran. Future-turn publication, interruption, concurrency, broader migration/restart behavior and device interactions remain functionally unqualified. The existing Vite chunk-size advisory remains; this revision was not built on x86-64 Linux or deployed to Omarchy or the pilot.

## WP-027 — Inline mentions

**Accepted October 5, 2026:** Chris rejected the detached Mention dropdown and
requested Slack's inline mention UI. This replaces the WP-024 composer control
under the [inline mention contract](spec.md#inline-mentions), preserving shared
membership, listen-first participation, typing presence and message retry behavior.

Acceptance criteria and evidence:

- `@` at the caret opens a filtered list of current people and agents in both main
  and reply composers. The toolbar uses a small `@` shortcut. Selection inserts an
  inline identity token; it does not send, add a detached chip or invite someone.
- Lexical owns selection, native typeahead keyboard handling, token editing and
  undo/redo. Floating UI positions the list against the caret and the visible
  viewport. Shared components and token styles cover desktop and phone layouts.
- Source review covers Enter/Tab versus Send, Escape/blur, empty results, IME and
  code/link/email boundaries; token deletion, copy/paste, duplicate names, draft
  remounts, historical messages and retry identity. Only IDs retained in the editor
  are submitted. No native runtime or server authorization behavior changes.
- Run the permitted source/deslop, TypeScript, production build, `nix build`,
  `nix flake check`, diff and local documentation checks. Review actual components
  in desktop and 390 px stills. No tests, smoke requests, model prompts or browser
  acceptance procedures under the standing zero-tests rule.

Qualification evidence (October 5, 2026):

- Source/deslop review covered the editor, Markdown import/export, message rendering,
  draft/mention callbacks and the existing request contract. Lexical owns keyboard
  navigation and atomic editing; Floating UI supplies caret/viewport positioning.
  The composer retains multiline textbox semantics and the native typeahead's
  active-option and controlled-list relationships.
- Clean `npm ci`, frontend/service/tooling TypeScript and production builds
  (`npm run check`), Apple Silicon `nix build` and `nix flake check` passed.
  The integrated revision also passed 44 local documentation-link checks and
  whitespace/diff review.
  The direct Floating UI dependency is pinned with the existing transitive version
  and the Nix dependency hash is updated. The Vite chunk-size advisory remains.
- Actual menu/editor/message components were reviewed in inactive desktop
  (1440×1000) and phone (390×844) layouts. Stills cover suggestions, a filtered
  reply picker, empty results and selected inline names; captures remain in the
  task worktree's ignored `.local/mentions-layout/`. These are static layout
  samples, not evidence of live caret positioning or selection behavior.
- No tests, smoke checks, model requests or browser/API acceptance procedures ran.
  Keyboard/touch selection, IME, copy/paste and undo, actual positioning/scrolling,
  retry/remount behavior, virtual keyboards, assistive technology, measured contrast,
  real devices and the full loading/error matrix remain functionally unverified.
  This revision was not built on x86-64 Linux or deployed to Omarchy/the pilot.

[Implementation `1e72b47`](https://github.com/dispatchlabs-ai/dispatch-web-next/commit/1e72b47fdb06a4e3b4139d1d463ac450fe12501d)
was reconciled with the duplicate-reply correction and passed the required
TypeScript/build/Nix checks again before publication. It was pushed normally to
private remote `main`, verified there, and fast-forwarded into the clean canonical
M1 Air checkout under both repository integration locks.

The previous local launcher shut down gracefully. Existing state was backed up to
canonical `.local/backups/inline-mentions-20261005-210407/`, `npm ci` installed the
updated lockfile, and the normal development launcher restarted with the same
state/workspaces. Startup reported the service on `127.0.0.1:3001` and Vite on
localhost:5173. The refreshed workspace exposes the new Mention someone shortcut;
no message was entered or sent. Canonical `.local/inline-mentions/` retains the
startup record and ignored captures. This observation does not qualify the
interactive picker behavior.

### Composer toolbar refinement — October 6, 2026

Chris requested removing the redundant `@` toolbar button and restoring the former
arrow-only Send button. Remove the shortcut component and its unused imports, the
visible Send text, and the later width/alignment overrides so the existing compact
button and phone touch-target styles apply again. Preserve the shared main/reply
composer, typing-triggered mention menu, accessible action labels, and sending/retry
states. This supersedes the initial WP-027 shortcut criterion above.

Review the source/diff and actual rendered desktop/390 px layouts, and run the
repository TypeScript/build/Nix checks. The standing zero-tests policy remains;
interaction, assistive technology, measured contrast and real devices are unverified.

[Implementation `2c6fd7c`](https://github.com/dispatchlabs-ai/dispatch-web-next/commit/2c6fd7c81833553fcb2a407a857cd508bb0144d0)
passed source/deslop review, 44 local documentation links, whitespace checks,
TypeScript/production builds, Apple Silicon `nix build` and `nix flake check`.
It was pushed normally to private main, verified there, and synchronized to the
clean canonical checkout under both integration locks. The existing local frontend
hot-reloaded; the persistent service and saved state were not restarted or changed.
The actual empty composer was reviewed at 1440 px and 390 px: no mention shortcut,
an arrow-only action at the right, and the existing phone touch target. Ignored
captures remain in canonical `.local/composer-toolbar-20261006/`. No messages,
tests or acceptance procedures ran. The existing Vite chunk-size advisory remains;
x86-64 Linux, Omarchy and the pilot were not updated or qualified.

## WP-028 — Conversation layout refinement

**Implemented and manually reviewed on the local development site, October 6, 2026.** Chris approved the [refinement images and V01–V12 criteria](conversation-layout-refinements.md), requested coordinated implementation with subagents, and explicitly required the coordinator to validate it by using the local development site. The [maintained design decision](https://wiki.dispatchworks.ai/wiki/agent-collaboration-spaces/#section-october-6-conversation-layout-refinement) records the scope and focused manual-browser exception to the prior zero-tests policy. Automated tests remain deferred.

This package depends on shared conversations, project navigation, inline mentions, and the existing tool presenters. It changes browser presentation and context controls, preserving native Pi ownership, membership, public-message identity, retry/draft state, listening behavior, and specialized Bash/file output.

Acceptance criteria:

- Match V01–V12 against both rendered reference states: shared alignment, useful width, compact messages, contextual actions, real reply summaries, selected threads, two composers, participant inspection, compact navigation, distinct identities, readable activity, and shared styling.
- Use the actual local application at a recorded desktop viewport and zoom; compare the same conversation before and after. Review a narrower desktop and 390 px phone layout, including overflow, touch targets, and context presentation.
- Manually exercise the relevant browser flows: open/close threads and participants, inspect an agent, expand activity, expose message actions with pointer/keyboard, select an inline mention, preserve main/thread drafts across navigation and layout changes, and verify reply-summary data through an explicitly labelled local review conversation where needed.
- Run source/deslop review, integrated TypeScript and production builds, Apple Silicon Nix build/flake checks, diff review, and local documentation-link checks. Keep screenshots and review artifacts in ignored local storage.
- Record matched, deviated with reason, or unverified for each visual criterion. Keep actual browser observations distinct from source/build evidence and from broader runtime or real-device qualification.

Coordinator evidence (October 6, 2026):

- Used the authenticated application at `http://localhost:5173`, not a static component fixture. Compared the existing conversation before and after at 1586×910 CSS px, 100% visual-viewport scale and DPR 1; reviewed 1100×850 and 390×844 as well. The generated references were compared by application bounds, excluding their browser chrome. Captures and geometry records are ignored under `.local/conversation-refinement/2026-10-06/` in the canonical checkout: `before-main.png`, `after-main.png`, `after-thread.png`, `after-narrow-thread.png`, `after-phone-main.png`, `after-phone-thread.png`, and before/after layout JSON.
- Created a clearly labelled local review conversation with Dispatch, sent a harmless main message and a thread reply, and observed one acknowledgement in each destination. The thread summary updated from one to two replies, with the actual human/agent avatars and last-reply time. Reopening the archived review record retained its messages. The review record is archived, its tab is closed, temporary drafts are cleared, and the original conversation is active. No tools were requested from the review agent.
- Observed thread open/close, selected-parent highlight, participant opening with no agent selected, explicit Developer inspection, collapsed/expanded wiki activity, pointer and keyboard toolbar visibility, Copy feedback/content, and inline mention selection with arrows/Enter and Tab plus Escape dismissal. Enter/Tab selected the mention without sending. Closing the desktop context returned focus to the participant control.
- Main and thread drafts survived tab switching, context closing/reopening, and desktop/phone remounts. A nonzero transcript scroll position (455 px) survived switching away and back. Empty composers disabled sending; the actual main/thread sends cleared their drafts and displayed agent responding/completed transitions. Phone message actions measured 44×44 CSS px. This is browser viewport and keyboard evidence, not physical-device touch or virtual-keyboard qualification.
- Browser review found a wrapped long title misaligning the main/thread headers. The fix truncates desktop titles while retaining the full accessible name and hover title; phones retain wrapping. Both header rules now end at 77 px without tabs and 130 px with the 53 px tab strip. The narrower desktop also shares the 77 px boundary.

| Criterion | Result and observed evidence |
| --- | --- |
| V01 | Matched. Title, avatars, date-divider start and main composer align at x=376 on the recorded desktop; message text and activity use x=436. The composer moved from x=544 to x=376. |
| V02 | Matched. Main composer width increased from 842 to 1178 px with context closed. Opening the 440 px thread keeps the left guide fixed and wraps text. Document width equals viewport width at 1586, 1100 and 390 px. |
| V03 | Matched. Identical short message rows reduced from 84.5 to 66 px; top/bottom margins reduced from 20/24 to 8/8 px. Names and text remain distinct, and idle messages have no enclosing card. |
| V04 | Matched. Idle desktop actions have opacity zero and no layout height. Hover and keyboard focus reveal Reply/Copy without shifting the row; the measured toolbar ends above the body text. Narrow layouts expose 44 px controls. The illustrative more menu is intentionally omitted because no additional action is implemented. |
| V05 | Matched. Actual review replies produce two participant avatars, a persistent two-reply summary and last-reply time. Parents without replies have no empty summary. |
| V06 | Matched for the observed thread. The parent highlights, header boundaries align, and the thread contains the parent and two replies without main-stream duplication. Activity association is preserved in source; no new tool run inside a thread was requested. |
| V07 | Matched. Main composer stays at the bottom; thread composer follows short replies and remains outside the scrolling transcript when space is limited. Placeholders distinguish destinations; arrow-only sending, mention selection and disabled/active draft states were exercised. |
| V08 | Matched. Fresh conversation context is closed. Participants opens with an inspection hint; selecting Developer reveals configuration. Closing thread hides context rather than exposing a default inspector. Idle header has no Ready badge. |
| V09 | Matched. Compact project rows, outlined creation control and aqua/navy selection match the reference intent. Creation, conversation actions, archive and reopening remained reachable. |
| V10 | Matched. Dispatch and Developer have stable distinct glyphs and initials in the existing conversation; review summary and thread repeat the same Dispatch identity. Author names and Agent labels remain visible. |
| V11 | Matched for recorded completed wiki activity. Its collapsed text reads “Developer · searched the wiki”; expansion reveals the actual identifier, arguments and result details. Working/failed variants and specialized Bash/file output were source-reviewed but not induced in this browser review. |
| V12 | Matched visually against both references. Shared Inter, navy/aqua tokens, thin borders, pale sidebar and common composer/control styles are retained. Existing resizable pane widths and the real content determine exact wrapping; illustration-only overflow menus are absent. |

Source/deslop and final diff review passed. `nix develop --command npm run check`, `nix build`, and `nix flake check` passed on Apple Silicon macOS at implementation revision `2628aaa`; later changes record evidence only. Changed local documentation links and whitespace checks passed. No automated tests were added or run. The existing Vite large-chunk advisory remains.

This qualifies the specific observed local flows above. Multi-user access, live thread tool execution, retry/Stop/restart recovery, assistive technology, measured full-surface contrast, browser zoom/font scaling, physical touch and mobile virtual-keyboard behavior remain unverified. Omarchy and the pilot were not deployed by this package.

### Activity author alignment correction — October 6, 2026

Chris identified that tool activity indented the agent's identity beneath the preceding message. The terminal itself should retain its styled-code-block presentation. This corrects WP-028's author layout for activity; its earlier visual evidence covered generic wiki disclosures and source-reviewed specialized tool output without exercising this failure state.

Public messages and activity now share `ParticipantContent` and the `conversation-entry` layout: equal avatar sizing, the same author text and Agent badge, and a separate content column. Every visible activity group has an author regardless of tool type or response outcome. The old smaller activity-only author treatment and container indentation are removed. Terminal/file renderers, native activity, public message identity and actions remain intact. Exact bash-output references are limited to the immediately preceding associated activity by the same author, with date and image boundaries preserved.

Acceptance evidence:

- Reviewed the actual saved failed conversation through an isolated frontend on port 5174, using the existing authenticated backend without starting another runtime or sending messages. At 1586×910 CSS px, human and both agent avatars align at x=376 with width 44; names/content align at x=436 and names use 15 px text. At 390×844, their avatar/content guides align at x=16/56. Document width equals the viewport in both cases. Existing error and tool output remain visible.
- Reviewed the saved successful `pwd` conversation, recorded write/read/edit output, and the compact exact-output reference with Reply/Copy actions. Opening that reference's thread retains its original message and full author identity. Desktop and 390 px thread panels were rendered and inspected; no replies, model requests or tool operations were submitted. Captures are ignored under the task worktree's `.local/activity-author-layout/`.
- Source/deslop and diff review preserve shared native/public history boundaries and reuse existing tokens and controls. `nix develop --command npm run check`, `nix build`, and `nix flake check` passed on Apple Silicon macOS. The existing Vite large-chunk advisory remains; x86-64 Linux was not built. Whitespace and changed-document local links were checked.
- No automated tests were added or run under the repository policy. This focused manual layout review does not qualify live streaming, new-turn failure/recovery, multi-user behavior, assistive technology, full contrast/zoom/font-scaling checks, physical touch or virtual keyboards. No Omarchy deployment is included.

## WP-029 — Personal Wiki connections

**Accepted design, October 6, 2026; specification recorded, implementation not started.** Chris accepted personal Wiki sign-in and explicitly delegated, scoped agent access first, with administrator-controlled shared connections later. The [specification](spec.md#personal-wiki-connections) and [product decision](https://wiki.dispatchworks.ai/wiki/agent-runtime-architecture/#section-personal-wiki-connections) own this behavior. The prior [MCP screenshot](agent-mcp-access-design.md) is preserved with its superseded assumptions identified.

Depends on WP-025's native connection integration and WP-024's participant/access model. Before code work, settle Agent Wiki's delegated provisioning API and scope/ownership contract; credential protection from coding execution; principal/instance granularity; personal-data audiences in shared conversations; and save/conflict/partial-outcome behavior. Existing remote OAuth and operator enrollment are foundations, not completion of those dependencies. Keep current operator-managed Developer access unchanged until a migration is explicitly specified.

Implementation order:

1. Define and provide the Agent Wiki public API for user-authorized provisioning, credential lifecycle, current-rights enforcement, revocation, and idempotent reconciliation. Agent Wiki owns that implementation and contract.
2. Add Dispatch's owner-bound connection records, protected credentials, identity mappings, authorization and audit through its service boundary. Preserve native Pi execution and recovery ownership.
3. Add Settings account authorization and the agent's Add connection/actions flow, with truthful pending, active, expired, failed and revoked states. Resolve shared-use and existing-instance policy before exposing those actions.

Acceptance criteria and evidence to complete with implementation:

- A user authorizes their own verified Wiki account and selects permitted actions without supplying a general admin key or retyping the agent identity. Article and original-evidence access remain distinct.
- Bindings preserve company, user, upstream issuer/account, agent and instance/run identity. Another user's use or copy of a shared definition receives no personal grant. Invocation, configuration, sharing and output audience checks apply at the service boundary.
- Credential and execution isolation prevents models, coding tools, other users, browser responses, Pi definition documents, logs and Git from obtaining provisioning or refresh secrets. Distinct agent credentials cannot exceed the current user's rights, delegation or requested scope.
- Refresh, background work, rights reduction, disconnect and upstream revocation preserve those limits. Denials never fall back to Developer's independent credential. Reauthorization is explicit; prior disclosed content is not claimed to disappear.
- Retried and interrupted provisioning/rotation/revocation reconcile one logical operation. Partial local/upstream failure remains visible, duplicate grants are avoided, and existing instances change only through explicit authorized application. Access is not pinned by a definition revision.
- Shared administrator-controlled connections remain a later feature with an explicit workspace/user policy and scoped provisioning ceiling.
- Review source and the complete diff; run the repository's required TypeScript/build/Nix checks for implementation and review desktop/390 px layouts. Follow the then-current testing policy; today's zero-tests rule remains in force. Record functional, security, recovery and interaction evidence or outstanding qualification here rather than inferring success from builds.

This documentation update establishes design and acceptance criteria only. No OAuth integration, provisioning endpoint, credentials, access grants, runtime change or deployment is implemented or qualified by it.


## WP-030 — Agent editor and existing Wiki authorization

**Implemented October 6, 2026.** Chris authorized the revised editor and MCP screens while deferring Agent Wiki API-based agent registration. The [specification](spec.md#agent-editor-and-existing-wiki-authorization) records the interim standing-agent authority, owner-controlled authorization and explicit shared-definition audience. WP-029 remains unimplemented. Project assignment retains the current conversation flow.

Historical implementation (connection setup superseded by WP-031): the desktop/phone editor, Settings → Connections, `server/wiki-connections.ts`, existing native MCP bindings, and actor-bound idempotent revision saves. Existing operator credentials are preserved. No Agent Wiki code or infrastructure deployment is part of this package.

Acceptance criteria and evidence:

- Source reviewed: compact identity, large instructions, collapsible model/capabilities, only the installed Files and commands option, read-only connection identity, friendly/exact tool names, truthful revision/dirty states, and one fixed save bar. Desktop details are optional and initially hidden in the editor.
- Source reviewed: drafts include capabilities and connection selections; additions/removals are staged with an explicit new-only/existing-instance choice. Saves preserve immutable prior definitions and unrelated instance configuration, retain revision conflicts, and deduplicate same-request retries in Pi's native commit.
- Source reviewed: OAuth metadata/issuer/callback/PKCE/state validation, a same-origin callback relay preserving Strict session cookies, authenticated same-agent verification, encrypted secrets, owner checks, per-definition connection reservation, scoped credential use, rotation uncertainty, and serialized authorize/disconnect transitions. Revocation is not claimed complete before Wiki responds. Native tasks retain unsafe external-write replay semantics.
- Rendered on the actual local service at 1440×1000 and 390×844: editor identity/instructions, fixed actions, capability/model summaries, the existing connected operator card and its nine friendly tool names, Settings empty state, and the Wiki authorization form. Captures remain in the task checkout's ignored `.local/agent-editor/`. The local sign-in used the existing saved passkey. No agent definition, grant, or message was submitted for this visual review.
- Visual review corrected a misleading pristine-draft Unsaved badge. Startup surfaced a strict-JSON migration issue; source now omits optional idempotency properties instead of inserting `undefined` into native documents, and the local service reopened successfully.
- Source/deslop and diff review passed. `nix develop --command npm run check`, `nix build`, and `nix flake check` passed on Apple Silicon at implementation revision `2610226`. Changed-document local links and whitespace checks passed. The existing Vite large-chunk advisory remains; x86-64 Linux was not built for this package. This subsequent documentation change records the evidence only.
- Functional/security qualification remains unverified under the current zero-tests policy: OAuth consent/callback end to end, permissions/revocation/renewal, save/retry/conflict/existing-instance behavior, multi-user boundaries, keyboard/assistive technology, zoom/font scaling, physical touch and virtual-keyboard behavior. Static captures and builds do not establish those outcomes. No tests were added or run; no new Wiki authorization was created. Omarchy was not deployed.


## WP-031 — Generic MCP connections

**October 6, 2026 correction to WP-030.** Chris identified Wiki-specific setup as an implementation mistake. Generic MCP is the intended connection layer; provider-specific provisioning remains separate. The [specification](spec.md#generic-mcp-connection-setup) supersedes WP-030's provider restrictions without changing its editor, owner/reservation or instance-application contract.

Implementation includes generic remote Streamable HTTP setup, OAuth discovery with optional registered clients, bearer tokens, custom headers and unauthenticated servers; server-supplied tool names; honest local-versus-provider disconnect state; and migration of existing Wiki records/bindings with their identity check isolated as compatibility behavior. The official MCP SDK supplies OAuth primitives; stock Pi MCP/Durable retain tool execution and recovery.

Acceptance evidence:

- Source review covers generic URL/authentication validation, encrypted credentials and retry fingerprints, issuer/PKCE/session/callback binding, scope ceilings, single rotating-refresh exchange, ordered disconnect and renewal, migration after runtime ownership, and compatibility with existing definition/binding IDs.
- Source/deslop and complete diff review passed. `nix develop --command npm run check`, `nix build`, and `nix flake check` passed for implementation `dc75c4f` on Apple Silicon macOS. The final run used the command-local `--option eval-cache false` after concurrent Nix evaluation reported a busy cache; no persistent Nix configuration changed. The pinned dependency hash was updated for MCP SDK 1.32.1. All 59 changed-document local links/anchors and whitespace checks passed. The existing Vite large-chunk advisory remains; x86-64 Linux was not built.
- Rendered the authenticated frontend from the isolated worktree at 1440×1000 and 390×844, with shared read-only API access to the unchanged local service. Reviewed the generic OAuth form, expanded client/scope settings and phone header fields including their lower controls. The phone document width was 390 px. Captures are ignored in `.local/generic-mcp/`; no connection, credential, agent revision or message was submitted. The preview is closed. This establishes layout, not new backend behavior.
- No functional, security or migration tests were added or run under the current zero-tests policy. Real-provider OAuth consent, token/header connection, renewal/revocation, migration/restart, shared access and instance application remain unqualified. Screenshots establish layout only; keyboard, assistive technology, measured contrast, zoom/font scaling, physical touch and virtual-keyboard behavior remain unverified.
- No new provider grant or Wiki principal was created for review. Omarchy is not deployed. Chris confirmed his draft was saved and authorized updating the running local app; the connection database/key were privately backed up before rollout.

## WP-032 — Markdown agent instructions

**Accepted October 6, 2026:** Instructions format Markdown while editing and retain rendered formatting in the saved view. The [contract](spec.md#markdown-agent-instructions) extends the shared WP-019 Lexical composer with document editing and uses the existing Markdown viewer for saved instructions.

Acceptance criteria and evidence:

- Reuse the editor's Markdown transforms, plain-text paste, Markdown copy/cut and undo; document mode excludes message submission and participant mentions. Preserve Markdown string storage, existing definition revisions and native Pi configuration.
- Keep the draft/error/save contracts and a 50,000-character serialized limit; oversized content remains editable but cannot be saved. Preserve accessible label/hint/error associations, disabled editing, shared focus styling, and desktop/phone editor sizing.
- Render saved instructions with the existing safe Markdown component, including setup details. Scope surrounding heading styles so they do not override headings inside the document. Do not rewrite existing saved content or create an agent revision for visual review.
- Rendered the isolated frontend against the unchanged local service at 1440×1000 and 390×844. Reviewed Pi Durable's saved instructions and an unsaved layout sample containing headings, lists, emphasis, a quote, inline/fenced code and a link. The phone document width was 390 px; the fixed save bar remained visible. Captures are ignored in `.local/agent-markdown/`. The temporary draft was discarded without saving a definition or sending a message, and the preview tab was closed.
- TypeScript/frontend/service/tooling checks, production builds, `nix build` and `nix flake check` passed on Apple Silicon macOS. Commands used the repository Nix shell with command-local `--option eval-cache false`. The pre-existing Vite chunk-size advisory remains; x86-64 Linux was not built. Source/deslop and final diff review retain one shared editor with an explicit document mode and the existing Markdown renderer; changed-document links were checked. Participant saved instructions use that renderer too; this supporting panel was source-reviewed but not included in the layout captures.
- No tests were added or run under the repository's zero-tests policy. Still-layout review does not qualify editing, paste/copy/cut, undo, keyboard/IME, screen readers, save/conflict/recovery, physical touch, zoom/font scaling or measured contrast; these remain unverified. No Omarchy deployment is included.

## Dependency maintenance — Pi 1.0.4

**October 6, 2026.** Chris requested the newest published Pi Durable dependency after the local shared conversation reported an upstream Codex WebSocket authentication error. The npm `latest` release was 1.0.4. The package manifest and lock now align Pi Durable, Pi AI, Chord, Pi Coding Agent, and Pi MCP at 1.0.4, including their Pi transitive packages. The Nix dependency hash and current-version documentation are updated; historical 1.0.1 implementation evidence remains unchanged.

Acceptance evidence:

- Reviewed upstream 1.0.2–1.0.4 release notes and the installed public interfaces. Dispatch uses the stock `NodeExecutionEnv`, so the newer file-reader, watcher and argv-execution requirements need no custom-environment changes. The application uses no renamed Azure provider imports. No application code or execution-ownership changes were required.
- Source review confirmed Pi's persisted per-conversation provider session IDs, including native initialization for older conversations, and the upstream OAuth refresh correction. These changes do not establish that the reported WebSocket authentication error is fixed.
- The lockfile changes only Pi packages; `npm ls` resolves all directly used Pi packages to one aligned 1.0.4 version. The installation audit reported no vulnerabilities.
- Source/deslop and full diff review, whitespace, 64 changed-document local link targets, `nix develop --command npm run check`, `nix build --no-link`, and `nix flake check` passed on Apple Silicon. The existing Vite large-chunk advisory remains. x86-64 Linux was not built.
- No tests, model requests, credential changes, or browser acceptance flows were run under the current zero-tests policy. Runtime recovery, OAuth renewal, tool behavior and resolution of the observed error remain functionally unverified. The upgrade targets local development; Omarchy is not deployed.

## WP-033 — Agents start in the configured workspace

**Accepted October 6, 2026.** Chris requested the workspace correction after Developer and Pi Durable Expert traced their empty numbered directories to Dispatch’s participant-creation code. This supersedes WP-017’s per-agent directory default while preserving the accepted local execution boundary.

Acceptance criteria:

- Add `DISPATCH_WORKSPACE_DIR` independently of writable runtime state. Root development/built launchers explicitly default it to the repository root; standalone service uses its launch directory. Resolve relative overrides once in service configuration and reject missing/non-directory targets.
- New coding participants, including agents invited to an existing room, receive that directory through native Pi configuration. The existing participant details and Coding prompt use the same saved cwd. Project grouping remains name-only.
- Before recovery, migrate idle native cwd values only when they exactly match the generated legacy path. Keep displayed participant paths in the same native transaction. Preserve custom paths, models, instructions, history, and files. Defer unfinished room tasks, agent tasks, or inbox items until a later idle startup; do not retarget recovered commands.
- Keep native Pi execution/recovery and existing access checks. No automatic clone, worktree creation, cleanup, or concurrency limits. Document shared-checkout coordination and explicit worktree selection.
- Apply source/deslop review, local documentation link/whitespace checks, TypeScript/application builds, `nix build`, and `nix flake check`. No tests or model prompts under the standing policy; migration/tool/recovery functional qualification remains deferred.

October 6 implementation evidence:

- Source/deslop and full diff review confirmed one workspace selection passed through both root launchers, service configuration, new participant creation, and the narrow legacy migration. Migration uses stock Pi documents/configuration and scans for unfinished native tasks before recovery; it changes no execution or concurrency ownership.
- `nix develop --option eval-cache false --command npm run check`, `nix build --no-link`, and `nix flake check` passed on Apple Silicon. Whitespace and 50 local documentation link targets passed. The existing Vite chunk-size advisory remains; Linux was not built.
- No tests, model prompts, or browser acceptance flows were run under the standing policy. New-agent tool execution, explicit overrides, custom-path preservation, busy migration deferral, and recovery remain functionally unqualified. This work targets the M1 Air development service; Omarchy is not deployed.
- After publication, the local launcher was stopped cleanly, its state privately backed up, and the service restarted from the synchronized canonical checkout. Read-only participant inspection in the existing conversation confirmed both Developer and Pi Durable Expert now display the repository root. Their old numbered directories and the Developer clone at `013eff8` remain intact. The saved-path observation does not qualify subsequent tool execution. The ignored capture is `.local/agent-workspace/participant-workspace.jpg` in the canonical checkout.

## WP-034 — Behavior-preserving runtime cleanup

**October 6, 2026.** Chris authorized Developer and Deslop to remove obsolete snapshot consumers, consolidate latest-agent lookups, and clarify lifecycle transitions. No scheduler/performance redesign, API field removal, persisted-state change, or live backend restart is included.

Acceptance evidence:

- Removed the unreachable single-agent context panel branch and its unused native-doc helpers/tab state. Loaded chats still use `SharedContextPanel`; the fallback markup and text are unchanged. Removed the send-settlement effect that inspected always-empty compatibility submissions. POST acknowledgement, uncertain retry IDs, draft-version guards and participant delivery presentation remain unchanged. Compatibility snapshot fields remain in the service and shared contract.
- Consolidated company-scoped latest-definition lookups while retaining append order, archived revisions and caller-specific archive rejection. Historical migration and save-request replay still use their original revision/request lookups.
- Expanded watcher and speaking-turn transitions without changing statement order, coalescing, cancellation, native task ownership or publication policy. Pi remains the execution/recovery owner.
- Deslop independently reviewed the five-file implementation diff and reported no blocking findings. Source/deslop review and whitespace checks passed. `nix develop --option eval-cache false --command npm run check`, `nix build --no-link --option eval-cache false`, and `nix flake check --option eval-cache false` passed on Apple Silicon. The existing Vite large-chunk advisory remains; Linux was not built.
- No tests were added or run under the standing zero-tests policy. Desktop/390 px rendered review was not performed (UI review requirement unverified); no intended rendered change is included. Sending/retry, draft preservation, observation, turn coordination and recovery remain functionally unverified. The live backend was not restarted; no deployment was performed.

## WP-035 — Explicit per-agent text skills

**Authorized October 6, 2026.** Implement the [skills contract](spec.md#explicit-per-agent-skills) with reusable company-scoped immutable text revisions, explicit agent selection, and one native extension. No automatic filesystem discovery or existing-instance migration.

Acceptance criteria:

- Authenticated skill catalog/create/update, revision conflicts and actor/request deduplication use Pi documents in the existing store. Agent revision saves validate company/revision selections and include them in retry identity.
- The editor supports creating reusable text skills without assigning them, selecting/removing skills and explicitly upgrading revisions. Empty selections preserve the previous behavior. Existing instance snapshots remain unchanged.
- Atomically bind full immutable text snapshots on participant creation; advertise and load only those snapshots. Register the extension before recovery, but select its tool only for nonempty bindings.
- Source/deslop review, TypeScript/application builds, Nix builds, whitespace and documentation checks; desktop/390 px rendered review where available. No tests under the standing policy. Runtime, recovery, isolation and interaction outcomes remain unqualified by builds alone.
- File packages/uploads and script materialization remain deferred; do not claim mutable repository paths are pinned packages. No deployment or running-backend restart is included.

Implementation evidence:

- Pi Durable Expert reviewed native snapshot/configuration atomicity, extension registration before recovery, assigned-only lookup and MCP refresh preservation. Deslop implemented/reviewed the controlled skill editor and shared pinned-revision presentation. Integration review fixed compatibility for pre-upgrade agent-save retry fingerprints and tool summaries for skill-only definitions.
- TypeScript/frontend/service/tooling and production application builds passed, as did `nix build --no-link` and `nix flake check` on Apple Silicon. Source/deslop, full diff, whitespace and changed-document local-link review passed. The existing Vite large-chunk advisory remains; Linux was not built.
- No tests, model prompts, live skill saves or API acceptance flows were run. Desktop/390 px rendered review was unavailable in this tool session (UI requirement unverified); contrast, keyboard/assistive technology, touch/virtual keyboards, save/retry/conflict, restart/recovery and access-control behavior remain unqualified by execution. No live backend restart or Omarchy deployment was performed.

Focused manual acceptance, October 6, 2026 (after implementation):

Chris explicitly requested testing the live conversation's proposed skills checks. This authorizes the focused manual observations below; it does not lift the general automated-test deferral. Tested application revision `e49905c16e9d9aafced847d5daec96e75e4161a5` on M1 Air at `http://localhost:5173`, using the existing development service and native Pi runtime. Two clearly named QA agents used GPT-6.1 Sol with Low thinking, no coding tools or MCP connections, and synthetic release facts in separate conversations.

| Check | Observed result |
| --- | --- |
| Explicit assignment | Creating the reusable release-checklist skill left agent A with no assigned skills. Assignment required a separate selection and agent save. |
| Assigned loading | A called `load_skill` and received release-checklist revision 1; its answer used the required Changes/Risks/Rollback headings and `CHECKLIST-V1` marker (conversation `2162`). |
| Empty assignment | B's participant details showed no enabled tools. The same release request reported the skill unavailable without inventing its contents (conversation `2196`). |
| Assigned-only enforcement | After assigning B only a separate notes-formatting skill, a new B instance was explicitly asked to load A's exact skill ID. The actual tool call failed with “This skill is not assigned to this agent instance.” No checklist instructions were returned (conversation `2223`). |
| Explicit upgrade | Saving release-checklist revision 2 left A pinned to revision 1. The editor offered Upgrade; selecting it and saving A created the updated definition. |
| Existing-instance pinning | The original A instance was asked to call `load_skill` again after the upgrade. Its fresh tool result still reported revision 1 and its answer ended with `CHECKLIST-V1` (conversation `2162`). |
| New-instance revision | A newly created A instance loaded revision 2 and answered with `CHECKLIST-V2` (conversation `2330`). The tool's result details confirmed the revision independently of the generated answer. |

The release-checklist fixture is `e5a7b5ae-4755-4fbe-9a1e-afb427214ce5`; fixture names include `QA` and `2026-10-06`. Desktop controls and a 390 × 844 px rendering of the skill editor/library and tool result were inspected; the phone document width and scroll width both measured 390 px. The fixtures and conversations remain available for inspection. Private screenshots and focused UI-state captures are retained in the canonical checkout's gitignored `.local/skills-acceptance-20261006/` directory.

No defects were observed in these checks. This evidence qualifies explicit selection, normal saves, assigned-only lookup and revision pinning for the exercised same-company scenarios. Cross-company isolation, request deduplication/conflicts/retry, removal, in-flight or restart recovery, exhaustive keyboard/assistive-technology support, physical touch devices and Omarchy remain untested. No application source changed, no automated tests or repeat builds were run, and the live backend was not restarted during these checks. Documentation diff, whitespace and local-link review apply to this evidence update.


## WP-036 — Dispatch conversation renaming

**Accepted October 6, 2026:** add Rename to existing conversation actions, as Dispatch display metadata only. See the [display-title contract](spec.md#conversation-display-titles). Depends on shared conversation membership and the existing sidebar/project action menus.

Acceptance criteria:

- Any authenticated human member can save a shared, trimmed 1–200-character title through `POST /api/chats/:id/title`; enforce company/membership access and return the current `ChatSnapshot`.
- Persist a separate native catalog display-title override. Preserve immutable creation-title comparisons, existing automatic-title fallback for unrenamed records, and literal explicit titles including “New conversation”.
- Sidebar, archive and project menus expose Rename with current title, Save name/Cancel, validation and retained input on failure. Saved titles propagate to navigation, headers, search and project lists without changing IDs, messages, context, workspaces or execution.
- Apply source/deslop review, TypeScript and production/Nix builds, diff/whitespace and local documentation-link checks. No tests are authorized. Record actual integration evidence here before claiming completion.
- Desktop and 390 px rendered layout, contrast, keyboard/focus/assistive technology, touch, failure recovery, persistence/restart, authorization and creation retries remain unverified by execution. No backend restart or deployment is implied.

Implementation evidence: integrated frontend/service/tooling TypeScript and production builds (`nix develop --option eval-cache false --command npm run check`), Apple Silicon `nix build --no-link` and `nix flake check` passed. The existing Vite chunk-size advisory remains; Linux was not built. Independent Deslop source review found no blocking issues or needed simplifications. Full diff/whitespace and 52 local documentation file links passed. No tests, model requests, live renames, backend restart or deployment were performed. Rendered desktop/390 px review is unavailable in this tool session and was requested from Chris; this UI requirement and the functional/interaction checks above remain unverified.

## WP-037 — Shared project membership and default agents

Authorized October 6, 2026; [contract](spec.md#shared-project-access-and-default-agents). Preserve legacy private groupings while adding explicit shared projects, manager/member policy, full-history inheritance, default agent selections and operator-controlled read-all-project access. No audience-changing transfer or deployment.

Acceptance: atomic policy edits with revision/request identity; current transaction authorization on reads and actions; current-policy stream delivery and revocation; independent instance snapshots; closed access on missing policy; historical authors do not authorize; old creation retries remain compatible. Controlled editor drafts and desktop/mobile controls must not accidentally save or discard access changes. Source/deslop, TypeScript/application and Nix checks are permitted; tests remain deferred. Rendered UI and functional/security qualification must be reported honestly.

Implementation review:

- Pi Durable Expert implemented the session policy module and transactional collaboration hooks; reviewed historical-author preservation, current policy on all human mutations, missing-project denial, and synchronous SSE authorization/enqueue on the native commit line. Integration fixed revoked nested transaction-draft returns and creation replay scope validation.
- Deslop implemented the controlled project settings component and independently reviewed migration/access expansion. Review simplified receipts to ID/fingerprint only and corrected uncertain chat-create retry to replay its exact saved request rather than dropping its shared-project reference.
- Legacy personal `projectId` preferences and creation fields are not reinterpreted. New shared rooms use a separate reference and start empty; cross-audience transfers are rejected. Read-all is operator configuration, not a UI grant, and does not enable participation/settings changes. No user grant was created during implementation.
- No tests, model prompts, live policy edits or service restart were performed. Rendered desktop/390 px review is unavailable in this tool session (UI review requirement unverified). Functional membership/revocation, in-flight races, restart/recovery, read-all enforcement, keyboard/assistive technology, contrast, touch and layout remain unqualified. This does not qualify Surton restricted-data deployment or coding-tool isolation.
- Final integrated `nix develop --option eval-cache false --command npm run check`, `nix build --no-link --option eval-cache false`, and `nix flake check --option eval-cache false` passed on Apple Silicon. Source/deslop review findings were rechecked by both reviewers and resolved; full diff, whitespace and changed-document local targets were reviewed. The pre-existing large-chunk advisory remains; x86-64 Linux was not built.

- Rebased over the concurrently published conversation display-title rename feature. Preserved rename UI/API and its creation-title identity; rename now uses the same current project participation check inside its mutation transaction, with its action disabled for read-only project observers.

## WP-038 — Name a conversation at creation

**Authorized October 6, 2026.** Add optional naming to the starting-agent chooser, preserving the existing unnamed fallback, project assignment and independent tabs/drafts. See the [display-title contract](spec.md#conversation-display-titles). Depends on WP-036 display titles and WP-037 creation retry handling.

Acceptance criteria:

- All creation entry points expose the optional name with trimmed 1–200-character validation for nonempty input. Empty/whitespace-only input keeps the current automatic-title behavior; explicit “New conversation” remains literal after messages arrive.
- Persist an explicit display-title override atomically at creation. Preserve immutable creation-title retry comparisons, adding an immutable explicit-name flag on new records while retaining legacy replay compatibility. Preserve company/project authorization and native Pi execution ownership; no Pi schema or execution-lifecycle change.
- Creation failures retain name/agent drafts. Uncertain retries replay the original title, agent and project request; cancellation or success clears the chooser draft. Project default-agent selection remains intact.
- Apply source/deslop/runtime review, TypeScript/application and Nix builds, full diff/whitespace and changed-document local-link checks. Record their actual results here; builds do not qualify runtime behavior.
- No tests under the standing policy. Desktop/390 px rendered review, contrast, keyboard/focus/assistive technology, touch, name validation, failure/retry, first-message behavior and restart/persistence remain unverified unless separately observed. No live backend restart or deployment is included.

Implementation evidence:

- Deslop source-reviewed the controlled name field, failed-input retention, changed-name request identity and exact saved-request retries; no blocking findings or useful simplifications remained. Pi Durable Expert identified the omitted-name versus explicit “New conversation” replay ambiguity and rechecked its fix: immutable `creationTitleExplicit` distinguishes new requests independently of mutable display titles, including shared-project creation, while legacy records retain prior replay behavior.
- Documentation diff/whitespace review and 54 local documentation file targets passed. Deployer ran integrated `nix develop --command npm run check`, `nix build`, and `nix flake check` with the explicit-name retry fix included; all passed on Apple Silicon. The existing Vite large-chunk advisory remains; Linux was not built.
- Rendered desktop/390 px review was unavailable and captures were requested from Chris. UI properties and the functional outcomes above remain unverified by execution. No tests, live backend restart or deployment were performed for this package.

## WP-039 — Composer render isolation

**Authorized October 6, 2026:** Chris reported extremely slow typing after the [draft synchronization correction](#october-6-2026--composer-draft-synchronization-regression) and requested a coordinated UI performance tune-up, following the request for focused browser profiling and before/after typing checks. Automated tests remain deferred. This slice targets transcript rendering and reply indexing, not backend execution or a new draft store.

Acceptance criteria and evidence:

- Isolate unchanged transcripts from draft-only workspace updates with stable callbacks and memoized rendering. Index replies once per message-array change rather than scanning all messages for each root. Preserve message order, authorship, streaming, thread summaries and context actions.
- Keep synchronous local draft propagation, latest-text Send behavior, request-ID/edit-version settlement guards, parent-value synchronization and composer-ID isolation. Do not debounce authoritative draft state or weaken access boundaries for speed.
- Compare input-to-paint latency and transcript work before/after under the same browser, build mode, conversation history and streaming conditions; keep raw authenticated traces/captures in ignored `.local/`. Source findings are optimization hypotheses, not measured speedups.
- Review source/deslop/security boundaries and run TypeScript/application/Nix builds, diff/whitespace and changed-document links after profiling so build load does not distort measurements. Review rendered desktop/390 px layouts and focused typing/draft correctness; record observations or gaps here.

Current evidence: workspace draft changes trigger parent renders, and transcript reply summaries scan the message array per root. These source observations do not establish the dominant latency cost or implicate the previous layout-effect correction. Deployer found no browser-tool connection or attachable local Chrome debugging session; authenticated profiling and rendered review require browser access or captures from Chris. Integrated Deslop and Security Engineer source reviews found no blocking findings: standard memoization retains genuine snapshot/thread updates, reply indexing preserves order and empty lists, callbacks retain chat identity, and draft/sync guards are unchanged. Pi Durable Expert reviewed presence/SSE costs; backend snapshot work remains a separate unmeasured candidate, not part of this patch. Deployer independently verified integrated `npm run check` inside Nix, `nix flake check`, `nix build`, and whitespace checks on Apple Silicon; source stayed unchanged during checks. Linux was skipped. Logs remain ignored under the performance worktree's `.local/perf-checks/`. No measured performance improvement, runtime correctness, backend restart or deployment is established.

Post-publication feedback, October 6: after `3859775` was applied locally, Chris reported substantially improved typing responsiveness. This is qualitative user evidence, not a timed before/after profile or full draft-correctness/layout qualification. Retain this focused patch; broader rewrites remain outside this package unless residual lag warrants further profiling.

## WP-040 — Composer files and images

**Authorized October 6, 2026:** Chris requested a lower-left extensible + control for files/images, direct image paste, and top-left prompt previews. The [attachment contract](spec.md#message-attachments) records the agreed limits, audience, retention, supported agent content and request boundaries. Drag-and-drop is not required. Implemented and integrated for source review at `6d7826b`; this entry is not evidence of deployment or working browser behavior.

Acceptance criteria and evidence:

- Main and thread composers offer file/image picking, image paste, compact previews and removal. Preserve Markdown paste, mentions, IME/Enter, Send/Stop and editor identity. Keep immediate sharing/retention documented; removal never claims deletion. The October 7 correction below supersedes the original long UI-disclosure requirement.
- Keep independent in-memory attachment drafts, visible upload failures, no partial send, attachment-only send, same-request retries and newer-draft settlement guards. Preview resources must be released without invalidating another mounted draft.
- Enforce 10 MiB/file, 25 MiB/message and 10 attachments before client upload and at the server boundary. Authorize upload before body parsing; scope reads and send references to current conversation access and only allow the uploader to attach. Generated storage IDs, sanitized names, restricted upload body limit and safe download headers are required.
- Preserve attachment identity through native admission, retries, delivery/history and recovery. Native image blocks use only verified raster formats, capped at 4 MiB/image and 8 MiB/delivery or history/tool read with explicit omission IDs and preserved originals; validated UTF-8 text reads use the scoped attachment tool; binary/PDF/Office remain download-only.
- Apply integrated source/deslop/security review, TypeScript/application checks, `nix build`, `nix flake check`, whitespace and changed-document links. No tests under the standing policy. Review rendered desktop and 390 px states when available; keyboard/focus, clipboard, touch/virtual keyboard, upload failure, draft/send races, access revocation, provider delivery and restart/recovery remain unverified unless separately observed.

Implementation evidence:

- Documentation was reconciled with integrated `6d7826b`: separate Markdown/attachment drafts, corrected chat upload/download routes, metadata-only sends, immediate sharing disclosure, scoped text reads, download-only SVG and model-image caps match the maintained contract. Local file-link and new heading checks passed.
- Deslop's integrated source review found no further blockers after the empty-selection retry guard, visible paste disclosure and Unicode-valid filename truncation were fixed. Security confirmed the integrated upload/read/send boundaries, safe serving, scoped tool, image budgets and server-classified previews at `6d7826b`, with no blockers. These are source findings, not exercised access or recovery outcomes.
- Upload parsing is byte-bounded but buffers multiple representations; peak memory and concurrent-upload capacity are not profiled. Each upload retry can create another retained asset; removing a preview is not cleanup. No TTL, deduplication or automatic orphan sweep is promised. Blobs are flushed before native metadata admission; crashes can leave an unreferenced blob. Backups must retain the complete runtime directory with native metadata and attachment blobs.
- Deployer independently passed integrated `nix develop -c npm run check`, `nix flake check`, `nix build`, and working/staged/branch diff checks at `6d7826b` on Apple Silicon; Linux was skipped. Logs remain ignored in the integration worktree’s `.local/attachment-integrated-*.log`. No tests or runtime qualification are claimed. Rendered desktop/390 px review is unavailable in this session; captures are needed. Clipboard, keyboard/focus/assistive technology, contrast, touch/virtual keyboards, upload failures, draft/send races, provider acceptance, membership/revocation and restart/recovery remain unverified by execution. No live service restart or deployment is included.

Product intent belongs at wiki.dispatchworks.ai; no wiki publication is claimed from this tool session.

### October 7, 2026 — Attachment UI copy correction

Chris requested completely removing the long sharing/retention sentences from the attachment menu and below the composer. This supersedes WP-040's original visible-disclosure criterion, not the immediate-sharing/retention contract. Security confirmed that the prose is not an access control. Keep the boundary in the [usage guide](usage-guide.md#chat-and-workspace), preserve file/image picking, paste, previews, removal/retry and concise status/error labels. Source/build and rendered desktop/390 px evidence for this correction remain pending; no deployment or functional verification is implied.

Source/deslop review, TypeScript/production builds, Apple Silicon Nix build/flake checks and whitespace checks passed for the October 7 paragraph removal. No tests ran. Updated desktop/390 px rendered review remains unverified; new captures are needed.

## WP-041 — Generic AWS container deployment

**Authorized October 7, 2026; AWS qualification pending, LAN OCI signed-out endpoint reported serving.** Chris requested a reusable Terraform/OpenTofu module for ECS Fargate, ALB and S3 Files, with a separate Surton consumer root. The [container deployment contract](spec.md#aws-container-deployment-target) owns scope; the [operator runbook](aws-deployment.md) owns installation/upgrade/restore steps. Preserve existing local and pilot deployments. Preparing the module does not itself authorize applying an AWS plan.

October 7 scaling decision supersedes the interim RDS + ordinary ECS investigation and the earlier per-conversation SQLite + S3 Files proposal: Chris selected the [per-conversation Fargate/Postgres target](spec.md#aws-container-deployment-target), with remote project Git repositories, Wiki notes, ordinary S3 artifacts and disposable workspaces. Frequent commit/push guidance and agent-assisted reconstruction are preferred to preemptive synchronization/snapshot machinery. This is an accepted specification target, not implemented PostgreSQL/worker support, deployment qualification, migration or apply authorization. Existing Web Next behavior remains the baseline.

The prepared single-service module and the criteria/evidence below describe the earlier SQLite/S3 Files candidate; they do not implement or qualify the new target. A follow-on implementation package must settle worker routing/lifecycle, exclusive logical-store ownership, catalog/update guarantees and credential delivery, integrate PostgreSQL through Pi's public storage interface, and define scoped qualification before real-data enrollment. Preserve the historical evidence below rather than converting it into new-target acceptance.

The [historical deployment record](https://wiki.chrisreynolds.me/wiki/portable-application-deployment/#section-dispatch-retirement-approved--september-29-2026) reports same-native-session resumption on a different worker after positive shutdown. [House's architecture](https://wiki.chrisreynolds.me/wiki/agent-house-architecture/) distinguishes independent compute from application authorization and recovery. These are prior implementation evidence, not today's Web Next qualification or a requirement to reuse House. The ownership mechanism remains unresolved; database transactions alone do not establish safe concurrent Pi scheduling, and exclusive ownership does not promise exactly-once external effects.

Acceptance criteria (all pending unless dated evidence below says otherwise):

- Build Linux ARM64 and amd64 Nix OCI artifacts from the existing application package and publish them under one OCI image index, without changing the host package or embedding credentials, state or workspace files. Require separate runtime evidence for each architecture and explicit ECS ARM64 selection for the AWS installation. Record source revision, architecture, build checks, actual image-layer review and published registry digest separately; a macOS package build is not Linux/image qualification.
- Expose a generic module with caller-supplied installation settings and independent module/image pins. No Surton-specific domain, account, backend, credentials or private dependency. Record AWS provider and engine versions and demonstrate format/init/validate/plan under both Terraform and OpenTofu, including a sanitized caller example; HCL alone is not compatibility evidence.
- Review one-owner deployment, stop-before-start replacement, shutdown allowance, persistent state paths and retained-storage/teardown behavior. Review TLS, ALB-only task ingress, health probing, least-privilege execution/task roles, installation access-point scoping, secret delivery and ECS Exec posture. Reject unsupported combinations rather than silently overriding security/runtime settings. Record source reviews and unresolved findings here.
- Provide a separate consumer root with final origin/certificate, provider/region, network/storage/secret references, immutable artifact, budget estimate and reviewed plan. Keep installation details in its owning infrastructure repository; no AWS apply until the actual plan and cost are reviewed and authorized.
- Run [disposable-state SQLite qualification](aws-sqlite-qualification.md) before real data: separate-client ownership exclusion, auth-store startup boundaries, concurrent use, interrupted writes, confirmed task exit/replacement, database integrity, credential/attachment/history continuity and complete backup/restore. Include live task-role negative authorization checks. Record exact revisions, client topology, observations and remaining gaps without secrets. Prior Palm experiments support the choice, not this application's qualification.
- Finalize runbook commands against the actual module/image, including operator initialization without a second live writer, deployment-specific credentials, private invites, upgrade/rollback and destructive-operation boundaries. Run source/deslop/security reviews, affected TypeScript/application/Nix checks, whitespace and changed-document link checks. Only focused deployment/storage qualification is excepted from the general zero-tests policy.

Architecture follow-up: module change `4bbacc1` adds validated `cpu_architecture` (ARM64 default, explicit X86_64) and the aarch64-linux flake output. Terraform/OpenTofu init/validate, Terraform formatting, all-system Nix evaluation, unchanged Apple Silicon build/flake checks and source/deslop/whitespace review passed. ARM image build/execution and index publication remain pending: Omarchy's daemon rejected the untrusted user's invocation-scoped extra-platforms override. No daemon or host permissions were changed. Deployer reports consumer `d07b32a`, pinned to module `80b18e7`: both engines validated the consumer and all four credential-free synthetic plans (Terraform/OpenTofu × ARM64/X86_64) passed with identical 16 additions, no updates/deletions. Architecture selection, zero tasks, 0/100 deployment, UID/GID 65532 and read-only root were verified in the plans; no AWS calls or apply occurred.

Initial amd64 artifact evidence: Deslop reports the Omarchy OCI build passed for exact revision `80b18e7`. Git ancestry confirms it includes the independent-work/public-speaking correction `5d88ec9`, but not the later final-review contribution fix `89cdeb4`. The controlled upgrade below supersedes this initial serving artifact. Security inspected the image config, every layer's filenames and targeted application-layer content patterns with no findings; config matches the module contract. Archive `image-80b18e7-amd64` resolves to `/nix/store/3n1v8s42fzxjhh8drz9jbssh4ilhp4yk-dispatch-web.tar.gz`. This bounded artifact inspection is not an exhaustive audit or container execution. Older `7410e27` evidence remains separate. Deslop subsequently passed isolated amd64 startup/shutdown on this artifact, image ID `sha256:3554bf889980af2d60c76e57f85afe9fbba8fce7a1e064c5929db8c2afccb4f7` (a local image ID, not a registry/index digest): UID/GID 65532, read-only root, all capabilities dropped, no-new-privileges, tmpfs `/data` and `/tmp`, no host mounts, credentials, network access or published ports. `/` returned HTTP 200 with client HTML; Docker stop finished within 30 seconds, exit 0, no OOM. The test container was removed; the image remains loaded and existing services were unchanged. This proves packaging/startup/shutdown only. ARM build/inspection/native execution, persistent-state recovery, conversation recovery, registry/index publication and live AWS storage/IAM qualification remain pending. LAN installation/endpoint evidence follows below.

Omarchy deployment preparation (before the cutover reported below): Chris approved `sudo docker` execution and requested Terraform-managed deployment. Deployer is preparing a separate local consumer configuration and pilot-specific cutover plan; the generic AWS module and Surton apply remain separate. Deslop's authorized `sudo -n docker load` attempt failed because sudo required a password, before image loading. Deployer subsequently verified the existing operator-authorized vault-mediated sudo path with Docker server version 29.8.2; no sudoers changes or credential files were needed. This cleared the invocation-access blocker; subsequent execution and cutover evidence follow above/below. Keep secrets out of arguments/output and shared evidence. No existing service or hostname route changed during preparation.

Local module: Developer published opt-in OCI support in [`terraform-local-dispatch-web` at `f52d6fd`](https://github.com/dispatchlabs-ai/terraform-local-dispatch-web/tree/f52d6fd1f32e25c1113839f1776d17c0d38ad19e). Native remains the default; OCI uses separate identity/state, rejects unmanaged directory/unit/container collisions and caps memory/CPU. Both engines' native/OCI synthetic plans and both playbook syntax checks passed; source/deslop/security review is not installer or systemd failure-path qualification. The module [README](https://github.com/dispatchlabs-ai/terraform-local-dispatch-web/blob/f52d6fd1f32e25c1113839f1776d17c0d38ad19e/README.md#oci-enrollment-operator-only) owns enrollment and maintenance: confirmed service/container exit, same-name hardened helper retaining the image entrypoint, Docker logging disabled for secret invitation output, and restart only after helper exit. Terraform records installation requests, not live drift or teardown; destroy leaves the service running.

LAN cutover result, October 7: Deployer reports OpenTofu installation and pilot-only cutover succeeded; trusted HTTPS serves the new signed-out endpoint. Before switching, the pilot was archived and 21 restored files plus SQLite integrity were verified. Its original data was retained; native Web Next was untouched. Pi Durable Expert closed the cutover source findings after reviewing receipt/hash/route guards and writable disposable restore. This is file-restoration evidence, not application recovery.

Security's read-only host checks confirmed loopback-only publication, restricted installation directories, inactive/disabled pilot, unchanged active native Web Next and matching loopback/trusted-HTTPS signed-out responses. Deslop's filtered live Docker inspection (no environment values) matched the pinned image and reviewed hardening: sole writable `/data` bind, ephemeral `/tmp`, bridge with sole host-loopback publication, 2 GiB memory/memory-swap, 2 CPUs, systemd-owned restart and no host PID/IPC namespace. Security cross-checked the capture with no findings. This closes the serving-container configuration check, not conversation/recovery qualification. The owning [Palm deployment/recovery record at `36ee873`](https://github.com/chrisbyboston/palm/blob/36ee8733c73452cfabeffe3385350cbc20335ae6/docs/dispatch-oci.md) records actual apply, no-change repeat plans, maintenance interruption/recovery and final trusted-HTTPS checks. Deployer then provisioned only the existing Palm-approved provider locally while the OCI owner was stopped; Security accepted that scoped boundary. The volume now contains credentials readable by coding-agent shells. Full-volume backups must include the provider home and use restricted, secret-bearing retention/on-host handling. Credential provisioning is not successful model-execution evidence. The stopped-service helper created and privately delivered an invitation; the service restarted and trusted HTTPS passed. At original cutover, enrollment completion and shared-use qualification remained pending. On October 7, the owning [Palm enrollment record](https://github.com/chrisbyboston/palm/blob/fa6fc59801d09ddaa4640960bfa3680b4fcc7dac/docs/dispatch-oci.md#chris-account-enrollment--october-7-2026) reports completed operator-assisted password/TOTP enrollment, private vault delivery of credentials/recovery codes, and a fresh HTTPS login using the stored credentials followed by verification-session sign-out. The owner subsequently confirmed the login worked. This qualifies that enrollment/login path, not passkey use, successful model execution, two-user use, conversation restart/recovery or independent full OCI-volume application restore.

LAN concurrency upgrade, October 7 (owning [Palm upgrade/recovery record](https://github.com/chrisbyboston/palm/blob/5f7f53f2b086b92a3f899d3be8c50366f9e4749d/docs/dispatch-oci.md#concurrency-upgrade--october-7-2026)): after Chris authorized the newest-code update, Developer confirmed published revision `c2ae69caf0eb53e38c9ecf3fc615e61495ca6a9b` includes `89cdeb4`. Deployer rebuilt amd64; Security approved the bounded config/layer inspection with no findings. Deployer reports OpenTofu replacement now serves image ID `sha256:8217d01871ae989526f66e708be3b09bd5ea0c79ce0db72b5a5de43a8b65ab16` (local ID, not registry digest), with a subsequent empty plan, both HTTPS sites returning 200 and native Web Next unchanged. Security independently accepted the post-upgrade host boundary together with Deployer's filtered live inspection; runtime configuration remains distinct from application qualification. The pre-upgrade current-OCI-volume snapshot independently passed byte/POSIX comparison for 12 files and integrity checks for three SQLite databases; this is file/SQLite evidence, not recovered application behavior. Keep that credentials-bearing snapshot paired with the old image: the new contribution documents/tasks have unqualified image-only downgrade compatibility. Preserve newer state before rollback. Successful conversations, simultaneous shared use and application crash/restore continuity remain unverified.

Portability scope clarification, October 7: Chris wants the option of a one-time, operator-assisted setup migration of agents **and conversations**, not a reusable export/import product feature or ongoing synchronization. The earlier agent-only bundle proposal was too narrow. When requested, inspect the chosen source/destination and recovery sets, preserve participant-private Pi context as well as visible history, and verify the imported configuration/context before continuing work. No transfer has been requested or performed; a migration plan and its credential, identity/access and workspace mappings remain to be reviewed. Back up both installations, preserve historical authorship separately from destination membership, and treat private tool history as potentially credential-bearing. Inspect supported Pi interfaces before choosing selective-transfer mechanics: stopped writers do not make database merging safe, and a wholesale store copy replaces rather than merges destination state.

Omarchy LAN trial boundary (runtime settings inspected above; persistent conversation/recovery qualification remains open): fresh disposable state/accounts, trusted LAN-only HTTPS, one dedicated `/data` bind mount and writable ephemeral `/tmp`; existing installations' state and unapproved personal credentials absent from the container namespace; only explicitly approved shared provider authority may be provisioned into the dedicated volume. Verify actual invocation and mounts: UID/GID 65532, read-only root, dropped capabilities, no privileged mode, added capabilities, Docker socket, broad host mounts or host networking. For LAN hosting, bind `0.0.0.0:3001` inside the container and publish only `127.0.0.1:<host-port>:3001` on bridge networking behind Palm's TLS proxy. Review reachable LAN services; container loopback is not host loopback. The network-disabled tmpfs startup check above does not exercise this hosting boundary. Host permissions are defense in depth, not proof of container isolation. Hostname cutover requires separate authorization and the pilot-specific backup/restore gate in the [deployment scope](spec.md#local-development-and-later-internal-deployment); native Web Next remains untouched. These local-disk checks do not close ARM-native, Fargate or S3 Files qualification gates.

Readiness evidence, October 7:

- The agreed target and scoped testing exception were published in `f0449e9`. Developer integrated the module, OCI recipe, runbook and qualification procedure on `feat/aws-module` at `9484981`, then published the reviewed candidate and IAM name-length correction to `origin/main` through `835d98e`. Publication is not deployment.
- Developer reports Terraform 1.16.5 and OpenTofu 1.12.6 init/validate passed with AWS provider 6.67.0. No live plan/cost review or AWS apply occurred. Deployer subsequently reports Terraform 1.16.5/OpenTofu 1.12.6 synthetic consumer plans against `835d98e`, AWS provider 6.67.0: identical 16 additions, no updates/destruction, zero serving tasks and 0/100 replacement. These credential-free fixtures establish bounded plan compatibility, not live Surton inputs or resource creation.
- Deslop reports unchanged Apple Silicon host-package `nix build`, `nix flake check`, all-system evaluation and whitespace checks passed for OCI recipe `baa814a` (integrated as `9484981`). The initial missing-builder block was resolved: Deslop reports the x86-64 Linux OCI build passed on Omarchy for `90429e0`. Deslop subsequently rebuilt exact application revision `7410e27` on Omarchy. Security Engineer inspected that archive's config, every layer's filenames and targeted application-layer content patterns with no findings; configuration matches the module contract and contains no baked origin/state/credentials. This bounded inspection is not an exhaustive byte audit. Container execution, registry publication/digest and live qualification remain open; rebuild and recheck when application/image source changes.
- Pi Durable Expert reviewed startup/shutdown boundaries and authored the disposable-state procedure (`a987f10`, integrated as `b95e2c7`). Authentication opens before runtime admission; managed MCP initializes after it; shutdown releases ownership before every store closes. Maintenance requires confirmed task exit, not lock release. Procedure source/link/embedded-JS checks passed. The subsequent local WAL-crash probe rehearsal passed on Omarchy with Node 24.21.0 / SQLite 3.51.2; see the [qualification evidence](aws-sqlite-qualification.md). This qualifies probe mechanics only, not container execution, native-work recovery or S3 Files.
- Security reviewed module source: installation-scoped client/direct-read policies, separate execution role, HTTPS/internal ALB defaults, ALB-only task ingress, 0/1 ownership, ECS Exec off and read-only container settings. Security Engineer verified published runbook exposure documentation through `542657c`: direct-read/POSIX bypass and secrets-bearing prefix, noncurrent versions/lifecycle, injected environment secrets, corrected storage egress, ECS Exec and shutdown allowance. The `7410e27` image-layer inspection passed as recorded above; live negative-authorization checks remain pending. A source review is not runtime or blanket security qualification.
- Remaining AWS installation gates: persistent-state/architecture runtime qualification, registry publication/digest, renewed operator AWS SSO, final domain/certificate, caller storage/network inputs and bootstrap transport, reviewed consumer plan/cost, explicit apply authorization, then focused disposable-state recovery/restore/IAM and two-user/ALB qualification. No real-data readiness is claimed.

- Integrated candidate through `90429e0`: TypeScript/application production checks, Apple Silicon `nix build`/`nix flake check`, both-engine schema validation and whitespace passed. Deslop review identified IAM glob characters in the backing prefix; `85942aa` rejects them and simplifies environment-map iteration. Security exposure documentation is included. Omarchy Linux builder reachability was confirmed by Deployer and the `90429e0` OCI build passed as recorded above. Deployer's synthetic consumer plan caught an IAM role name-prefix length failure; `835d98e` fixes it. Both-engine synthetic plan reruns passed as recorded above; live plan/cost review and AWS apply remain pending. Deslop's isolated Docker execution attempt could not load the image because the SSH user lacked socket access; an operator-approved runtime path is needed, not changed Docker permissions.

## Independent work and public contribution correction — October 7, 2026

Implemented and source-reviewed, following Chris's concurrency diagnosis and Pi Durable Expert's design approval. This corrects WP-026's overly broad gate; its historical evidence remains above.

Scope: concurrent provider/tool work, publication-only speaking claims, private unadmitted prose in live/committed/Stop/failure paths, and scoped observation with bounded committed-entry caching. Startup discards obsolete etiquette reservations without cancelling native admitted work. Requester and owner receipts fence abandoned claims. Public receipts and human presence checks remain atomic; stale claims release before successor reconsideration. Stale-post retries under contention remain possible.

Acceptance and evidence:
- Source review covers silence, explicit progress, final publication/replay, cancellation, Stop/failure privacy, upgrade and native recovery. Independent Pi Durable Expert re-review found no remaining blocking source findings and independently passed the Nix-shell application check.
- Observation must retain membership/project-access wakeups and delivery-time authorization. Cache committed immutable entry records plus message/activity-group projections separately from live overlays, never transaction drafts; invalidate on entry commits and clear on close.
- Nix-shell `npm run check` passed (TypeScript and production builds). Apple Silicon Nix build/flake checks passed again after review corrections; whitespace and final diff/deslop review passed. Source simplification removes unused prose switches and new superseded-ID accumulation; historical stored IDs remain compatible. Runtime/usage guidance now reflects publication-only admission.
- No tests, model requests or browser/API acceptance checks run under the current policy. Runtime concurrency, stale-post rates, restart/cancellation and rendered desktop/390 px states remain unverified. No measured performance improvement claimed.
- Implementation `5d88ec91e1ee12e8817482b808cd122434386807` was pushed normally to `origin/main` and remote equality verified. The canonical checkout fast-forwarded at 10:18:58 EDT; the replacement backend process started at 10:18:59 against that revision and the existing state. Startup logs report the service on `127.0.0.1:3001` and Vite on localhost:5173. Pi Durable Expert independently confirmed the clean checkout and replacement processes.
- The initial detached integration attempt sent SIGTERM but reached its 90-second old-process timeout and exited before backup, merge or launch. Its log is retained privately at `.local/dev/integrate-concurrency.log`. Subsequent operational recovery performed the replacement; backup directory `.local/backups/recovery-20261007-101858/dispatch` is present. Backup presence and successful startup do not establish backup completeness, restore correctness, in-flight task recovery or measured concurrency/performance. No additional restart is needed for this documentation-only closeout.

## Preserved contribution review turns — October 7, 2026

Design approved by Chris and Pi Durable Expert; implementation source-approved in `fix/contribution-review`. This supersedes release-before-reconsideration only at final conversational review, not the independent-work boundary.

Acceptance contracts:
- Persist a stable contribution identity, draft, destination/mentions and reviewed cursor before waiting. A conversation-owned background native task owns its reservation; hooks wait for admission/decision, never for its entire lifetime.
- Preserve the turn through final review and atomic publication. With unchanged history, publish without an extra model request. Human composing pauses the candidate; typing alone does not trigger regeneration. Actual human messages can legitimately require another review.
- Release before ordinary research tools, retry/backoff, silence, failure or cancellation. Mixed post/research rounds persist a pending candidate and first seek admission in `afterTools`, when all sibling tools are terminal.
- Bind only a proven native successor: originating generation/assistant/results, committed continuation boundary, continuing original run inputs (post-tools may append inputs), and no reset/termination/new-run replacement. An application marker alone is not proof. Keep publication identity across revisions/recovery.
- Stop explicitly closes contribution reservations and aborts/joins their native tasks without a reviewer/owner dependency cycle. Startup resumes native tasks; provider-call replay remains possible after a crash.
- Source/deslop and independent lifecycle review, TypeScript/application and Nix builds, whitespace/documentation checks required before integration. No tests authorized by this design approval. Runtime attempts/concurrency, interruption/recovery, and desktop/phone behavior remain unverified until separately qualified.

Implementation evidence:
- First source review found and corrected a room/agent native child-ownership mismatch, upgrade self-deadlock from old tickets, reviewed-final replay duplication, old explicit-post receipt compatibility and pre-save validation. A single publication-only post now updates the protected candidate; mixed/multiple-tool rounds release it.
- Generation associations survive published-candidate closure, including replay before Pi settles the final. Final-generation aliases link native activity to the stable original message. Contribution guards/gates are room-owned; Stop explicitly joins the background owners. Chris authorized local integration before remote publication when GitHub rejected pushes with Internal Server Error. Local main fast-forwarded to `89cdeb44b3c6a02fff0a74d0798b18ee3c006781`; the updated service subsequently reported listening on port 3001. This is loaded-source/startup evidence, not recovery qualification.
- Further replay review corrected multi-candidate binding: a generation keeps its original publish/discard association and cannot revise the next queued draft after recovery. Research/retry releases claims while preserving pending candidates; only explicit silence discards the current candidate. Publication-only tool revision is restricted to a single post call, so mixed/multiple calls cannot overwrite one saved candidate.
- Research explicitly invalidates approval of the currently reviewed draft, separately from releasing its reservation. Its tool results must reach a model before publication even if public history is unchanged; untouched queued drafts retain approval. Final-answer or single-post revision records fresh approval.
- Final TypeScript/application and Apple Silicon Nix build/flake checks passed after the approval-state correction. Pi Durable Expert independently passed the Nix-shell application/whitespace checks and found no remaining blocking source findings. Source/deslop review retains native ownership, explicit approval state and immutable generation decisions; 87 local Markdown link targets exist (anchors not checked by that pass). The publication candidate reconciles the later remote documentation commits without changing the running implementation; TypeScript/application and Apple Silicon Nix checks were rerun on that integrated candidate. No tests, model calls, browser acceptance or measured retry/concurrency claims are included.


## WP-042 — Local PostgreSQL Pi Storage adapter

**Requested October 7, 2026; implemented and source/build reviewed, focused runtime evidence in WP-043.** Depends on Pi Durable 1.0.4's public `Storage` contract and the [AWS target](spec.md#aws-container-deployment-target). This is the [local adapter slice](spec.md#local-postgresql-adapter-slice), not the worker deployment topology.

Scope:
- Implement PostgreSQL storage through public Pi interfaces, with explicit logical-store keys in shared tables. Keep Pi responsible for native execution and recovery.
- Offer one adapter through both container and Homebrew PostgreSQL setup. Retain SQLite as the default and use separate disposable local state.
- Preserve existing native and LAN installations. No real-data migration, authentication/connection migration, worker routing/lifecycle, distributed ownership or AWS apply.

Acceptance criteria:
- Source-review every lookup, scan, ID/commit allocation and write for logical-store isolation; preserve atomic batches, metadata/document revisions, fork/history behavior and request deduplication. Preserve opaque JSON and string identities losslessly, including lone UTF-16 surrogates and embedded NULs; reserve root ID 1, mint from 2, advance past committed explicit IDs and enforce JavaScript safe-integer bounds.
- Distinguish definite rejection from an uncertain COMMIT; never retry an uncertain batch or report it as `StorageRejected`. Review consistent multi-query reads (repeatable-read or equivalent serialization, not default `READ COMMITTED` alone) and shutdown draining.
- Review [Pi 1.0.4 storage conformance](https://github.com/earendil-works/pi/blob/v1.0.4/packages/durable/src/testing/storage-conformance.ts) against the implementation without running tests under the current policy.
- Document verified setting names, database requirements, loopback container/Homebrew procedures, separate-state safeguards and the actual local ownership boundary in the [usage guide](usage-guide.md). Do not imply that logical-store isolation supplies worker fencing or authorization.
- Apply source/deslop review, integrated TypeScript/application builds, Apple Silicon Nix build/flake checks, full diff/whitespace and changed-document link checks. Record actual evidence here before claiming completion; builds do not qualify runtime behavior.

Configuration source reviewed October 7: backend/URL/store settings and explicit local-state requirement are implemented; `postgres-store.json` binds the runtime directory to host/port/database path and store ID, without credentials. The existing local runtime-directory lock remains, with an additional per-store advisory lock on the dedicated storage connection. Connection loss/uncertain COMMIT fail closed without reconnect or automatic takeover. URL query parameters/fragments are rejected; remote TLS configuration remains out of scope. Developer reports Nix-shell TypeScript/application builds passed. Pi Durable Expert reviewed adapter/migrations/backend selection/runtime/launchers, confirmed both identified findings resolved with no remaining blocking source findings, and independently passed Nix-shell `npm run check` and whitespace review. Apple Silicon `nix build --no-link` and `nix flake check` passed with the updated locked npm dependency hash; Linux outputs were not built. Documentation relative links/anchors and whitespace checks passed; container/Homebrew commands were not executed.

Source/deslop review retained the upstream 1.0.4 storage semantics and MIT notice, explicit store predicates and one operation queue. It removed redundant metadata initialization reads and separate multi-query shutdown counters; queued repeatable-read operations own their complete read lifetime. Persistent ID reservations use the same connection-health boundary, and PostgreSQL `bigint` decoding rejects unsafe IDs/revisions while commit-sequence exhaustion is handled explicitly. The Nix artifact retains upstream attribution. Source review also fixed the effective default database port to match the local endpoint marker rather than inheriting `PGPORT`.

This work package records source/build approval. Subsequent focused Linux deployment, storage, controlled restart and API-level paired-restore observations are recorded separately in [WP-043](#wp-043--isolated-palm-postgresql-trial); full conformance and interrupted-work recovery remain unverified. No migration is established.


## WP-043 — Isolated Palm PostgreSQL trial

**Authorized October 7, 2026; focused native Linux trial checks passed.** Chris accepted the proposed isolated Palm trial and asked Developer to work with Deployer. This includes focused disposable-data startup, persistence, restart recovery, duplicate-owner/isolation and paired backup/restore checks as an exception to the [testing policy](spec.md#testing-policy); it does not authorize a broad test suite, existing-installation cutover or real-data migration.

Depends on [WP-042](#wp-042--local-postgresql-pi-storage-adapter), initially pinned to `d2ffd0be2d9c9c99d447007ecd6de2762673d18e`. Deployer owns Palm infrastructure and isolated installation; Developer owns application corrections; Pi Durable Expert supports storage/recovery review. Palm's repository owns [installation, artifact pins, secrets handling and recovery evidence at `2da6cdb`](https://github.com/chrisbyboston/palm/blob/2da6cdb/docs/dispatch-pg-trial.md). The isolated endpoint is https://dispatch-pg.chrisreynolds.me.

Scope and acceptance criteria:
- Preserve existing Palm services/data. Use a separate hostname, local application state and PostgreSQL 17 database/store, with one application owner and private host/container-network database access. Keep TLS/HTTPS routing in Palm; do not imply the adapter supports remote database TLS configuration.
- Build and inspect the pinned application/image for the actual target Linux architecture; record revision/artifact identity and actual serving configuration. Prior Apple Silicon checks do not qualify Linux execution.
- With disposable accounts/data, observe startup/sign-in, a conversation and its persisted history, then reopen after a controlled restart. Record exactly what interrupted-work recovery was exercised; do not infer it from an HTTP response or saved transcript alone.
- Reject a competing open of the same store, including from a separate local runtime directory; verify different store IDs remain isolated. For connection-loss checks, confirm old executor/tool termination before reopening. Advisory-lock release is not fencing or automatic-takeover permission.
- Stop the trial owner before backing up PostgreSQL together with complete local auth/connection state, encryption keys and attachment bytes/metadata. Restore the pair into isolated resources and observe restored application behavior. Keep secret-bearing backup material restricted and outside Git/shared evidence; file/database integrity alone is not full application restore qualification.
- Record failures/corrections, permitted checks and remaining gaps here, linking Palm's owning evidence. Source changes require source/deslop review and applicable TypeScript/application/Nix checks; documentation changes require full diff/whitespace and local-link review. Successful trial checks do not qualify AWS, distributed workers, real-data migration or safe automatic takeover.

October 7 browser exception: Chris explicitly requested Developer try the installed `agent-browser` CLI once Deployer completes setup. This authorizes focused browser sign-in, chat/reload and desktop/390 px review of the isolated trial, not a broad browser suite. Keep authenticated captures and sessions in restricted ignored local storage; record observed flows and viewport sizes separately from API/storage evidence. Observed CLI 0.15.1 outcomes are recorded below.

Qualification evidence, October 7, 2026:
- Deployer reports the isolated native Nix/systemd application serves revision `d2ffd0be2d9c9c99d447007ecd6de2762673d18e` on x86-64 Linux, using a separate PostgreSQL 17 container and local state. Existing installations remain unchanged. HTTPS signed-out responses passed from all seven Palm machines, and database reapplication changed nothing. This is native application/Linux evidence, not application OCI or AWS qualification.
- The sanitized storage receipt `.local/postgres-qualification/storage-result.json` was read and independently reviewed by Pi Durable Expert: same-store duplicate-owner rejection, store-local lookups/task scans, atomic rollback, close/reopen persistence and allocator/sequence progress passed. Artifact: `/nix/store/r2ihgkljyb3nwfa3p0gx0q589knklnn6-dispatch-web-0.1.0`; probe SHA-256: `47edc36f19bf47d3c40f5565af9b136e6075e7b8a2e4bb39ed10747ae5bc45c7`. The initial probe's CommonJS resolution failed before database access; the corrected probe follows the declared ESM export. These five checks are focused Storage qualification, not full upstream conformance, process/database-crash recovery or Harness recovery.
- Developer reports API enrollment, human-only chat persistence, duplicate-request handling and attachment-byte checks passed. `agent-browser` 0.15.1 exercised password/TOTP sign-in, sending a human message and persistence after reload. Desktop and 390 px captures remain ignored under `.local/`; the phone rendering had no horizontal overflow and no browser errors were reported. No model requests or interrupted-agent recovery were exercised.
- Deployer reports a trial-only controlled stop, paired backup and restart completed and HTTPS returned. The sanitized `.local/postgres-qualification/application-restart-result.json` receipt confirms saved-session access, persisted chat/attachment bytes and fresh password/TOTP login passed after this controlled restart. Developer also reports the browser reloaded the pre-restart message and connected successfully. An isolated paired restore preserved the endpoint marker and original paths through private namespaces/bind mounts. The read sanitized `.local/postgres-qualification/application-restore-result.json` receipt confirms saved-session access, persisted chat/attachment bytes and fresh password/TOTP login passed through loopback transport retaining the trial HTTPS Origin. This is API-level paired-restore evidence, not browser restore or interrupted-agent recovery. Deployer reports rehearsal processes/container/network and forwarding retired gracefully; private backup/restored files remain on the trial host. This is not off-machine disaster recovery.

Remaining boundaries: full conformance, interrupted-agent/tool and crash recovery, database connection-loss behavior, multi-user authorization, exhaustive accessibility/physical touch, real-data migration, distributed takeover and AWS remain unqualified. Model credentials were not configured and model execution remains unverified; no automatic takeover is supported.

## WP-044 — Focused image generation

**Authorized October 7, 2026; implemented; merge authorized.** Scope follows [image generation and editing](spec.md#image-generation-and-editing). Product history: [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/); the October 7 shared discussion authorizes the skill/tool integration, not a gallery or deployment.

Acceptance criteria:
- Register the direct OpenAI extension before Pi recovery, using public runtime auth, unsafe replay and native cancellation. Retain pre-submission intent and partial evidence; never automatically retry ambiguous paid effects.
- Explicit agent capability selection grants the tool independently of assigned skills; new instances receive an explicit workspace. Existing definitions/instances gain no permissions automatically.
- Seed reusable skill guidance once without assignments or overwriting user revisions. Reference-bounded editing guidance is conditional, not a mandate to apply Dispatch branding to unrelated images.
- Return output paths and bounded metadata rather than adding a generation/review UI. Validate inputs and provider output; preserve prior runs.
- Source/deslop and Pi Durable review, Nix-shell TypeScript/application build, Apple Silicon Nix build/flake checks, whitespace and changed-document link review are required. No tests or live API requests are authorized. Generation/editing, cancellation, restart/recovery, permissions and rendered desktop/390 px capability selection remain unverified until separately reviewed. No deployment is included.

Implementation evidence (October 7):
- Deslop reviewed capability round-tripping, independent assignment and existing-instance preservation. Its blocking seeded-ID finding was corrected to a stable UUID without weakening API validators. Pi Durable Expert reviewed the final lifecycle revision with no remaining blocking integration findings; response-reader lock cleanup followed.
- Nix-shell `npm run check`, Apple Silicon `nix build` and `nix flake check`, and staged/working whitespace checks passed after the final source cleanup. Linux builds were not run. No tests or live provider calls were made for this implementation.
- PNG validation is bounded structural inspection including IHDR/IDAT/IEND, not pixel decompression or CRC qualification. Atomic rename prevents partial final filenames, not orphan temporary files, partially completed runs or power-loss data loss. Workspace path checks do not provide isolation from concurrent service-account filesystem mutation. Metadata contains prompts and reference paths; protect workspace backups.
- No new image-generation/review screen was added. The existing agent editor gains one capability checkbox. Rendered desktop/390 px review, keyboard/touch/contrast and functional acceptance remain unverified; captures are needed before claiming UI qualification. No live service integration or deployment has occurred.

## WP-045 — Agent file publication and generation request correction

**Authorized October 7, 2026; implemented on `feat/agent-files`, pending Chris review.** Chris accepted the attachment route after the generation-only tool exposed its missing delivery path, and reported a live HTTP 400. Scope follows [agent-prepared attachments](spec.md#agent-prepared-conversation-attachments); no new browser UI or automatic paid retry.

Acceptance criteria:
- Snapshot bounded regular workspace files before publication; reject path escapes and special files. Private prepared records are owner-only to agent reads and unavailable to browser downloads until admitted publication.
- Preserve attachment IDs through native tool receipts, contribution revisions, post-tools/final review and recovery. Stop/silence/discard must not release private records. Publication atomically releases only its selected attachments.
- Reuse attachment MIME inspection, message limits and existing image/file rendering. Paths are not browser URLs; no base64 arguments or public workspace route.
- Omit `input_fidelity` from prompt-only generation requests and include safe rejected-parameter diagnostics. Reverse reported a live rejection naming this parameter; no billing conclusion follows from HTTP status alone. Successful final generation/editing remains unverified; no more live probes authorized.
- Source/deslop and Pi lifecycle review, Nix-shell TypeScript/application builds, Apple Silicon Nix checks, whitespace and changed-document links required. No tests added/run by this implementation owner. Live publication, access isolation, Stop/recovery and desktop/390 px rendering remain unverified. No hosted deployment.

WP-045 check evidence: Developer ran `nix develop -c npm run check`, `nix build`, and `nix flake check` successfully on Apple Silicon. The flake reported zero declared checks; Linux systems were omitted. Pi Expert and Deslop source reviews found no blocking findings; whitespace checks pass. These checks do not establish runtime correctness. Reverse performed one live rejected-request probe during investigation despite the no-tests policy; no further probes were run by this implementation owner.
