# Dispatch Web — rebuild

Dispatch Web is a browser workspace for company users, built on stock Pi Durable. The local implementation provides secure sign-in, private durable chats, company-shared agent definitions, and Dispatch's branded desktop/mobile workspace.

The wider product includes tools, handoffs, background work, and event- or schedule-triggered agents. Those capabilities, RBAC, and internal Omarchy deployment remain later work. The existing pilot is unchanged.

## Quick start

```sh
nix develop
npm ci
npm run dev
```

Open `http://localhost:5173`. Provision the first account with `npm run auth -- invite --email person@example.com --name "Person"`, then complete passkey or password/TOTP enrollment in the browser. Pi provider credentials stay on the service. See the [usage guide](packages/web/docs/usage-guide.md) for account recovery, model configuration, state, and built-app launchers.

`npm run check` runs TypeScript and builds only. **No tests at this stage:** future coverage will focus on end-to-end and API tests once behavior is stable enough to lock in. See the [testing policy](packages/web/docs/spec.md#testing-policy). Current source/build checks do not establish functional or device qualification.

## Package and workflow

The [Web package](packages/web/README.md) owns browser code in `src/`, service integration in `server/`, and its specification, handoff, usage guide, and changelog. Root files own shared workspace tooling, dependency locks, and contribution guidance. Nix pins the development toolchain and builds the static client plus service launchers.

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for work packages, source review, permitted checks, and publication. Use stock Pi Durable's public interfaces: Pi owns durable execution, history, and recovery; Dispatch owns identity, authorization, transport, and presentation. The wiki owns maintained product intent and decision history; package documents define concrete implementation contracts.

## References

- [Specification](packages/web/docs/spec.md), [implementation handoff](packages/web/docs/handoff.md), and [changelog](packages/web/CHANGELOG.md)
- [Repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/)
- [Dispatch Web product history](https://wiki.chrisreynolds.me/wiki/dispatch-web/) and [Pi Durable capabilities](https://wiki.chrisreynolds.me/wiki/pi-durable-capabilities/)
- [Pi Durable documentation](https://github.com/earendil-works/pi/tree/v1.0.1/packages/durable)
- [Existing Dispatch Web repository and Omarchy pilot](https://github.com/dispatchlabs-ai/dispatch-web)

CI and release automation are unconfigured. Reserved directories do not imply a test framework or configured automation.
