---
name: release
description: Prepare and verify an explicitly requested Dispatch Web release using its established target, checks, and publication workflow.
---

# Release preparation and verification

Use when a release is requested. Read `AGENTS.md`, `CONTRIBUTING.md`, the relevant package README and changelog, and the maintained deployment/release decisions linked from the repository wiki home. A source push, package release, and application deployment are different outcomes.

**Current tooling:** application/Nix builds and deployment procedures exist; see [CONTRIBUTING.md](../../CONTRIBUTING.md) and the [package usage guide](../../packages/web/docs/usage-guide.md). CI and release automation remain unconfigured. Establish the requested target and versioning policy rather than assuming a registry release or deployment.

Follow the [testing policy](../../packages/web/docs/spec.md#testing-policy): artifact, smoke and browser checks below require an applicable explicit exception. A release request alone does not authorize tests.

1. Establish the requested artifact or deployment target, release revision, audience, and existing authorization. Inspect current manifests, scripts, workflows, and maintained procedures. If essential release choices are still absent, prepare the concrete proposal and identify the unresolved decision before publication.
2. Audit the relevant changelog with [cl.md](../prompts/cl.md). Use the established versioning policy if one exists; do not import Pi's lockstep versioning or invent a package publishing command.
3. Validate the exact candidate with the checks in the package handoff and contribution guide. If an artifact is produced, test that artifact in the documented environment, including browser acceptance checks where applicable. Record failures and untested criteria; do not substitute source tests for artifact verification.
4. Follow the repository's integration policy and reconcile a moving publication target before final validation. Keep release configuration reproducible in its owning repository; follow the linked Palm policy for persistent machine configuration.
5. Perform only the authorized publication/deployment actions. Preserve credentials on their owning system. Record the resulting version, revision, artifact, or URL and verify availability and the relevant smoke-test outcome.
6. If publication is interrupted or ambiguous, inspect the remote state before retrying. Use the existing recovery/rollback procedure rather than overwriting tags or artifacts. Report what was actually published and what remains incomplete.

Update the owning package's usage/release documentation with verified commands and outcomes as real tooling is introduced. Do not enable CI, promise a rollback mechanism, or report a deployed application merely because this procedure exists.
