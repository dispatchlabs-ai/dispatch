# Dispatch Web implementation handoff

The local implementation covers company authentication, stock Pi Durable chat, the branded desktop/mobile workspace, and named agent definitions. [spec.md](spec.md) defines the current contracts; [usage-guide.md](usage-guide.md) explains operation. The [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/) maintains product intent and decision history.

## Current testing policy

Chris requested **zero tests during this stage**, then clarified that future coverage should focus on end-to-end and API tests once useful behavior is stable enough to lock in. Follow the [testing policy](spec.md#testing-policy). Do not add or run tests, smoke checks, or browser acceptance procedures now. Source review, TypeScript checks, and builds are permitted. The acceptance outcomes below define intended behavior; they are not permission to start test work.

No test suites or test frameworks are retained. Functional, security-flow, recovery, and real-device qualification of the integrated revision remains deferred. Successful type/build checks do not establish those outcomes. Earlier WP-001 evidence is historical.

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
