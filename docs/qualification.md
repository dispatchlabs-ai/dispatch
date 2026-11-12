# Verification and limits

Dispatch is pre-1.0 source-alpha software. This record separates public source,
built artifacts and observed behavior. A successful build is not production
installation, model-quality or security qualification.

## Released baseline

[v0.11.1](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.11.1)
resolves to `bbe716a0e5bd0e4dee9a50a52bb8e58041ce7a42` and pins Pi Durable 1.5.2.

Recorded November 12, 2026: full package build/type checks; macOS arm64 Nix flake,
frontend and portable builds; Linux x86_64 Runner and OCI builds; external packed
consumer strict type checking; and a production dependency audit with zero findings.
The five public reusable archives have a clean source manifest and SHA-256
checksums. They are GitHub release assets, not an npm registry publication.
No automated test suite was run.

Artifact scans were accompanied by source/content review. Known-pattern matches
in bundled dependencies were classified as upstream examples, parser strings
or SDK source paths. This is bounded privacy evidence, not a security certification.

## Current-source onboarding

The new [agent prompt and manual walkthrough](quickstart.md) target current source,
record its exact commit and use synthetic local state. Their fresh-session
qualification is in progress; this section will record the actual outcome before
the onboarding work is declared complete.

## Platform and capability boundaries

- The Nix flake defines macOS arm64, Linux x86_64 and Linux arm64. Declaring an
  output does not qualify every workflow on that architecture.
- This Nix walkthrough does not claim Intel macOS or native Windows support.
  Runner's separate [Windows guidance](../packages/runner/docs/windows.md) retains
  the scope and dates of its earlier observations.
- Synthetic examples exercise native execution, storage and client plumbing.
  They do not qualify external model quality, live tools, real channel accounts
  or production provider credentials.
- Hosted HTTPS, consumer-specific authorization, real channel delivery, fleet
  installation and each production recovery path remain installation-owned.
- Multi-human grants and a general authenticated network agent-client API are
  outside the current alpha contract. See the [interface inventory](interfaces.md).
- Source review and dependency scans are not a penetration test.

## Reproduce the permitted checks

Follow [CONTRIBUTING](../CONTRIBUTING.md) for source/type/build checks and the
[interactive verification guide](../.pi/skills/interactive-testing.md) for real
browser interaction. Dispatch does not add or run automated functional tests.
The public commands require no private repository or deployment configuration.

Keep private logs, machine identifiers and screenshots outside public source.
Publish only sanitized observations with revision, platform and explicit limits.
