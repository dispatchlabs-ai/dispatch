# Ubuntu agent worker image

The [Containerfile](Containerfile) assembles an Ubuntu development environment around a **Nix-built Dispatch worker**. Nix still pins Dispatch's Node/runtime closure; Ubuntu's package manager and project-selected runtimes are separate. This image is for conversation workers, not the backend or launcher. See the [work package](../docs/handoff.md#ubuntu-agent-image--october-9-2026) for acceptance and evidence; source/build success is not deployed qualification.

## Build inputs

Build Dispatch's `packages.aarch64-linux.workers-oci` or `packages.x86_64-linux.workers-oci` output for the matching Linux platform first. Preserve `/nix/store` and the worker wrapper's absolute paths; do not copy only application JavaScript or substitute Ubuntu's Node. Supply digest-pinned `DISPATCH_IMAGE`, `UBUNTU_IMAGE` and `MISE_IMAGE` references plus the matching application `SOURCE_REVISION` when assembling the image:

```sh
# Caller supplies the four variables; this example builds one native platform.
docker build --platform linux/arm64 \
  -f packages/web/container/Containerfile \
  --build-arg DISPATCH_IMAGE="$DISPATCH_IMAGE" \
  --build-arg UBUNTU_IMAGE="$UBUNTU_IMAGE" \
  --build-arg MISE_IMAGE="$MISE_IMAGE" \
  --build-arg SOURCE_REVISION="$SOURCE_REVISION" \
  -t dispatch-agent:local packages/web/container
```

Build/inspect `linux/amd64` separately before publishing a multi-platform index. Record both child manifests, the index digest, the Nix application revision and the Containerfile revision separately. They can differ when repackaging an unchanged deployed application; the `SOURCE_REVISION` label identifies the application, not necessarily the packaging recipe. Record all three base-image digests/build arguments in the caller receipt. Tags/default Containerfile arguments alone are not release identities. Fargate pulls images for new tasks: keep the registry in the task's region and measure startup before adding large SDK inventories. The [AWS module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch) and installation consumer own task definitions, image pins, resources and rollout; a local build does not update ECS.

## Release frontend bundle

Application publishers also run `nix build .#frontend` from the selected release
commit. It reuses the locked application build and emits `dispatch-frontend.tar.gz`
and `SHA256SUMS` with deterministic archive metadata. Publish that archive with
the controller/worker artifacts and record its HTTPS URL/checksum and compatible
module version in the [artifact manifest](https://github.com/dispatchlabs-ai/terraform-aws-dispatch/blob/main/releases/README.md#spa-bundle-and-publication).
Independent callers obtain verified release artifacts, not this source checkout
or a Nix build requirement. The module's explicit publisher retains shared hashed
assets and immutable index prefixes; building locally neither uploads S3 objects
nor switches CloudFront. Public artifacts remain gated on the open-source release.

## Lazy loading on Fargate

Publish a [SOCI v2 index](https://github.com/awslabs/soci-snapshotter/blob/v0.16.1/docs/cli-usage.md) for the finished worker image and any large sidecar images. Fargate Linux platform 1.4.0 discovers the index through the published OCI image index. Keep every referenced manifest and blob in the same regional ECR repository. Pin the converted image-index digest in the installation inputs; pinning the original child manifest bypasses the added SOCI artifact.

The following conversion was qualified with SOCI 0.16.1 and ORAS 1.3.4. Obtain the official release binaries for the build host and verify their published SHA256 checksums. SOCI runs on Linux; its standalone mode needs no containerd daemon or privileged container. Export the finished image as an **OCI** archive (for example, Docker Buildx's `type=oci` output, or `docker save` with Docker's containerd image store), preserving gzip-compressed layers. Legacy Docker archives are not this input format.

```sh
# Run on Linux, or in a temporary Linux container with only this build directory mounted.
soci convert --standalone --platform linux/amd64 \
  --span-size 16777216 --format oci-dir worker.oci.tar worker-soci

# Run with an existing registry login; do not put credentials in this recipe.
digest=$(jq -r '.manifests[0].digest' worker-soci/index.json)
oras cp --from-oci-layout "worker-soci@$digest" "$ECR_REPOSITORY:$IMMUTABLE_TAG"
```

Repeat for the collector and select its converted digest through the module's `worker_tracing_collector_image` input. Record the source image digest, resulting index digest, platform, tool versions and span size with the deployment receipt. The 16 MiB span size reduces index metadata compared with the 4 MiB default; it is a measured packaging choice, not a universal optimum. No experimental xattr or prefetch flags are required by this recipe.

[Verify lazy loading](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html#lazy-loading) inside a newly launched task: the metadata endpoint's `Snapshotter` must be `soci` for each intended container. Record ECS creation, pull and start timestamps, then separately measure the real application's new-chat request through readiness and an agent reply. Image-pull duration and ECS `RUNNING` do not establish application readiness; a warm assignment is a different measurement. SOCI cannot remove Fargate provisioning time.

Use the services/diagnostic cluster for disposable probes, with no conversation credentials. The dedicated worker cluster is an ownership boundary: an unrecognized active task deliberately blocks admission. Stop and confirm termination of each probe, then deregister its temporary task definition. Never turn a diagnostic task into an application worker by inventing conversation tags.

## Tools and project runtimes

The recipe includes Bash/GNU tools, Git/SSH client, ripgrep, curl/wget, jq, archives, certificates, Python/venv/pip, C/C++ compilers, make, CMake/Ninja/pkg-config/autotools and common native-development libraries. Mise and a separate project Node are pinned in the recipe. Dispatch's own launcher does not use mise shims.

`PATH` includes mise shims and conventional Ubuntu executable directories for Pi's noninteractive `/bin/bash -c` commands. No interactive shell activation is required. Preserve repository package managers, runtime files and lockfiles. For a reviewed project using mise:

```sh
mise install
mise exec -- node --version
npm ci
```

Mise configuration and hooks can execute project code: review/trust the selected configuration explicitly rather than automatically trusting arbitrary repositories. Other runtime versions can be installed during work; the shipped image does not preinstall every Node, Python, Go, Java, Rust, Ruby or .NET version. Exact architecture/version/native-library combinations require qualification. Keep runtime requirements in `mise.toml` (and `mise.lock` where used), alongside existing package-manager lockfiles. Ubuntu's externally managed Python should use a project venv rather than forcing global pip installation.

## Browser tooling

The Ubuntu recipe installs `agent-browser` 0.38.2, Chromium, its Ubuntu libraries/fonts, and FFmpeg during the build. The [browser lockfile](browser/package-lock.json) pins the CLI and Playwright 1.64.1, which selects Chromium builds for both Linux AMD64 and ARM64. Playwright is used to install the browser; agent-browser runs its native binary. No browser download, npm install or package-manager operation is needed when a conversation starts. The extra headless-shell download and other platforms' CLI binaries are omitted.

`agent-browser` and `chromium` are in `/usr/local/bin`. `AGENT_BROWSER_EXECUTABLE_PATH` selects the packaged Chromium under `/opt/dispatch-browser`; project mise/Node changes do not replace either executable. Do not mount over that directory. Agent-browser 0.38.2's installer rejects Linux ARM64 even though Google's current Chrome for Testing feed supplies that architecture. The pinned Playwright installer avoids this stale guard and Ubuntu's Chromium Snap dependency. See the [current Google browser feed](https://googlechromelabs.github.io/chrome-for-testing/), [agent-browser installer source](https://github.com/vercel-labs/agent-browser/blob/v0.38.2/cli/src/install.rs) and [custom executable setting](https://agent-browser.dev/installation).

Use the assigned Agent browser skill, Files and commands capability, and a unique session for each agent/run. For an authorized target, use `agent-browser --session <unique-name> open <url>`, then `snapshot`/`screenshot`, and `close` that same session. Installing the tools grants no new permissions or access. The Ubuntu worker's existing root/container boundary remains in effect; agent-browser automatically selects Chrome's container launch flags. Browser processes share the conversation worker's authority and are not an additional isolation boundary.

When updating the CLI, review the pinned skill text too. Update the browser manifest/lockfile together, rebuild, and verify navigation, snapshots, screenshots and recording in the actual image. Record architecture, CLI/Chromium versions, image identity and remaining coverage in the task or release receipt. Native host browser checks do not qualify the container.

On October 14, 2026, interactive qualification passed on native Linux AMD64 and ARM64 with agent-browser 0.38.2 and Chromium 156.0.8078.4: HTTPS navigation, snapshots, form entry/clicks, screenshots with Chinese/Arabic fonts, and VP8 recording. AMD64 used the complete Dispatch image; ARM64 used the identical browser layer without the Nix application closure. This qualifies ARM64 browser tooling, not a full ARM64 Dispatch deployment.

Surton's existing AMD64 Fargate profile (0.5 vCPU, 2 GiB) passed navigation, snapshots, screenshots and a short VP8 recording at `--fps 5`. Default 30 fps recording exceeded agent-browser's encoder backlog limit there, although it passed on the native build hosts. Use a lower recording rate on constrained workers; this observation does not qualify long or animation-heavy recordings.

## Installation and security boundary

The development worker runs as container root with a writable Ubuntu filesystem, **not privileged mode**. Ordinary work can use `apt-get update && apt-get install -y <package>` without sudo. Ubuntu mirrors are configured for HTTPS to fit existing HTTPS package egress; no HTTP egress expansion is required. Package service-start hooks are suppressed in the recipe; this is not a full init/systemd host.

The worker's home is `/root`; workspace/state are under `/workspace`. Baked mise tools/config/shims must remain visible with the actual ECS mounts: mounting an empty volume over their paths hides them. Controllers retain their separate non-root/read-only/drop-capabilities settings. Worker capabilities must permit apt's UID switching and Pi process-group cancellation; root with controller drop-ALL is not equivalent. Confirm the rendered task definition and runtime behavior, not only `USER` in the Containerfile.

Coding tools can access the worker's conversation-scoped database/callback authority. Root and pinned runtime paths do not isolate collaborating agents from one another or protect worker-local credentials from their shells. Do not inject backend/launcher owner credentials, host mounts, Docker sockets or ECS-control authority. Nested privileged Docker workloads need a separately reviewed remote builder or another execution environment; they are not supported merely by installing a Docker CLI on Fargate.

## Replacement and base-image evolution

Runtime package installs modify this task's writable filesystem, **not the published image**. They disappear on fresh-task replacement unless reproduced. Home/Git capture alone cannot preserve apt changes under `/usr`, `/etc` and `/var/lib/dpkg`; the current worker policy does not promise full-filesystem snapshots.

Record useful installations in versioned project setup scripts; promote recurring tools into this Containerfile. Commit/push useful source progress and publish durable artifacts through the supported artifact tools. Local commits, dependencies and unpushed files remain disposable; retained Pi history is not a complete filesystem journal and completed tools must not be blindly replayed. Keep preparation out of warm message/read paths. Pi still owns execution/recovery, and replacement still requires confirmed old-task termination.
