# Dispatch Web specification

**Status: partial specification.** The foundational requirements and chat as the first feature are accepted. Chat will use stock Pi Durable with a default agent, followed by named agent definitions and further native capabilities. The localhost tooling package is implemented; detailed chat contracts and later work packages remain to be agreed. Unresolved details are not accepted contracts.

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

The local tooling package uses Node 24 from locked nixpkgs, npm workspaces with a committed dependency lock, React Router framework mode (`ssr: false`), React, Vite, and Tailwind. The frontend artifact is static HTML/CSS/JavaScript at `result/share/dispatch-web` after `nix build`. A component library and server integration remain to be selected. Nix builds do not require NixOS or Docker. Apple Silicon macOS is verified; the declared Linux output still requires a Linux build before deployment support can be claimed.

### Local development and later internal deployment

Accepted October 3, 2026: prioritize a quick localhost edit/run loop now. The frontend binds only to `localhost:5173`, with hot reload and a clear startup page. This tooling slice has no user data, login, chat, or Pi runtime. It does not relax the authentication requirements for future product functionality. Developers can preview a production build on `localhost:4173`.

Internal deployment on Omarchy, reachable over the Palm network at an HTTPS domain, is a later work package. The current `dispatch.chrisreynolds.me` pilot, DNS, and services remain in place. Local HTTP on loopback is the development endpoint, not an internal hosted site. Application deployment configuration will belong to this repository; machine prerequisites remain owned by Palm.

## Company access and authentication

**Accepted October 3, 2026.** Dispatch Web is a tool for companies. Access requires an authenticated user session with two-factor authentication (2FA). Support both time-based one-time passwords (TOTP) from authenticator apps and passkeys using WebAuthn/FIDO2.

### Use case: sign in to the company workspace

- **Actor and goal:** a company user signs in to use Dispatch Web.
- **Entry:** opening the application or a link to protected application content without a valid authenticated session presents the login flow.
- **Successful outcome:** after completing the required authentication, the user can access the application with the same initial capabilities as other users in their authorized scope.
- **Incomplete or failed authentication:** do not grant access to protected data, application operations, or live subscriptions. Enforce the authenticated session on the service as well as in the UI; completing only the first step of a two-step flow is insufficient.
- **Session end:** logout or expiry removes access through that session. Exact timeouts, reauthentication, revocation, and treatment of existing subscriptions must be defined before implementation.

Support for both methods is required at the product level; whether users must enroll both methods is still open.

### Login flow under discussion

**Proposed, not yet accepted:** offer password plus TOTP, or a passkey with required device PIN/biometric user verification. In the passkey flow, the server must verify the WebAuthn user-verification result; possession or a touch-only assertion is not sufficient by itself to meet the two-factor requirement. A verified passkey can combine possession and local user verification in one interaction. The alternative under discussion is a password followed by either TOTP or a passkey.

See [NIST's distinction between single-factor and multi-factor cryptographic authenticators](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/) and [FIDO's passkey overview](https://fidoalliance.org/passkeys/). The choice of authentication library/provider, credential storage, and exact login/enrollment flow remains unresolved.

### Equal access now; RBAC later

All users initially have the same application capabilities; there are no differentiated application roles in the initial scope. Users still have individual identities and sessions. Future role-based access control (RBAC) must be possible through a consistent server-side authorization boundary, without changing how users are identified. Role definitions, assignment, and role-management UI are future work.

Equal capabilities do not define which companies, workspaces, or resources a user can access. Company membership and isolation, including whether deployments serve one or multiple companies, remain to be specified independently of RBAC. No cross-company access is implied.

### Open authentication workflows

Before implementing authentication, specify account provisioning/invitations, enrollment and replacement of authenticators, lost-device/account recovery, required enrollment methods, and session policy. Recovery must not silently bypass the required authentication. Initial equal access also leaves user-management authority to be specified; do not invent an administrator role to fill that gap.

## Dispatch branding

**Accepted October 3, 2026.** Use Dispatch's established visual identity throughout the application: official logos and marks, the brand color palette, and typography and other styling defined by the brand materials. Apply it consistently to login, the workspace, chat, supporting views, and future features on desktop and mobile.

Reuse the approved source assets, preserving their proportions and intended background variants. Theme shared components through common design tokens so pages and controls follow the same identity. Responsive layouts may use an appropriate approved logo or mark variant. Keep text, controls, status, and focus indicators readable and distinguishable when applying the palette.

### Existing brand references

The [Dispatch design system's brand guide](https://github.com/dispatchlabs-ai/dispatch-design-system/blob/e4cacb0fbf656ac1ea55a6623cc9cf6b73047e1a/DESIGN.md) defines navy `#1D3D6A`, aqua `#4DD5CF`, ice `#F9FAFC`, slate `#333333`, and white `#FFFFFF`, with Inter for display, headings, and body text. The previous app records [asset provenance](https://github.com/dispatchlabs-ai/dispatch-web/blob/8ab0014bdd69c1585810cdb2099c5aa390843cd2/docs/asset-provenance.md) and [matching tokens](https://github.com/dispatchlabs-ai/dispatch-web/blob/8ab0014bdd69c1585810cdb2099c5aa390843cd2/apps/web/src/styles/dispatch-tokens.css), alongside its primary/inverse horizontal logos and icon mark. Use these traceable sources when integrating the brand; verify later brand changes before adopting them. Their older product workflows and layouts do not override this rebuild's accepted requirements. Font hosting remains an implementation choice.

The local startup page's current text-only name, green palette, and system font are provisional tooling styles, not the approved Dispatch identity. Before branding is implemented, verify the existing source assets and palette, record their provenance with the package, and resolve any missing typography or usage rules from the brand materials. Do not invent replacement logos or treat a component library's defaults as Dispatch branding.

## Desktop and mobile support

**Accepted October 3, 2026.** All user-facing functionality must be usable in desktop and mobile browsers, including authentication, navigation, main work, supporting views, and future features. Each implementation slice must support both from the start. Adapt presentation and interaction to the available space and input method while preserving the user's capabilities.

The desktop workspace uses the columns described below. On narrow screens, navigation, main content, and contextual supporting views may occupy separate surfaces rather than appearing simultaneously. Users must still be able to select main tabs and reach every defined supporting view and action. The supporting context always belongs to the active main tab, even when the main content and supporting view are not visible together.

Support touch as well as pointer and keyboard operation. Required actions must not depend solely on hover, a keyboard shortcut, or precise dragging. Keep controls reachable and content readable with the mobile keyboard open, in either orientation, and when text is enlarged. Avoid unintended page-wide horizontal scrolling; content that intrinsically needs more width may have an explicit local scrolling surface.

Changing viewport size, orientation, or visible workspace region must preserve the active work and unsent input. A responsive layout change must not itself submit, cancel, or restart work. The rule preventing stale supporting content or actions from appearing under a different main tab applies at every size.

Exact breakpoints, mobile navigation and tab presentation, transitions between main and supporting views, and the supported browser/device matrix remain to be agreed before the affected implementation. Native apps, installation, and offline operation have not been specified.

## Workspace layout

**Accepted October 3, 2026.** Use the supplied sketch as the basic desktop workspace layout, with the right side implemented as a full column that can have its own tabs. Adapt its regions for [desktop and mobile support](#desktop-and-mobile-support); simultaneous columns are the desktop arrangement. This layout decision is independent of the local tooling selection.

[![User-supplied workspace sketch showing a left rail, sidebar, main tabs/content, right region, and bottom bar](assets/workspace-layout-reference.jpg)](assets/workspace-layout-reference.jpg)

The sketch establishes the regions and their arrangement. Its sample icons, cards, text, and right-side widgets do not specify product features or final styling. The requirements below refine its right-side treatment.

| Region | Layout responsibility |
| --- | --- |
| Left rail | Narrow, far-left navigation rail. Its destinations remain to be specified. |
| Sidebar | Navigation/list area beside the rail, distinct from the main content. Its content and relationship to rail selection remain to be specified. |
| Main content column | Primary workspace with a tab strip across its top and the active main tab's content below. |
| Right contextual column | Full column alongside the main tab strip and content, extending down to the bottom bar. It has its own content area and supports its own tabs. |
| Bottom bar | Horizontal bar beneath the workspace columns. Its controls and information remain to be specified. |

### Right column belongs to the active main tab

The active main tab determines the right column's context, available supporting tabs, and content. Right-column tabs are subordinate views for that main tab. Selecting a right-column tab changes the supporting view while leaving the main tab active.

When the user changes the active main tab, the right column must immediately follow the newly active context. Content, loading results, and actions belonging to the previous main tab must not appear as though they belong to the new one. Closing the active main tab similarly updates the right column for the resulting active tab, or clears its context if no main tab remains. A right-column action must target the main context it visibly serves.

Keep the right region as a full layout column rather than implementing the desktop design as a narrow inspector or overlay drawer. Its contents remain to be specified: do not populate it with generic details, activity, or other views simply to fill the space. This is consistent with the [earlier contextual-column and reserved-content decisions](https://wiki.chrisreynolds.me/wiki/dispatch-web/#section-decision-records).

### Use case: switch work and its supporting views

A signed-in user activates main tab A and sees its main content and any defined supporting views in the right column. Selecting another right-column tab keeps A active. Activating main tab B changes both the main content and the right column's supporting context to B. Late updates for A must not replace B's supporting content.

Column widths, resizing, collapse/visibility behavior, exact mobile presentation, scroll ownership, keyboard interaction, and persistence of each main tab's selected supporting tab remain unresolved within the accepted desktop/mobile requirements. No specific right-column tab names or features are accepted yet.

## Proposed web architecture

**Status: proposal, discussed October 3, 2026.** This records the architecture recommendation and independent Claude Code review. React Router framework mode was subsequently used for the localhost tooling package. The service/runtime arrangement and detailed contracts below remain proposed.

Use a React SPA with a persistent TypeScript/Node service hosting stock Pi Durable. The localhost frontend now uses React Router framework mode with `ssr: false`, using Vite. The earlier data-mode alternative was not used for this tooling package. Framework mode offers route types, route-module conventions, and code splitting; it does not provide the live agent-state contract. See [React Router's modes](https://reactrouter.com/start/modes) and [SPA behavior](https://reactrouter.com/how-to/spa).

The service can serve the built SPA and API on one origin. During local development, run the frontend development server separately from the Pi runtime and proxy application requests to the service. Frontend hot reload must not create another runtime owner or cancel agent work. Package/deployment boundaries remain undecided.

The recommendation favors consistent patterns for agents: typed and runtime-validated API contracts, a standard route-module pattern, one live-state subscription layer, and repeatable browser acceptance checks. Routing-level loading and one-shot commands should use documented patterns; ongoing Pi state should flow through the subscription layer. Client caches are derived views, not independent durable sources of truth.

Next.js remains an alternative if later workflows justify server rendering. It is not inherently incompatible with Pi Durable; whichever web framework is used, durable execution must have an appropriate persistent owner.

## First agent-work workflow and observable outcomes

**Accepted October 3, 2026.** Implement chat first, directly on stock Pi Durable, with one default agent configuration. Chat is the first usable feature in the broader agent workspace. It must meet the existing company-login, desktop/mobile, and workspace requirements.

### Use case: chat with the default agent

- **Actor and goal:** an authenticated company user works with the default agent through a conversation.
- **Entry:** the user starts a new conversation or reopens an existing conversation within their authorized scope.
- **Successful outcome:** the user sends messages, sees streamed responses, and continues the conversation with its saved history.
- **Control:** the user can stop a response. The UI must distinguish a stopped or failed response from a completed answer; precise cancellation scope and error presentation remain to be defined.
- **Continuity:** history persists across reloads. Browser disconnection does not cancel admitted work; reconnection restores the current committed state. Verify service-restart recovery as part of the first chat feature.

The default agent uses Pi's normal per-conversation agent configuration. Each chat is an independent Pi conversation with its own history, agent configuration, and ongoing work. Selecting the default configuration for multiple chats must not combine their conversation state. The initial model, instructions, and tools remain to be chosen; a user-facing agent editor is not required for this first feature.

Keep Pi's transcript and execution distinctions intact through the integration, including tool activity and other native entry types. The initial UI can expose a small subset of capabilities, but its model must not flatten the underlying conversation into only user/assistant text or create a competing durable history. Tool capabilities selected for the first agent must have whatever interaction and controls their use requires.

### Feature sequence and broader scope

After chat, add named agent definitions and the ability to start independent conversations from them. A reusable definition supplies configuration for new conversations; it is distinct from any one running conversation. The catalog, editor, versioning, and update policy are Dispatch features built on Pi's native configuration. Define those contracts when that feature is specified.

Continue adding Pi Durable capabilities in focused feature slices: tools and integrations, delegation and handoffs, background work, event- and schedule-triggered work, and the broader native configuration surface. These remain product goals. Their order after named definitions and their detailed workflows are unresolved; the [capability assessment](https://wiki.chrisreynolds.me/wiki/pi-durable-capabilities/) records the native foundations and application responsibilities.

Design the first chat around Pi's public interfaces and the ownership boundaries below. Add later features' detailed behavior and UI when their use cases are agreed. The right column remains available for specified supporting views; chat-first scope does not invent content for it.

## Contracts and state ownership

**Accepted ownership boundaries for chat:**

- The browser owns presentation and temporary interaction state, such as panel selection and unsent input.
- The application service owns authentication/authorization, request validation, transport, and application integration with Pi's public interfaces. Browser code does not receive server credentials or direct storage access.
- Pi Durable owns durable conversation/task state, execution, and recovery. Application code should not recreate Pi's execution engine or maintain a competing durable conversation store.

**Proposed runtime arrangement:** each Pi storage instance has one owning process. Development instances and tests use separate storage. The exact ownership enforcement and deployment arrangement remain unresolved; this is not a limit on concurrent agents within a runtime.

Define request/response schemas and the mapping to native Pi operations for the first workflow. Share transport contracts across browser and service, with runtime validation at trust boundaries. Schema tooling, transport (for example SSE or WebSocket), public API shape, and configuration semantics remain undecided.

## Failure and recovery behavior

**Accepted chat outcomes:**

- Browser refresh, navigation, or disconnection stops observation only; admitted agent work continues under the service/runtime lifetime. Explicit user cancellation is a separate operation.
- History persists, and reconnecting restores the current committed conversation state. Service-restart recovery must be verified in the first chat feature.

**Proposed implementation contracts for those outcomes:**

- On initial connection or reconnection, restore the current committed Pi view and then apply subsequent updates through one subscription layer. Pi's watch APIs may coalesce updates and do not promise replay of missed events; do not assume a replay cursor or an exactly-once event feed. Define snapshot replacement and snapshot/update ordering before implementation.
- A retry of the same logical submission reuses its request ID within the correct conversation and authorization scope. Distinct submissions receive distinct IDs. Native submission deduplication does not make external tool effects exactly once; effect-specific retry/reconciliation rules depend on the chosen workflow.
- A service restart reopens storage, reinstalls the required implementations, and resumes work through Pi's public recovery interfaces. The browser can reconnect to the recovered state. Do not equate reopening storage alone with a completed recovery implementation.

These proposals follow [Pi's public README](https://github.com/earendil-works/pi/blob/b60993bcc299c705731f0281e2b4d0db7c72188b/packages/durable/README.md) and the [maintained capability assessment](https://wiki.chrisreynolds.me/wiki/pi-durable-capabilities/). Verify the exact APIs against the dependency version chosen for implementation. Detailed error presentation, cancellation scope, authorization changes during observation, and external-effect recovery remain to be specified.

## Acceptance

The first workflow is chat. Resolve its remaining contracts and record ordered work-package acceptance criteria and checks in [handoff.md](handoff.md), with executable coverage in the [package tests](../test/). There is no separate validation plan.
