# Dispatch Web — rebuild

A fresh implementation of Dispatch Web using stock upstream Pi Durable, developed on M1 Air.

**Status: localhost development foundation.** A responsive startup page runs with hot reload and a pinned Nix toolchain/build. Chat with a default agent on stock Pi Durable is the agreed first feature, followed by named agent definitions; those features and authentication are not implemented yet.

Dispatch Web is the browser workspace for Dispatch: a general-purpose platform for solving client problems with reusable agents, independent agent instances, handoffs, and event- or schedule-triggered work. These are product goals, not implemented features in this repository.

## Packages

| Package | Purpose | Status |
| --- | --- | --- |
| [Web](packages/web/README.md) | Dispatch browser workspace and its application integration with Pi Durable | Local frontend foundation; chat contracts in progress |

## Quick start

```sh
nix develop
npm ci
npm run dev
```

Open `http://localhost:5173`. See the [usage guide](packages/web/docs/usage-guide.md) for prerequisites, builds, and troubleshooting. Internal deployment on Omarchy/Palm is a later work package.

## Repository layout

Documentation lives with the package that owns the behavior. Repository-wide instructions and tooling stay at the root, following Pi's root layout and Durable's package layout.

```text
README.md
AGENTS.md
CONTRIBUTING.md
.pi/
  prompts/
  skills/
packages/
  web/
    README.md
    CHANGELOG.md
    docs/
      spec.md
      handoff.md
      usage-guide.md
    src/
    test/
      examples/
scripts/
.github/
  workflows/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and directory responsibilities. Empty directories are tracked with `.gitkeep`; their presence does not imply installed tools, runnable examples, or configured CI.

## Development approach

Complete the first chat workflow's contracts and work-package acceptance criteria in the [Web package documentation](packages/web/README.md#documentation). Implement the agreed work packages in order, verify each one, and review it with Chris before continuing. The process reference is Pi Durable's [Pico5 handoff](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/docs/pico-v5-handoff.md).

Use stock Pi Durable through its public interfaces. The upstream runtime owns durable execution and recovery; Dispatch owns the application experience and its integrations. The detailed application boundary will be established in the specification.

The wiki owns maintained product intent and decisions. Package specifications and handoffs translate those decisions into implementation contracts and work packages. Acceptance criteria and package tests carry validation; there is no separate validation-plan document.

## References

- [Repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/)
- [Dispatch Web product history and current rebuild direction](https://wiki.chrisreynolds.me/wiki/dispatch-web/)
- [Pi Durable capabilities, examples, and design documents](https://wiki.chrisreynolds.me/wiki/pi-durable-capabilities/)
- [Pi Durable 1.0.0 documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)
- [Pi Durable normative specification](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/docs/spec.md)
- [Existing Dispatch Web repository and Omarchy pilot](https://github.com/dispatchlabs-ai/dispatch-web)

The existing application and pilot are references for behavior and prior decisions. This repository has its own fresh history.
