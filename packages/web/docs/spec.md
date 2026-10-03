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

## Proposed web architecture

**Status: proposal, discussed October 3, 2026.** This records the architecture recommendation and independent Claude Code review. Framework selection and detailed contracts remain open; this section does not approve an implementation package.

Use a React SPA with a persistent TypeScript/Node service hosting stock Pi Durable. The leading UI option is React Router framework mode with `ssr: false`, using Vite. React Router data mode with an explicit API/subscription client remains a viable simpler alternative. Framework mode offers route types, route-module conventions, and code splitting; it does not provide the live agent-state contract. See [React Router's modes](https://reactrouter.com/start/modes) and [SPA behavior](https://reactrouter.com/how-to/spa).

The service can serve the built SPA and API on one origin. During local development, run the frontend development server separately from the Pi runtime and proxy application requests to the service. Frontend hot reload must not create another runtime owner or cancel agent work. Package/deployment boundaries remain undecided.

The recommendation favors consistent patterns for agents: typed and runtime-validated API contracts, a standard route-module pattern, one live-state subscription layer, and repeatable browser acceptance checks. Routing-level loading and one-shot commands should use documented patterns; ongoing Pi state should flow through the subscription layer. Client caches are derived views, not independent durable sources of truth.

Next.js remains an alternative if later workflows justify server rendering. It is not inherently incompatible with Pi Durable; whichever web framework is used, durable execution must have an appropriate persistent owner.

## First workflow and observable outcomes

To be specified with Chris: the actor, goal, entry point, successful outcome, alternative paths, and initial scope.

## Contracts and state ownership

**Proposed boundaries:**

- The browser owns presentation and temporary interaction state, such as panel selection and unsent input.
- The application service owns authentication/authorization, request validation, transport, and application integration with Pi's public interfaces. Browser code does not receive server credentials or direct storage access.
- Pi Durable owns durable conversation/task state, execution, and recovery. Application code should not recreate Pi's execution engine or maintain a competing durable conversation store.
- Each Pi storage instance has one owning process. Development instances and tests use separate storage. The exact ownership enforcement and deployment arrangement remain unresolved; this is not a limit on concurrent agents within a runtime.

Define request/response schemas and the mapping to native Pi operations for the first workflow. Share transport contracts across browser and service, with runtime validation at trust boundaries. Schema tooling, transport (for example SSE or WebSocket), public API shape, and configuration semantics remain undecided.

## Failure and recovery behavior

**Proposed observable requirements:**

- Browser refresh, navigation, or disconnection stops observation only; admitted agent work continues under the service/runtime lifetime. Explicit user cancellation is a separate operation.
- On initial connection or reconnection, restore the current committed Pi view and then apply subsequent updates through one subscription layer. Pi's watch APIs may coalesce updates and do not promise replay of missed events; do not assume a replay cursor or an exactly-once event feed. Define snapshot replacement and snapshot/update ordering before implementation.
- A retry of the same logical submission reuses its request ID within the correct conversation and authorization scope. Distinct submissions receive distinct IDs. Native submission deduplication does not make external tool effects exactly once; effect-specific retry/reconciliation rules depend on the chosen workflow.
- A service restart reopens storage, reinstalls the required implementations, and resumes work through Pi's public recovery interfaces. The browser can reconnect to the recovered state. Do not equate reopening storage alone with a completed recovery implementation.

These proposals follow [Pi's public README](https://github.com/earendil-works/pi/blob/b60993bcc299c705731f0281e2b4d0db7c72188b/packages/durable/README.md) and the [maintained capability assessment](https://wiki.chrisreynolds.me/wiki/pi-durable-capabilities/). Verify the exact APIs against the dependency version chosen for implementation. Detailed error presentation, cancellation scope, authorization changes during observation, and external-effect recovery remain to be specified.

## Acceptance

Once the first workflow and its contracts are agreed, record work-package acceptance criteria and checks in [handoff.md](handoff.md), with executable coverage in the [package tests](../test/). There is no separate validation plan.
