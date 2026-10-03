# Dispatch Web implementation handoff

**Status: foundational and company access requirements accepted; authentication details and first implementation slice pending.** No application implementation package is defined or approved yet.

[spec.md](spec.md) defines the package's agreed behavior and contracts. Implement the work packages recorded here in order. After each package, run its tests and the repository checks, record the results, and review with Chris before proceeding. Do not redesign later packages while implementing the current one.

## Decisions

- Use stock upstream Pi Durable as the durable execution foundation.
- Require company users to sign in with 2FA; support TOTP and passkeys.
- Give all users equal initial application capabilities, with RBAC planned for later. See [company access](spec.md#company-access-and-authentication) for accepted scope and unresolved flows.
- Use TypeScript throughout the application and support local development on M1 Air.
- Use Nix for the development environment and builds, following the [accepted requirements](spec.md#language-and-development-requirements).
- Keep this package's specifications, handoff, and usage documentation in `packages/web/docs/`.
- Keep validation in each work package's acceptance criteria and in the package tests.

The [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/) maintains the decision history. The first agent-work workflow, final application structure, and detailed implementation contracts remain unresolved.

## Authentication acceptance requirements

When the authentication work package is agreed, include checks for:

- Protected pages, direct API requests, and live subscriptions denying access without a fully authenticated session.
- Successful TOTP and passkey login paths under the selected policy, with invalid, expired, replayed, cancelled, and incomplete attempts denied as applicable.
- Passkey-only login, if selected, requiring and verifying user verification; a possession-only assertion must not grant access.
- All initial users receiving the same capabilities within their authorized scope, while retaining separate identities and sessions.
- Logout, session expiry/revocation, enrollment, and recovery matching their agreed contracts.

Settle the login flow, account provisioning, enrollment/recovery, session policy, and company/workspace scope before implementing the affected behavior. No implementation package is scheduled by these requirements.

## Architecture proposal and review

The [proposed web architecture](spec.md#proposed-web-architecture) uses a React SPA and persistent TypeScript/Node Pi Durable service. React Router framework mode is the leading option; data mode remains open. The review emphasized that runtime ownership, a single live-state layer, and reconnection semantics matter more than router mode.

When these contracts and the first workflow are agreed, include acceptance checks in the owning work package for:

- Work continuing after browser disconnect, with a fresh committed view on reconnect.
- Snapshot replacement and ordered updates, including a slow or interrupted subscriber.
- Retrying one logical submission without admitting duplicate work, while preserving distinct submissions.
- Service restart and Pi recovery, with browser reattachment to recovered state.
- Frontend hot reload preserving the runtime owner, and development/test instances using separate storage.
- Server-side authorization and request validation on commands and subscriptions.

Choose the exact storage ownership mechanism, transport, schemas, and router mode before implementing the affected contracts. These are proposed acceptance areas, not completed checks or a scheduled implementation package.

## Work packages

No implementation packages have been scheduled. After agreeing the first slice, add ordered entries containing:

- Goal, scope, and prerequisite decisions or earlier packages.
- Relevant specification sections and implementation boundaries.
- Acceptance criteria covering observable behavior, applicable failures, and recovery.
- Tests and check commands that verify those criteria.
- Completion evidence and review status.

## Acceptance requirements for the initial tooling package

When the first implementation package establishes tooling, include these checks in its acceptance criteria:

- From a clean checkout on M1 Air, enter the declared Nix development environment and run, debug, and test the local application using documented commands.
- Build application artifacts with `nix build` from committed dependency locks and declared inputs, without undeclared host tooling, runtime credentials, or live services.
- Run `nix flake check` with meaningful type, test, and build checks for the implemented slice; document separate credential-dependent integration checks where needed.
- Smoke-test the built artifact with writable runtime state outside the Nix store. Validate each additional supported build/deployment platform explicitly.

These requirements do not schedule an implementation package or claim that tooling exists.

## Current repository state

The documentation layout is established. Source, tests, and example directories are empty. There are no application checks to run yet; use the documentation checks in [CONTRIBUTING.md](../../../CONTRIBUTING.md).
