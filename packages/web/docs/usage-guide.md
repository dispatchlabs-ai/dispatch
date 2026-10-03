# Dispatch Web usage guide

The current implementation is a local frontend foundation with a startup page. Authentication, chat, and Pi Durable integration are still being specified.

## Start development

Use Nix with `nix-command` and `flakes` enabled. M1 Air's Nix installation and user configuration are managed by [Palm](https://wiki.chrisreynolds.me/wiki/palm/#section-portable-application-build-prerequisites-september-21-2026); application tooling is owned here. Open a new terminal after installing Nix. If an existing terminal has not loaded its shell integration, the binary is `/nix/var/nix/profiles/default/bin/nix`.

From the repository root:

```sh
nix develop
npm ci
npm run dev
```

Open `http://localhost:5173`. Keep that terminal running and edit files in `packages/web/src/`; Vite applies source edits without a full Nix build. Stop with Ctrl-C. Run `npm ci` on a fresh checkout and after `package-lock.json` changes. The initial dependency fetch requires network access; this slice requires no credentials or backend services.

The development server binds only to localhost and fails if port 5173 is occupied, so it cannot silently move to another URL. Reuse a server only when its checkout is known; stop only a task-owned server. Check the terminal's reported URL and use `localhost`, rather than assuming both IPv4 and IPv6 loopback addresses have listeners.

Browser developer tools can debug the TypeScript source through Vite's source maps. The terminal reports compilation failures. Source changes normally hot reload; configuration changes may restart Vite. If a broken edit prevents loading, fix the reported error and reload if necessary.

## Checks and builds

Inside the Nix shell:

```sh
npm run typecheck
npm run build
npm run preview
```

`typecheck` generates React Router route types and runs TypeScript without emitting code. `build` writes the SPA to `packages/web/build/client/`. `preview` serves that build at `http://localhost:4173`, also on loopback with a fixed port. Build again after source edits; preview does not hot reload source. There is no functional test suite yet. `npm run check` combines typechecking and the frontend build.

The reproducible build/check entry points can be run outside the development shell:

```sh
nix build
nix flake check
```

The Nix artifact is `result/share/dispatch-web/`, containing static HTML, CSS, and JavaScript. Its derivation also runs the typecheck. It needs no runtime state, secrets, or application services. When chat is implemented, its writable state must remain separate from this immutable output. `nix flake check` may reuse a successful cached build instead of rebuilding it.

The flake declares Apple Silicon macOS and x86-64 Linux outputs. Apple Silicon macOS is verified. Linux has not been built or qualified for deployment yet; evaluating a Linux output does not establish support.

## Update dependencies

Use npm inside `nix develop`, keeping exact dependency versions in the owning package manifest and committing the root `package-lock.json`. When dependencies change, update `npmDepsHash` in `packages/web/nix/package.nix`: temporarily set it to `lib.fakeHash`, run `nix build`, replace it with the reported actual hash, then rebuild and run checks. Never commit the placeholder. `nix flake update` changes the toolchain lock and also requires a fresh build/check.

## Later internal deployment

Omarchy/Palm hosting, an internal HTTPS domain, and its application service are a later work package. The current pilot at `dispatch.chrisreynolds.me` remains in place. This loopback development server is not a LAN deployment and cannot be opened directly from a phone. Narrow-screen browser checks can run locally; real-device acceptance belongs with the affected product workflows and an appropriate reachable test environment.
