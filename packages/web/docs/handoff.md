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
- Prioritize local development. Omarchy deployment, pilot retirement, tools/integrations, handoffs, background triggers, and schedules are deferred to separately specified packages.

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
- Known-invalid factor removal is unavailable with an explanation. Enrollment captures a recognizable passkey label. New agent drafts use the service default model and thinking level.
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
