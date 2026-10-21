# Dispatch Web package

This package owns the Dispatch browser workspace and its integration with stock Pi Durable 1.1.0. It implements invitation enrollment, password/TOTP and verified passkeys, shared conversations with native persistence/recovery, independent agent participants and reply threads, versioned company agent definitions, and a branded responsive workspace.

React Router in SPA mode, React, TypeScript, Vite, Tailwind, and shared Base UI primitives provide the browser app. A persistent Node/Hono service owns authentication and the native Pi runtime. Frontend hot reload does not restart that owner.

## Development

From the repository root:

```sh
nix develop
npm ci
npm run dev
```

Open `http://localhost:5173`. Use the root `npm run auth -- invite --email person@example.com --name "Person"` command to create an enrollment link. Run `npm run check` for TypeScript/build checks, `nix build` for the pinned application artifact, and `nix flake check` for declared build checks. Root `npm start` serves the built app at the same URL/state location after stopping development.

Follow the [testing policy](../../CONTRIBUTING.md#testing-policy) for permitted checks. Interactive agent-browser verification of authorized work is allowed; source and build checks alone do not establish runtime correctness. Future coverage prioritizes stable end-to-end and API behavior.

## Documentation

- [Use cases](USE_CASES.md): supported actor goals and approved additions, with stable identifiers.
- [Project spec access](docs/spec.md): read authoritative database Markdown; no spec body or export is stored here.
- [Implementation overview](docs/handoff.md): public qualification summaries and unverified outcomes.
- [Usage guide](docs/usage-guide.md): startup, account/model configuration, API, state, and troubleshooting.
- [Runtime integration](docs/runtime.md): native Pi ownership, request identity, cancellation, and recovery.
- [GitHub integration design](docs/github-integration.md): agreed implementation plan, App/credential contracts and acceptance boundaries; not supported usage.
- [Conversation workers](docs/conversation-workers.md): deployment ownership, lifecycle contracts and qualification boundaries.
- [AWS deployment module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch): infrastructure, caller example and installation instructions.
- [UI/UX review](docs/ui-ux-review.md): historical findings and current styling-migration evidence; live requirements remain in the database spec.
- [Component workshop](docs/component-workshop.md): run the shared component catalog, inspect template provenance, and review candidate Chat and Agent Editor layouts before migration.
- [Brand asset provenance](src/assets/README.md) and [changelog](CHANGELOG.md).
- [Repository contribution workflow](../../CONTRIBUTING.md).

Browser code belongs in `src/`; the application service is in `server/`. Package-specific build configuration and the Nix recipe stay here; shared workspace scripts, manifests, and locks live at the repository root. Existing `test/` placeholders do not authorize adding tests while the current policy is active.

For operator-only copying of settled chats into a worker deployment, see [archived chat migration](docs/archived-chat-migration.md).
