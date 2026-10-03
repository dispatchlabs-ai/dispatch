# Dispatch Web package

This package owns the Dispatch browser workspace and its application integration with stock Pi Durable. Chat with a default agent is the agreed first feature, followed by named agent definitions and further native capabilities. Detailed contracts and implementation packages remain to be specified.

**Status: local frontend foundation.** React Router in SPA mode, React, TypeScript, Vite, and Tailwind serve a responsive startup page. Chat, authentication, and Pi Durable integration are not implemented.

## Development

From the repository root:

```sh
nix develop
npm ci
npm run dev
```

Open `http://localhost:5173`. Run `npm run check` for TypeScript and build checks, `nix build` for the pinned static artifact, and `nix flake check` for declared checks. See the [usage guide](docs/usage-guide.md) for prerequisites, preview, and dependency updates.

## Documentation

- [Specification](docs/spec.md): accepted requirements and first chat workflow, with unresolved contracts labeled.
- [Implementation handoff](docs/handoff.md): decisions, ordered work packages, and acceptance criteria; local tooling acceptance and the remaining feature contracts.
- [Usage guide](docs/usage-guide.md): local startup, build, and troubleshooting guidance.
- [Changelog](CHANGELOG.md): package changes.
- [Repository contribution workflow](../../CONTRIBUTING.md): shared development and publication steps.
- [Repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/): maintained product intent, decisions, and prior work.

Code belongs in `src/`, tests in `test/`, and runnable examples in `test/examples/`. Package configuration and the Nix recipe live here; shared workspace manifests and locks stay at the repository root.
