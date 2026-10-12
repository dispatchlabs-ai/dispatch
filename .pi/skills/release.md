---
name: release
description: Build, verify and publish a requested Dispatch release using local Nix builds and the initial request as authorization.
---

# Release Dispatch

This is the canonical release runbook. Start here when asked to make a release; previous chats and private `.local/` scripts are not prerequisites. Read [CONTRIBUTING.md](../../CONTRIBUTING.md), the [web changelog](../../packages/web/CHANGELOG.md), and relevant package guidance.

## Authorization and defaults

**Accepted October 12, 2026:** the initial human request to make a release authorizes the entire ordinary workflow: select the SemVer bump, prepare versions/changelog, build and verify artifacts, commit/push to `main`, create/push the immutable tag, publish public GitHub Release assets, publish public registry images with available credentials, and update installation/release documentation. Do not ask for separate approval at each step or stop at a local tag. If asked to announce the version first, do that before mutations; only wait for confirmation if the human explicitly requires it.

Defaults: public MIT-licensed distribution, local Nix builds (no GitHub Actions), Apple Silicon Mac package, Linux/AMD64 controller and Ubuntu worker archives, frontend bundle and `SHA256SUMS`. Additional architectures are not implied. No separate npm publication of private packages or capability tarballs.

A release is not a live installation rollout. Do not change customer infrastructure, provider data, retained state, repository visibility or signing identities as a side effect. Explicit Stop/pauses and narrower human scope override these defaults. Missing credentials, builders or failed checks are concrete blockers, not reasons to ask again whether publication is authorized. Report the affected action promptly and continue independent unblocked work. Never expose credentials or self-grant access.

## 1. Prepare one candidate

- One agent owns release mutations; others review separate scopes without competing tags/builds. Use a clean task branch/worktree, fetch `origin`, and inspect local/remote tags and existing releases before choosing a new version.
- Audit accumulated changes from the last release with [cl.md](../prompts/cl.md). Follow [lockstep SemVer](../../CONTRIBUTING.md#versioning-and-releases): root, web, capability and lockfile versions move together; preserve a fresh `Unreleased` section. Explain incompatible changes during `0.x` development.
- In `nix develop`, run `npm run release -- minor --dry-run`, then `npm run release -- minor` (substitute the selected bump or explicit version). Inspect the complete diff. The script prepares files only; it does not publish.
- Run `npm run check`, `nix build`, `nix flake check`, and diff/staged whitespace checks. Refresh `npmDepsHash` using the [measured hash procedure](../../packages/web/docs/usage-guide.md#dependency-updates-and-later-deployment) if needed—even license-only lockfile edits can invalidate it. Never commit `lib.fakeHash`.
- Commit the candidate and record its full Git revision. Reconcile a moving remote before final validation; changed build inputs require rebuilding/rechecking. Documentation-only follow-ups need not rebuild unchanged artifact bytes. Apply [deslop.md](../prompts/deslop.md).

## 2. Build the release set locally

This playbook applies from a local or cloud conversation. Agents discover/provision the tools and authorized build resources needed for each target; installed-tool inventories, hostnames and machine-specific runbooks are not prerequisites. Use the **exact committed Git revision** on suitable builders. Keep long builds observable and recoverable. If a required target cannot be built with available authority/resources, report that specific dependency; do not silently narrow the artifact set.

| Artifact | Build | Published filename |
| --- | --- | --- |
| Portable Mac, aarch64-darwin | `nix build .#macos-release` on Apple Silicon | `dispatch-<version>-darwin-arm64.tar.gz` |
| Browser bundle | `nix build .#frontend` | `dispatch-frontend.tar.gz` |
| Controller, x86_64-linux | `nix build .#oci` on native AMD64 Linux | `dispatch-controller-<short-revision>-amd64.tar.gz` |
| Worker base, x86_64-linux | `nix build .#workers-oci` on native AMD64 Linux | Input to Ubuntu assembly, not an extra required download |
| Ubuntu worker, linux/amd64 | Containerfile assembly below | `dispatch-worker-ubuntu-<short-revision>-amd64.tar.gz` |

Use separate output links or copy each completed output before the next build replaces `result`. Keep receipts and staged files in ignored `.local/release-artifact-review/<revision>/` while working. Receipts include exact application/packaging revisions, commands, tool/platform versions, base-image pins, archive formats, checksums and observations—never credentials. On ephemeral cloud workspaces, preserve verified artifacts and sanitized checksum-bound receipts in durable release staging before teardown; a local path alone is not a handoff or backup.

For a remote Nix build, use a clean Git checkout at the commit or an immutable Git flake reference such as `github:dispatchlabs-ai/dispatch/<full-revision>#oci`. **Do not use `path:` on a bare `git archive`: `self.rev` becomes unavailable and the controller gets `uncommitted` metadata.** The GitHub ref requires pushing the candidate branch first (`git push origin HEAD:<candidate-branch>`); this publishes candidate source, not a release tag. Alternatively use a clean checked-out commit on the builder. Inspect actual labels/tags, rather than inferring provenance from filenames.

For Ubuntu assembly, follow the [container build contract](../../packages/web/container/README.md#build-inputs). Load the Nix worker-base archive into Docker, inspect its tag/image ID, and use that exact local image as `DISPATCH_IMAGE` for local assembly (registry builds use a digest-pinned reference). Supply explicit digest-pinned Ubuntu/mise inputs from the reviewed [Containerfile](../../packages/web/container/Containerfile), never floating tags:

```sh
# Set these to inspected build inputs; SOURCE_REVISION is the full candidate commit.
docker build --platform linux/amd64 \
  -f packages/web/container/Containerfile \
  --build-arg DISPATCH_IMAGE="$DISPATCH_IMAGE" \
  --build-arg UBUNTU_IMAGE="$UBUNTU_IMAGE" \
  --build-arg MISE_IMAGE="$MISE_IMAGE" \
  --build-arg SOURCE_REVISION="$SOURCE_REVISION" \
  -t "dispatch-agent:${SOURCE_REVISION}-amd64" packages/web/container
# WORKER_ARCHIVE is the selected published filename.
set -o pipefail
docker save "dispatch-agent:${SOURCE_REVISION}-amd64" | gzip -n > "$WORKER_ARCHIVE"
```

Record apt package inventory: Ubuntu assembly is not fully bit-reproducible. **Build once, verify, then promote those exact bytes**, not a fresh rebuild for each publication channel. Record whether image archives are Docker-save or OCI layout; loader instructions must match. Local image IDs/config digests/archive hashes are not registry manifest digests.

## 3. Verify the actual artifacts

Follow the [testing policy](../../CONTRIBUTING.md#testing-policy): no automated repository tests; source/type/build checks and authorized interactive browser verification are permitted. Use the [interactive-testing procedure](interactive-testing.md) for evidence reporting and owned-session cleanup. Use disposable state and isolated loopback instances; do not restart the shared service or copy live credentials. Forward only the authorized provider credential without printing it or creating an extra secret file. Docker persists container environment variables in daemon metadata even when supplied from the launching shell: do not describe that as memory-only or capture full container inspection output. Capture selected non-secret lifecycle fields, and remove owned credential-bearing qualification containers during cleanup while preserving any required separate data volume. Removal is cleanup, not proof of secure erasure.

- Calculate `SHA256SUMS` over the four final archives, then verify all entries. Inspect archive members before extraction. Ensure the Mac package carries Dispatch/Node notices, the frontend carries `LICENSE.txt`, and application images carry MIT text. Standalone capability publication would need its own license inclusion and is not a default release artifact.
- Inspect actual embedded Dispatch versions and Pi dependencies/capability peers in Mac/controller/worker outputs; a source manifest check alone is insufficient. Run the extracted Mac `version` command with a minimal environment excluding Nix/Homebrew.
- Scan artifact contents and build-context paths for recognizable credentials. For both image formats, open **every nested layer**, including deleted/overwritten content, configuration/history and symlink/hardlink paths. An outer archive listing or one gzip stream does not scan compressed layer contents. Use the tracked [artifact scanner](../../scripts/scan-release-artifact.py): `python3 scripts/scan-release-artifact.py "$ARCHIVE" > "$PRIVATE_RECEIPT"`. It uses the Python standard library, reads flat tar/Docker-save/OCI archives without extraction or execution, and reports categories/locations rather than secret values. Keep receipts private. Exit 0 means traversal completed, not security clearance; review every hit. Unsupported/malformed traversal fails and must not be counted as a pass. Review hits and record pattern/size/type exclusions. “No findings within coverage” is not proof of secret absence.
- Review the actual built frontend at 390×844, 768×1024, 1280×720 and 1440×900, at normal size and native browser 200% zoom—not CSS scaling. Check the complete version label, Sign out/Menu separation, footer reachability by scrolling, keyboard reopening and Escape/focus return. Match inspected browser files to the staged frontend by checksum or file comparison. Record browser version, viewport/zoom, observations and captures under ignored `.local/`; clean up only the owned session/fixture. Read-only synthetic fixtures qualify exercised presentation only, not authentication/model use, installation or full-app accessibility. Report clipping separately from a version-label pass.
- Record installation, enrollment/model use and recovery outcomes as verified, failed, blocked or not checked. Previous releases' target-machine evidence does not qualify new bytes. Do not silently turn unverified behavior into a pass or add live rollout to scope. Report material failures before publication; resolve failures of required artifact checks.
- Delegate distinct checks and reuse completed checksum-bound verification receipts across agent restarts and publication channels. Repeat checks only when changed inputs, missing coverage or new findings invalidate earlier evidence; destination-specific upload/download verification still applies. Do not have every agent repeat builds/scans for reassurance. Collect required results before publication; the release owner takes over unfinished checks if a reviewer is unavailable, without waiting for a human continuation prompt. Record self-verification honestly, not as independent review.

## 4. Publish without another approval prompt

Fetch/reconcile remote `main`, push the checked candidate normally, and verify the remote commit. Inspect existing tags first; never move a published tag. Example commands below assume `VERSION`, `REVISION`, `ARTIFACTS` and `NOTES` identify the selected version, full checked revision, staging directory and reviewed release-notes file:

```sh
git push origin HEAD:main
git tag -a "v$VERSION" "$REVISION" -m "Dispatch $VERSION"
git push origin "v$VERSION"
gh release create "v$VERSION" "$ARTIFACTS"/*.tar.gz "$ARTIFACTS/SHA256SUMS" \
  --repo dispatchlabs-ai/dispatch --verify-tag \
  --title "Dispatch $VERSION" --notes-file "$NOTES"
```

Notes must identify source/packaging revisions, artifact formats and checksums, compatibility changes, verification limits and pending channels. Keep private machine/customer details out of public notes. Do not claim signatures, a module compatibility manifest or registry digests that were not produced and verified.

Publish public GHCR images using granted registry credentials and immutable version tags; record destination manifest digests. **Missing GHCR `write:packages` blocks only registry pushes, not GitHub Release uploads.** Check repository publication access separately, publish verified downloads, and report the registry dependency without asking again for release authorization. The release owner attempts credential refresh with available tools; another agent must not start a competing login flow. If device activation or MFA requires the operator, immediately identify the initiating flow and give the necessary current device-code/next-step handoff through the trusted operator channel, monitor completion or expiry, and verify effective access before pushing. This is credential provisioning, not another release-approval gate. Never put access-token values in chat/commands/files or preserve device codes in repository docs/receipts. Do not invent registry names or overwrite existing versions; inspect the repository's existing packages/destinations first.

If publication is interrupted, inspect remote tags/releases/assets before retrying. Do not overwrite tags or replace checked assets blindly. Verify GitHub's recorded asset digests against local hashes, download checksums and representative assets anonymously, and check every asset URL. Verify registry pulls anonymously by destination digest when published; an authenticated push/readback does not establish public availability. New GHCR packages may default to private. The release owner must discover and use available authorized browser tooling for a website-only visibility change rather than delegate it merely because the API lacks that operation. Report an operator dependency only after establishing the actual authentication or permission barrier; do not reuse an unrelated human browser profile or bypass MFA. Checksums establish integrity through a trusted channel, not independent publisher authenticity.

## 5. Finish the human installation path

- Update [README](../../README.md) and owning [usage guide](../../packages/web/docs/usage-guide.md) to verified new downloads, checksum selectors, actual loaded tags/formats and tagged Compose/environment links. Do not make Mac users check files they did not download. Keep first-time setup clear; internal conversion history is not the front door.
- Preserve Engine-in-WSL2 foreground Compose guidance, loopback-only HTTP, state/keys, stopped-writer backup/replacement and named-volume safety. Docker Desktop is a distinct lifecycle. An old executable/image does not prove safe state rollback; a saved agent definition does not prove adopted participant configuration.
- Publish documentation follow-ups through the contribution workflow without moving the release tag or rebuilding unchanged bytes. Verify remote publication and sync a clean canonical checkout.
- Report version, immutable revision, public release URL, available artifacts/channels, verification evidence and concrete remaining blockers. A published archive release with pending GHCR is a partial channel outcome, not a reason to withhold downloads; unverified installation/rollout is not deployment completion.

Maintain this runbook when a release exposes a reusable lesson. Keep machine-specific operations in the operator's repository and release-specific checksums in release notes/receipts, not repeated transcript summaries here.
