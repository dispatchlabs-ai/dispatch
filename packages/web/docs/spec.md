# Dispatch Web specification

**Status: local application specification.** The current implementation covers company authentication, native Pi Durable chat, named agent definitions, and the branded desktop/mobile workspace. The October 3 coordinated implementation contracts below settle the first feature set. Later tools, handoffs, schedules, RBAC, and internal deployment still need their own work packages. Functional qualification is deferred under the current [testing policy](#testing-policy).

## Product context

Dispatch Web is a browser workspace for companies doing general-purpose client problem-solving with agents. It uses stock Pi Durable for durable execution and recovery. The maintained product account and previous decisions are linked from the [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/).

## Language and development requirements

Accepted October 3, 2026:

- Use TypeScript throughout the application: browser UI, server integration, Pi Durable extensions, tools, and application workflows. Nix expressions and other declarative build configuration remain in their native formats.
- Support local development, including on M1 Air (Apple Silicon macOS). Developers must be able to edit, run, debug, and test the application locally without deploying to a shared server. Runtime integrations may still need network access and credentials.
- Use Nix for builds and a repository-defined development environment. Pin Nix inputs and JavaScript dependencies in committed lockfiles, and share toolchain/dependency definitions between development and build outputs.
- Produce build artifacts from declared inputs without relying on globally installed Node tooling, developer-specific paths, production credentials, or live application services. Fetch dependencies through declared, pinned inputs; build steps must not download changing dependencies.
- Keep development state and runtime secrets outside build outputs and the Nix store. Build artifacts must remain separate from writable Pi Durable runtime state.

The entry points are `nix develop` for the local toolchain, `nix build` for application artifacts, and `nix flake check` for declared checks. Keep the local edit/run loop inside the development environment; a full Nix build should not be required for every source edit. Future automation must reuse the same build definitions.

Use [Mitchell Hashimoto's shared development/build approach](https://mitchellh.com/writing/nix-with-dockerfiles) and [Pi's Nix flake](https://github.com/earendil-works/pi/blob/b60993bcc299c705731f0281e2b4d0db7c72188b/flake.nix) and [package recipe](https://github.com/earendil-works/pi/blob/b60993bcc299c705731f0281e2b4d0db7c72188b/nix/package.nix) as references. Pi's inspected flake packages its coding agent; it is not a ready-made Dispatch Web development environment.

The local tooling package uses Node 24 from locked nixpkgs, npm workspaces with a committed dependency lock, React Router framework mode (`ssr: false`), React, Vite, and Tailwind. The build includes static HTML/CSS/JavaScript and a persistent Node service, with launchers under `result/bin/`. Base UI provides shared interaction primitives; Dispatch tokens and approved assets define the visual identity. Nix builds do not require NixOS or Docker. Apple Silicon macOS is verified; the declared Linux output still requires a Linux build before deployment support can be claimed.

### Local development and later internal deployment

Accepted October 3, 2026: prioritize a quick localhost edit/run loop now. The frontend binds only to `localhost:5173` and proxies `/api` to the persistent loopback service on port 3001. Source edits hot reload without restarting Pi. Authentication protects user data and operations. Root `npm start` and `npm run preview` serve the built app at the same localhost URL and use the same local state directory; stop the development process first.

Internal deployment on Omarchy, reachable over the Palm network at an HTTPS domain, is a later work package. The current `dispatch.chrisreynolds.me` pilot, DNS, and services remain in place. Local HTTP on loopback is the development endpoint, not an internal hosted site. Application deployment configuration will belong to this repository; machine prerequisites remain owned by Palm.

## Testing policy

**Accepted October 3, 2026.** Do not add or run tests at the current stage. Make enough implementation progress to establish useful, stable behavior before investing in regression coverage. During this exploratory stage, use source review, TypeScript checks, and builds; record functional outcomes that remain unverified.

When the workflows are ready to lock in, prioritize end-to-end tests and API tests that protect observable behavior and service contracts. These are the kinds of tests Chris wants in this codebase. Unit tests and tests that mirror implementation details are not the default; do not add them merely for coverage. Any exception needs a concrete benefit that the preferred test types cannot provide. Do not preemptively build a test framework or add test maintenance work while the product is still changing quickly.

Resume test work only after there is enough useful, stable behavior worth preserving; the current implementation stage remains test-free. This policy supersedes earlier instructions in the handoff and contribution workflow to add tests with every implementation slice or run browser acceptance tests now. A successful type check or build does not establish that runtime behavior has been verified.

## Company access and authentication

**Accepted October 3, 2026.** Dispatch Web is a tool for companies. Access requires an authenticated user session with two-factor authentication (2FA). Support both time-based one-time passwords (TOTP) from authenticator apps and passkeys using WebAuthn/FIDO2.

### Use case: sign in to the company workspace

- **Actor and goal:** a company user signs in to use Dispatch Web.
- **Entry:** opening the application or a link to protected application content without a valid authenticated session presents the login flow.
- **Successful outcome:** after completing the required authentication, the user can access the application with the same initial capabilities as other users in their authorized scope.
- **Incomplete or failed authentication:** do not grant access to protected data, application operations, or live subscriptions. Enforce the authenticated session on the service as well as in the UI; completing only the first step of a two-step flow is insufficient.
- **Session end:** logout or expiry removes access through that session. Use the session policy below for API calls and existing subscriptions.

Support both methods, with at least one complete sign-in method enrolled. A password by itself never grants access.

### Login flow

Offer password plus TOTP, or a passkey with required device PIN/biometric user verification. The service verifies the WebAuthn user-verification result; touch or possession alone is insufficient. Use SimpleWebAuthn for WebAuthn and OTPAuth for TOTP, with opaque server-side sessions.

See [NIST's distinction between single-factor and multi-factor cryptographic authenticators](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/) and [FIDO's passkey overview](https://fidoalliance.org/passkeys/). Passwords are scrypt hashes. TOTP secrets are encrypted with a private key stored separately from the authentication database. Passkey challenges expire and are single-use; TOTP counters are consumed atomically. Authentication endpoints apply persistent attempt limits.

### Equal access now; RBAC later

All users initially have the same application capabilities; there are no differentiated application roles in the initial scope. Users still have individual identities and sessions. Future role-based access control (RBAC) must be possible through a consistent server-side authorization boundary, without changing how users are identified. Role definitions, assignment, and role-management UI are future work.

Each installation serves one company. Accounts have separate identities. Chats are private to their creator within that company; agent definitions are shared within the company. Every service operation receives its company/user scope from the authenticated session. These boundaries do not grant cross-company access.

### Enrollment, recovery, and sessions

An operator provisions an expiring, single-use invitation through the local CLI; there is no public registration or invented application administrator role. The invited user enrolls either a verified passkey or password plus TOTP. A restricted enrollment cookie cannot access chats, agent definitions, or live subscriptions.

Password/TOTP enrollment issues one-use recovery codes. Password plus a recovery code starts restricted re-enrollment and revokes existing sessions; it does not restore application access until a fresh factor is verified. An operator can issue a reset invitation after independently establishing account ownership, including for passkey-only accounts. Completing recovery replaces the old sign-in methods.

Sessions use 256-bit opaque tokens stored as hashes on the service. Cookies are HttpOnly, SameSite Strict, and Secure on HTTPS; only loopback development may use HTTP. Sessions expire after 12 hours absolute or 30 minutes without authenticated requests. Live stream heartbeats do not extend idle expiry. Logout and in-process revocations close subscriptions immediately; snapshots and periodic checks also enforce expiry and changes made by a separate operator process. Existing agent work continues when a session ends.

Account security supports additional/removable passkeys, password/TOTP enrollment or replacement, and session revocation. Factor changes require a sign-in completed within the previous ten minutes. The last complete sign-in method cannot be removed.

## Dispatch branding

**Accepted October 3, 2026.** Use Dispatch's established visual identity throughout the application: official logos and marks, the brand color palette, and typography and other styling defined by the brand materials. Apply it consistently to login, the workspace, chat, supporting views, and future features on desktop and mobile.

Reuse the approved source assets, preserving their proportions and intended background variants. Theme shared components through common design tokens so pages and controls follow the same identity. Responsive layouts may use an appropriate approved logo or mark variant. Keep text, controls, status, and focus indicators readable and distinguishable when applying the palette.

### Existing brand references

The [Dispatch design system's brand guide](https://github.com/dispatchlabs-ai/dispatch-design-system/blob/e4cacb0fbf656ac1ea55a6623cc9cf6b73047e1a/DESIGN.md) defines navy `#1D3D6A`, aqua `#4DD5CF`, ice `#F9FAFC`, slate `#333333`, and white `#FFFFFF`, with Inter for display, headings, and body text. The previous app records [asset provenance](https://github.com/dispatchlabs-ai/dispatch-web/blob/8ab0014bdd69c1585810cdb2099c5aa390843cd2/docs/asset-provenance.md) and [matching tokens](https://github.com/dispatchlabs-ai/dispatch-web/blob/8ab0014bdd69c1585810cdb2099c5aa390843cd2/apps/web/src/styles/dispatch-tokens.css), alongside its primary/inverse horizontal logos and icon mark. Use these traceable sources when integrating the brand; verify later brand changes before adopting them. Their older product workflows and layouts do not override this rebuild's accepted requirements. Font hosting remains an implementation choice.

The initial text-only startup page was provisional and is replaced by the branded application. Original SVG assets and their pinned provenance live in [src/assets](../src/assets/README.md); Inter is served locally from the locked font package. Shared CSS tokens carry the official palette. Do not invent replacement logos or treat component-library defaults as Dispatch branding.

## Desktop and mobile support

**Accepted October 3, 2026.** All user-facing functionality must be usable in desktop and mobile browsers, including authentication, navigation, main work, supporting views, and future features. Each implementation slice must support both from the start. Adapt presentation and interaction to the available space and input method while preserving the user's capabilities.

The desktop workspace uses the columns described below. On narrow screens, navigation, main content, and contextual supporting views may occupy separate surfaces rather than appearing simultaneously. Users must still be able to select main tabs and reach every defined supporting view and action. The supporting context always belongs to the active main tab, even when the main content and supporting view are not visible together.

Support touch as well as pointer and keyboard operation. Required actions must not depend solely on hover, a keyboard shortcut, or precise dragging. Keep controls reachable and content readable with the mobile keyboard open, in either orientation, and when text is enlarged. Avoid unintended page-wide horizontal scrolling; content that intrinsically needs more width may have an explicit local scrolling surface.

Changing viewport size, orientation, or visible workspace region must preserve the active work and unsent input. A responsive layout change must not itself submit, cancel, or restart work. The rule preventing stale supporting content or actions from appearing under a different main tab applies at every size.

The implementation uses navigation panels below 1100 pixels and a contextual panel below 800 pixels, with the main work remaining reachable. Keyboard focus and touch controls use shared primitives. Modern desktop/mobile browsers with WebAuthn are the target; real-device, virtual-keyboard, and browser-matrix qualification is deferred under the testing policy. Native apps, installation, and offline operation have not been specified.

## Workspace layout

**Accepted October 3, 2026.** Use the supplied sketch as the basic desktop workspace layout, with the right side implemented as a full column that can have its own tabs. Adapt its regions for [desktop and mobile support](#desktop-and-mobile-support); simultaneous columns are the desktop arrangement. This layout decision is independent of the local tooling selection.

[![User-supplied workspace sketch showing a left rail, sidebar, main tabs/content, right region, and bottom bar](assets/workspace-layout-reference.jpg)](assets/workspace-layout-reference.jpg)

The sketch establishes the regions and their arrangement. Its sample icons, cards, text, and right-side widgets do not specify product features or final styling. The requirements below refine its right-side treatment.

| Region | Layout responsibility |
| --- | --- |
| Left rail | Narrow, far-left navigation rail. Its initial destinations are Chats, Agents, and Account. |
| Sidebar | Navigation/list area beside the rail, distinct from the main content. It lists saved chats or agent definitions for the selected workspace section. |
| Main content column | Primary workspace with a tab strip across its top and the active main tab's content below. |
| Right contextual column | Full column alongside the main tab strip and content, extending down to the bottom bar. It has its own content area and supports its own tabs. |
| Bottom bar | Horizontal bar beneath the workspace columns. It shows the current company/session and connection state. |

### Right column belongs to the active main tab

The active main tab determines the right column's context, available supporting tabs, and content. Right-column tabs are subordinate views for that main tab. Selecting a right-column tab changes the supporting view while leaving the main tab active.

When the user changes the active main tab, the right column must immediately follow the newly active context. Content, loading results, and actions belonging to the previous main tab must not appear as though they belong to the new one. Closing the active main tab similarly updates the right column for the resulting active tab, or clears its context if no main tab remains. A right-column action must target the main context it visibly serves.

Keep the right region as a full layout column rather than implementing the desktop design as a narrow inspector or overlay drawer. Its first chat views are the conversation’s immutable agent configuration and native run/usage information. Other main tabs supply their own relevant context; do not add unrelated widgets to fill the space. This is consistent with the [earlier contextual-column and reserved-content decisions](https://wiki.chrisreynolds.me/wiki/dispatch-web/#section-decision-records).

### Use case: switch work and its supporting views

A signed-in user activates main tab A and sees its main content and any defined supporting views in the right column. Selecting another right-column tab keeps A active. Activating main tab B changes both the main content and the right column's supporting context to B. Late updates for A must not replace B's supporting content.

Keep desktop columns in their own layout space, with scrolling contained to their content. On smaller screens, panels expose navigation and supporting content. Preserve per-chat drafts and active work when changing layouts or main tabs. Resizable columns and cross-reload persistence of panel preferences are not part of this slice.

## Web architecture

**Implemented direction, October 3, 2026.** The coordinated implementation adopts the earlier SPA/service recommendation and the following concrete contracts.

Use a React SPA with a persistent TypeScript/Node service hosting stock Pi Durable. The localhost frontend now uses React Router framework mode with `ssr: false`, using Vite. The earlier data-mode alternative was not used for this tooling package. Framework mode offers route types, route-module conventions, and code splitting; it does not provide the live agent-state contract. See [React Router's modes](https://reactrouter.com/start/modes) and [SPA behavior](https://reactrouter.com/how-to/spa).

The service serves the built SPA and API on one origin. During local development, run the frontend development server separately from the Pi runtime and proxy application requests to the service. Frontend hot reload must not create another runtime owner or cancel agent work. The web package owns both browser and service code; internal deployment remains a later package.

The recommendation favors consistent patterns for agents: typed and runtime-validated API contracts, a standard route-module pattern, one live-state subscription layer, and one shared set of UI primitives. Routing-level loading and one-shot commands should use documented patterns; ongoing Pi state should flow through the subscription layer. Client caches are derived views, not independent durable sources of truth.

Durable execution always has an appropriate persistent owner, independently of the browser rendering framework.

## First agent-work workflow and observable outcomes

**Accepted October 3, 2026.** Implement chat first, directly on stock Pi Durable, with one default agent configuration. Chat is the first usable feature in the broader agent workspace. It must meet the existing company-login, desktop/mobile, and workspace requirements.

### Use case: chat with the default agent

- **Actor and goal:** an authenticated company user works with the default agent through a conversation.
- **Entry:** the user starts a new conversation or reopens an existing conversation within their authorized scope.
- **Successful outcome:** the user sends messages, sees streamed responses, and continues the conversation with its saved history.
- **Control:** the user can stop a response. The UI must distinguish a stopped or failed response from a completed answer; Stop invokes native foreground cancellation, including queued follow-ups, and preserves committed partial output.
- **Continuity:** history persists across reloads. Browser disconnection does not cancel admitted work; reconnection restores the current committed state. The service resumes native work when reopening its storage; functional recovery qualification is deferred under the testing policy.

The default agent uses Pi's normal per-conversation agent configuration. Each chat is an independent Pi conversation with its own history, agent configuration, and ongoing work. Selecting the default configuration for multiple chats must not combine their conversation state. The initial agent has general-purpose instructions and no tools. Explicit service configuration selects its model/thinking level, otherwise existing Pi defaults apply. Named definitions provide the editable configuration surface after the default chat foundation.

Keep Pi's transcript and execution distinctions intact through the integration, including tool activity and other native entry types. The initial UI can expose a small subset of capabilities, but its model must not flatten the underlying conversation into only user/assistant text or create a competing durable history. Tool capabilities selected for the first agent must have whatever interaction and controls their use requires.

### Feature sequence and broader scope

After chat, add named agent definitions and the ability to start independent conversations from them. A reusable definition supplies configuration for new conversations; it is distinct from any one running conversation. The catalog, editor, versioning, and update policy are Dispatch features built on Pi's native configuration. Definitions are company-shared, versioned immutably, and copied into new conversations. Editing or archiving a definition never changes an existing conversation. Stale edits return a conflict; archived definitions cannot be used for new chats or silently restored by editing.

Continue adding Pi Durable capabilities in focused feature slices: tools and integrations, delegation and handoffs, background work, event- and schedule-triggered work, and the broader native configuration surface. These remain product goals. Their order after named definitions and their detailed workflows are unresolved; the [capability assessment](https://wiki.chrisreynolds.me/wiki/pi-durable-capabilities/) records the native foundations and application responsibilities.

Design the first chat around Pi's public interfaces and the ownership boundaries below. Add later features' detailed behavior and UI when their use cases are agreed. The right column remains available for specified supporting views; chat-first scope does not invent content for it.

## Contracts and state ownership

**Accepted ownership boundaries for chat:**

- The browser owns presentation and temporary interaction state, such as panel selection and unsent input.
- The application service owns authentication/authorization, request validation, transport, and application integration with Pi's public interfaces. Browser code does not receive server credentials or direct storage access.
- Pi Durable owns durable conversation/task state, execution, and recovery. Application code should not recreate Pi's execution engine or maintain a competing durable conversation store.

**Runtime arrangement:** each Pi storage directory has one owning process, enforced by an OS-backed SQLite exclusive lock for its lifetime. Independent development instances use separate storage. This does not limit concurrent agents within a runtime.

Share TypeScript contracts across browser and service. Validate JSON commands with Zod at the HTTP boundary; authentication verifies its own input through the same same-origin boundary. REST endpoints map to native Pi operations and SSE emits complete native conversation snapshots. [runtime.md](runtime.md) documents ownership, recovery, and request identity; the [usage guide](usage-guide.md#application-api) lists the API.

## Failure and recovery behavior

**Accepted chat outcomes:**

- Browser refresh, navigation, or disconnection stops observation only; admitted agent work continues under the service/runtime lifetime. Explicit user cancellation is a separate operation.
- History persists, and reconnecting restores the current committed conversation state. The service reopens Pi and invokes its public recovery interface. Runtime qualification is deferred under the testing policy.

**Implementation contracts for those outcomes:**

- On initial connection or reconnection, restore the current committed Pi view and then apply subsequent updates through one subscription layer. Pi's watch APIs may coalesce updates and do not promise replay of missed events; do not assume a replay cursor or an exactly-once event feed. Replace derived browser state with each current snapshot, and bind all updates/actions to the active conversation. A slow subscriber retains only the latest pending complete snapshot.
- A retry of the same logical submission reuses its request ID within the correct conversation and authorization scope. Distinct submissions receive distinct IDs; reusing an ID with changed content returns 409 rather than silently accepting different intent. Native submission deduplication does not make external tool effects exactly once; effect-specific retry/reconciliation rules depend on the chosen workflow.
- A service restart reopens storage, reinstalls the required implementations, and resumes work through Pi's public recovery interfaces. The browser can reconnect to the recovered state. Do not equate reopening storage alone with a completed recovery implementation.

These contracts follow [Pi's public README](https://github.com/earendil-works/pi/blob/b60993bcc299c705731f0281e2b4d0db7c72188b/packages/durable/README.md) and the [maintained capability assessment](https://wiki.chrisreynolds.me/wiki/pi-durable-capabilities/). The implementation pins Pi Durable 1.0.1 and uses its public interfaces. An interrupted provider request may be retried from the committed checkpoint, not from the exact final streamed token, and can incur another provider request. External-effect recovery belongs to later tool workflows.

## Acceptance

The first workflow is chat, followed by named definitions. Record work-package outcomes, source/type/build evidence, and unverified behavior in [handoff.md](handoff.md). Follow the [testing policy](#testing-policy); there is no separate validation plan.

## Implementation contracts — October 3, 2026

Chris authorized coordinated implementation of the discussed requirements, using subagents where useful. The coordinator will integrate the work packages without stopping for approval between them, using only the checks permitted by the testing policy. These implementation defaults resolve the previously open first-release contracts; later Omarchy deployment, RBAC, and unspecified tools/handoffs/schedules remain deferred.

- One company per installation. Each account has an independent identity; chats are private to their company and creator. All users have equal capabilities. Named agent definitions are shared within the company and can be maintained by any fully authenticated user.
- Offer password plus TOTP, or a passkey requiring verified device user verification. Provision accounts through expiring, single-use operator-generated invitations. Enrollment and recovery cookies never grant application access. Password plus a one-use recovery code, or an operator-issued reset invitation, permits fresh factor enrollment before access is restored. No email service is required.
- Sessions use opaque HttpOnly cookies, SameSite Strict, and Secure on HTTPS; local loopback HTTP remains supported. Sessions expire after 12 hours absolute or 30 minutes idle. Revocation and expiry apply to API calls and live subscriptions. Credential endpoints enforce persistent abuse controls; TOTP counters and WebAuthn challenges are consumed atomically.
- Run a persistent TypeScript/Node service separately from frontend hot reload. Hold an OS-backed SQLite exclusive lock for each runtime directory so only one process owns that storage; this does not limit concurrent agents. Independent development instances use separate storage.
- Browser commands use validated JSON REST endpoints, authenticated through the same service boundary. SSE subscriptions send full snapshots of the current native Pi conversation view and native submission records. Reconnection replaces the prior view; no event replay cursor is assumed. Reuse the request ID when retrying the same logical command. Closing a tab or stream stops observation only.
- Stop targets the active foreground response. Native cancellation/failure records distinguish stopped, failed, running, and idle states. On service restart, reinstall runtime implementations and invoke Pi recovery; an interrupted provider request may resume from its committed checkpoint rather than its exact last streamed token.
- Start with a chat-only default agent and server-side provider credentials. Prefer explicit server configuration, then the existing Pi provider/model defaults. Named definitions configure instructions, provider/model, and thinking level. Save immutable revisions, enforce revision conflicts, and copy the selected configuration into each new conversation. Editing or archiving a definition does not alter existing conversations.
- Use Base UI shared primitives with Dispatch tokens and original logo artwork. Desktop has the accepted rail/sidebar/main tabs/contextual right column/bottom bar. Narrow screens expose navigation and contextual content in accessible panels. Keep per-chat drafts and selected work while changing layouts. The active chat's immutable agent configuration and native run/usage information define the first right-column views; other main tabs use their own context.
