# Dispatch Web package

This package owns the Dispatch browser workspace and its integration with stock Pi Durable 1.0.1. It implements invitation enrollment, password/TOTP and verified passkeys, private chats with native persistence/recovery, versioned company agent definitions, and a branded responsive workspace.

React Router in SPA mode, React, TypeScript, Vite, Tailwind, and shared Base UI primitives provide the browser app. A persistent Node/Hono service owns authentication and the native Pi runtime. Frontend hot reload does not restart that owner.

## Development

From the repository root:

```sh
nix develop
npm ci
npm run dev
```

Open `http://localhost:5173`. Use the root `npm run auth -- invite --email person@example.com --name "Person"` command to create an enrollment link. Run `npm run check` for TypeScript/build checks, `nix build` for the pinned application artifact, and `nix flake check` for declared build checks. Root `npm start` serves the built app at the same URL/state location after stopping development.

The current rule is zero tests. Add end-to-end and API coverage later, after stable behavior is ready to lock in; functional/browser qualification remains deferred. Source, TypeScript, and build review are the current checks.

## Documentation

- [Specification](docs/spec.md): behavior, ownership, authentication, layout, and testing policy.
- [Implementation handoff](docs/handoff.md): work packages, source/build evidence, and unverified outcomes.
- [Usage guide](docs/usage-guide.md): startup, account/model configuration, API, state, and troubleshooting.
- [Runtime integration](docs/runtime.md): native Pi ownership, request identity, cancellation, and recovery.
- [UI/UX review](docs/ui-ux-review.md): October 3, 2026 review of `d83f70d` that introduced the spec's UI implementation rules.
- [Brand asset provenance](src/assets/README.md) and [changelog](CHANGELOG.md).
- [Repository contribution workflow](../../CONTRIBUTING.md) and [wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/).

Browser code belongs in `src/`; the application service is in `server/`. Package-specific build configuration and the Nix recipe stay here; shared workspace scripts, manifests, and locks live at the repository root. Existing `test/` placeholders do not authorize adding tests while the current policy is active.
