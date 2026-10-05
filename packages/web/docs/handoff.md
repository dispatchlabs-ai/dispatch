# Dispatch Web implementation handoff

The local implementation covers company authentication, stock Pi Durable chat, the branded desktop/mobile workspace, and named agent definitions. [spec.md](spec.md) defines the current contracts; [usage-guide.md](usage-guide.md) explains operation. The [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/) maintains product intent and decision history.

## Current testing policy

Chris requested **zero tests during this stage**, then clarified that future coverage should focus on end-to-end and API tests once useful behavior is stable enough to lock in. Follow the [testing policy](spec.md#testing-policy). Do not add or run tests, smoke checks, or browser acceptance procedures now. Source review, TypeScript checks, and builds are permitted. The acceptance outcomes below define intended behavior; they are not permission to start test work.

No test suites or test frameworks are retained. Functional, security-flow, recovery, and real-device qualification of the integrated revision remains deferred. Successful type/build checks do not establish those outcomes. Earlier WP-001 evidence is historical.

## UI/UX review follow-up

Chris requested an independent Claude review after the integrated build. The [October 3 review](ui-ux-review.md) combines source inspection with 13 authenticated desktop and 390×844 phone screenshots. This specifically authorized visual review does not qualify keyboard, touch, authentication, recovery, or streaming flows and does not lift the zero-tests policy.

The original review recorded deviations in readability/contrast, shared design tokens, truthful connection status, and account-form state preservation, plus additional navigation, tab visibility, defaults, and content-hierarchy gaps. The subsequent [WP-006](#wp-006--resolve-the-uiux-review-findings) implements the accepted fixes; the review document preserves the historical findings and their resolution status. Apply the accepted [UI implementation rules](spec.md#ui-implementation-rules) to subsequent UI work; session-expiry draft retention and in-place identity re-checks remain proposed decisions. Screenshots stay in the canonical checkout's ignored `.local/ui-ux-review/2026-10-03/` directory.

## Decisions and ownership

- Use TypeScript, React Router framework SPA mode, React/Vite/Tailwind, and shared Base UI primitives with original Dispatch artwork and local Inter.
- Keep a persistent Node/Hono service separate from frontend hot reload. One process owns each Pi directory, enforced by an OS-backed SQLite ownership lock without limiting concurrent agents.
- Use stock Pi Durable 1.0.1 through its public interfaces. Pi owns admission, native entries, execution, cancellation, and recovery. Dispatch owns identity, access checks, transport, and presentation.
- Serve one company per installation. Users have equal capabilities, private chats, and shared agent definitions. Role-based access control remains future work.
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
