---
name: release
description: Build and publish a specifically authorized Dispatch release.
---
# Release

Read [CONTRIBUTING](../../CONTRIBUTING.md) and [OSS](../../OSS.md). A source-only
feature assignment does not authorize tags, registries or live deployment.

1. On a clean owned branch, review accumulated changelogs, choose one lockstep
   version using `npm run release -- minor --dry-run`, then prepare it. No separate
   capability manifest remains. Breaking 0.x replacement requires a minor version.
2. Inside `nix develop`, `npm ci`, dependency-order `npm run build`, `npm run check`,
   measured shared-lock hash, `nix build`, `nix flake check` and affected artifacts.
   Never add or run automated tests in Dispatch. Use actual agent-browser rendered
   interactions with isolated synthetic state at all four required sizes.
3. Build `.#frontend`, `.#macos-release`, and on matching Linux builders `.#oci`
   and `.#workers-oci`. The removed Ubuntu worker assembly/old launcher/enrollment
   commands are not release inputs. Consumer definitions/authorization/providers
   are separate application releases, never copied from a maintainer installation.
4. Pack reusable packages and install/type-build outside the monorepo; inspect
   exports, declaration paths, files and exact Pi 1.5.0 dependencies. Inspect actual
   archives and images for private information and upstream notices. Scan with
   `scripts/scan-release-artifact.py` as supplementary evidence, never privacy proof.
5. Retain exact commit, digests, runtime versions, commands/results and limits.
   Do not claim Linux/live/hosted qualification from a Mac build or synthetic model.
6. Only within release authority, fetch/reconcile, inspect outgoing commits,
   publish normal source, create a new immutable tag and upload checksum-verified
   artifacts. Private workspace packages are not npm targets. Verify remote bytes,
   tag and publication receipts; report unavailable channels specifically.

Never move released tags, blindly overwrite assets or treat a release as permission
to apply infrastructure/change credentials or deploy an existing installation.
