# Dispatch Web implementation handoff

**Status: chat is the agreed first feature, using Pi Durable and a default agent.** Foundational, company access, desktop/mobile, and workspace requirements apply. The localhost tooling package is implemented for review. Detailed chat contracts and later implementation packages remain pending.

[spec.md](spec.md) defines the package's agreed behavior and contracts. Implement the work packages recorded here in order. After each package, run its tests and the repository checks, record the results, and review with Chris before proceeding. Do not redesign later packages while implementing the current one.

## Decisions

- Use stock upstream Pi Durable as the durable execution foundation.
- Implement [chat with a default agent first](spec.md#first-agent-work-workflow-and-observable-outcomes), using independent native Pi conversations and Pi-owned execution and durable state.
- Follow chat with named agent definitions, then further Pi Durable capabilities in focused slices. The broader product goals remain in scope.
- Require company users to sign in with 2FA; support TOTP and passkeys.
- Give all users equal initial application capabilities, with RBAC planned for later. See [company access](spec.md#company-access-and-authentication) for accepted scope and unresolved flows.
- Use TypeScript throughout the application and support local development on M1 Air.
- Use Nix for the development environment and builds, following the [accepted requirements](spec.md#language-and-development-requirements).
- Prioritize quick localhost development; internal Omarchy/Palm deployment is deferred. The tooling slice uses React Router framework mode, Vite, Tailwind, and npm.
- Adopt the [workspace layout](spec.md#workspace-layout), including a full right column with optional tabs subordinate to the active main tab.
- Support [all user-facing functionality on desktop and mobile](spec.md#desktop-and-mobile-support) in each implementation slice, with presentation adapted to screen size and input method.
- Keep this package's specifications, handoff, and usage documentation in `packages/web/docs/`.
- Keep validation in each work package's acceptance criteria and in the package tests.

The [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/) maintains the decision history. Final application structure and detailed implementation contracts remain unresolved.

## First chat feature acceptance requirements

Translate these accepted outcomes into the owning work packages:

- An authenticated user can start a conversation, send messages, receive streamed responses, stop a response, and reopen saved history on desktop and mobile.
- New chats use the default agent's ordinary Pi configuration and have independent history and execution state within the user's authorized scope.
- A reload restores persisted history. Disconnecting the browser leaves admitted work running; reconnecting restores the current committed state, including work completed while disconnected.
- A service restart recovers the conversation and ongoing work through Pi's public recovery interfaces. Verify interruption during a response, not only an idle restart.
- Stop and failure states match the agreed cancellation/error contracts and remain distinguishable from a completed response.
- The integration preserves native transcript entry types and execution information needed for later tools and agent capabilities. Pi remains the owner of durable history and execution.
- Authentication, responsive layout, and contextual-view behavior meet the applicable acceptance requirements below.

Before the affected work packages begin, settle the default model/instructions/tools, authentication flows and company scope, mobile interactions, transport schemas, cancellation behavior, and runtime integration details. Selecting agent tools also requires specifying their user controls. These open details do not reopen the agreed chat-first feature sequence.

## Authentication acceptance requirements

When the authentication work package is agreed, include checks for:

- Protected pages, direct API requests, and live subscriptions denying access without a fully authenticated session.
- Successful TOTP and passkey login paths under the selected policy, with invalid, expired, replayed, cancelled, and incomplete attempts denied as applicable.
- Passkey-only login, if selected, requiring and verifying user verification; a possession-only assertion must not grant access.
- All initial users receiving the same capabilities within their authorized scope, while retaining separate identities and sessions.
- Logout, session expiry/revocation, enrollment, and recovery matching their agreed contracts.

Settle the login flow, account provisioning, enrollment/recovery, session policy, and company/workspace scope before implementing the affected behavior. No implementation package is scheduled by these requirements.

## Desktop and mobile acceptance requirements

Apply these requirements to every work package that adds or changes user-facing behavior:

- Complete the affected workflows on desktop and mobile, including the agreed TOTP/passkey authentication flows when implemented.
- Verify phone, tablet/intermediate, and desktop widths against the agreed browser/device matrix, using browser automation and representative real-device checks for touch, virtual keyboards, and platform authentication.
- Reach navigation, main tabs, and every defined supporting view/action on narrow screens, while preserving the active main tab and its contextual relationship.
- Verify touch operation without hover or precise dragging, plus keyboard navigation and focus handling when views open, close, or change context.
- Check readable content, reachable controls, intended scrolling, orientation changes, text enlargement, and the mobile keyboard opening and closing.
- Preserve active work and unsent input across layout changes. Switching main tabs while supporting views are hidden must not reveal stale content or action targets when reopened.

Agree the mobile interaction design and browser/device matrix before implementing the affected package. These are acceptance requirements for future work, not completed browser checks.

## Workspace layout acceptance requirements

When the workspace-shell work package is agreed, include checks for:

- The desktop arrangement: left rail, sidebar, tabbed main content, full right contextual column with tab support, and bottom bar.
- The right column extending alongside the main tab strip/content down to the bottom bar, occupying its own layout space.
- Main-tab changes updating the right column's context and available supporting views; right-tab changes preserving the active main tab.
- Late updates from an inactive main tab not replacing the active main tab's supporting content or action targets.
- Closing the active main tab selecting the correct remaining context or clearing the right context when none remains.
- No invented right-column features or tabs when their purpose has not been specified.

Define visibility/resizing, exact responsive presentation, keyboard interaction, scroll ownership, and supporting-tab persistence with the first affected workflow, meeting the desktop/mobile acceptance requirements above. This records acceptance requirements without scheduling implementation.

## Architecture proposal and review

The [proposed web architecture](spec.md#proposed-web-architecture) uses a React SPA and persistent TypeScript/Node Pi Durable service. WP-001 uses React Router framework mode; the service integration remains proposed. Chat's browser/service/Pi ownership boundaries and continuity outcomes are accepted independently of the frontend framework.

The chat requirements above cover disconnection and restart recovery. When the remaining implementation contracts are agreed, add checks for:

- Snapshot replacement and ordered updates, including a slow or interrupted subscriber.
- Retrying one logical submission without admitting duplicate work, while preserving distinct submissions.
- Frontend hot reload preserving the runtime owner, and development/test instances using separate storage.
- Server-side authorization and request validation on commands and subscriptions.

Choose the exact storage ownership mechanism, transport, and schemas before implementing the affected contracts. These are proposed acceptance areas, not completed checks or a scheduled implementation package.

## Work packages

The agreed feature order is chat with a default agent, then named agent definitions and independent instances, followed by further Pi Durable capabilities as their use cases are specified. WP-001 establishes the local tooling prerequisite. Break the first chat feature and its remaining prerequisites into subsequent ordered entries containing:

- Goal, scope, and prerequisite decisions or earlier packages.
- Relevant specification sections and implementation boundaries.
- Acceptance criteria covering observable behavior, applicable failures, and recovery.
- Tests and check commands that verify those criteria.
- Completion evidence and review status.

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

Apple Silicon macOS is verified. The declared x86-64 Linux output is not yet built or deployment-qualified. Review this package with Chris before starting the next implementation package.

## Current repository state

The frontend source, workspace manifests, package build configuration, and pinned Nix build are implemented. Test/example directories remain reserved. CI and release automation are unconfigured. Use the actual commands in the [usage guide](usage-guide.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md).
