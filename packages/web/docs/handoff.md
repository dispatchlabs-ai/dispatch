# Dispatch Web implementation handoff

**Status: foundational requirements accepted; first product workflow pending.** No application implementation package is defined or approved yet.

[spec.md](spec.md) defines the package's agreed behavior and contracts. Implement the work packages recorded here in order. After each package, run its tests and the repository checks, record the results, and review with Chris before proceeding. Do not redesign later packages while implementing the current one.

## Decisions

- Use stock upstream Pi Durable as the durable execution foundation.
- Use TypeScript throughout the application and support local development on M1 Air.
- Use Nix for the development environment and builds, following the [accepted requirements](spec.md#language-and-development-requirements).
- Keep this package's specifications, handoff, and usage documentation in `packages/web/docs/`.
- Keep validation in each work package's acceptance criteria and in the package tests.

The [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/) maintains the decision history. The first workflow, application structure, and implementation contracts remain unresolved.

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
