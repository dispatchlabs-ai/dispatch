# Dispatch Web specification

**Status: partial specification.** The language and development/build requirements below are accepted. The first product workflow and implementation slice remain undecided; unresolved details are not accepted contracts.

## Product context

Dispatch Web is the browser workspace for general-purpose client problem-solving with agents. It uses stock Pi Durable for durable execution and recovery. The maintained product account and previous decisions are linked from the [repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/).

## Language and development requirements

Accepted October 3, 2026:

- Use TypeScript throughout the application: browser UI, server integration, Pi Durable extensions, tools, and application workflows. Nix expressions and other declarative build configuration remain in their native formats.
- Support local development, including on M1 Air (Apple Silicon macOS). Developers must be able to edit, run, debug, and test the application locally without deploying to a shared server. Runtime integrations may still need network access and credentials.
- Use Nix for builds and a repository-defined development environment. Pin Nix inputs and JavaScript dependencies in committed lockfiles, and share toolchain/dependency definitions between development and build outputs.
- Produce build artifacts from declared inputs without relying on globally installed Node tooling, developer-specific paths, production credentials, or live application services. Fetch dependencies through declared, pinned inputs; build steps must not download changing dependencies.
- Keep development state and runtime secrets outside build outputs and the Nix store. Build artifacts must remain separate from writable Pi Durable runtime state.

The intended entry points are `nix develop` for the local toolchain, `nix build` for application artifacts, and `nix flake check` for declared checks. These are requirements for future tooling, not commands available in this documentation-only repository. Keep the local edit/run loop inside the development environment; a full Nix build should not be required for every source edit. Future automation must reuse the same build definitions.

Use [Mitchell Hashimoto's shared development/build approach](https://mitchellh.com/writing/nix-with-dockerfiles) and [Pi's Nix flake](https://github.com/earendil-works/pi/blob/b60993bcc299c705731f0281e2b4d0db7c72188b/flake.nix) and [package recipe](https://github.com/earendil-works/pi/blob/b60993bcc299c705731f0281e2b4d0db7c72188b/nix/package.nix) as references. Pi's inspected flake packages its coding agent; it is not a ready-made Dispatch Web development environment.

The exact Node version, package manager, UI/server frameworks, deployment platforms, and artifact format remain to be chosen. Nix builds do not require adopting NixOS or Docker. Platform support must be validated explicitly; a macOS build does not establish Linux compatibility.

## First workflow and observable outcomes

To be specified with Chris: the actor, goal, entry point, successful outcome, alternative paths, and initial scope.

## Contracts and state ownership

To be specified: application interfaces, state ownership, native Pi Durable operations, configuration semantics, and the boundaries between the browser, application, and runtime.

## Failure and recovery behavior

To be specified for the chosen workflow, including observable failures, retries, interruption, and recovery.

## Acceptance

Once the first workflow and its contracts are agreed, record work-package acceptance criteria and checks in [handoff.md](handoff.md), with executable coverage in the [package tests](../test/). There is no separate validation plan.
