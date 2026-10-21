# Pierre Diffs fork artifact

`pierre-diffs-1.5.1-dispatch.2.tgz` is the immutable editor prerelease from
[dispatchlabs-ai/pierre](https://github.com/dispatchlabs-ai/pierre/releases/tag/dispatch-diffs-v1.5.1-dispatch.2),
source commit `23c27198` (upstream `diffs-v1.5.1`, `8f360ae`). Its package name is
`@dispatchlabs/pierre-diffs`; Dispatch installs it under `@pierre/diffs`, preserving
React and worker import paths without a second engine/package instance.

SHA-256: `b8d763302e508670fe7ad7faa6cb9776eee9272676b908a80455def8e1c7e103`.
The web dependency uses the public, versioned GitHub release URL; the npm lock
records artifact integrity. Nix caches that URL with its dependency hash.
The original and an independently materialized fresh checkout produced
byte-identical tsdown builds and pinned pnpm packs on Node 24.21.0,
macOS arm64, using the fork's locked bootstrap profile and `RAYON_NUM_THREADS=1`.
See the package's included `FORK.md`, `NOTICE` and upstream Apache-2.0 `LICENSE.md`.
No npm-registry publication is required to install this artifact.

Update only from a new versioned fork tag/release. Rebuild and compare artifacts,
review changes, update the web release URL and root npm lock, then update the Nix
dependency hash. Local tarball dependencies are not supported by Nix
fetchNpmDeps, so do not switch to a file: dependency. Do not overwrite an already consumed release.

Source/type/build checks are not editor qualification: mobile/IME, spellcheck,
undo/redo, Tab and source fidelity remain unverified by browser execution.
Security's isolated marker/escaping fixtures passed on its fork copy; that is not
integrated application/browser acceptance. The main-app CSP is separate work.
