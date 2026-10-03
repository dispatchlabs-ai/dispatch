# Dispatch Web — rebuild

A fresh implementation of Dispatch Web using stock upstream Pi Durable, developed on M1 Air.

**Status: design stage.** This repository starts with documentation. The first implementation slice, application structure, and checks will be established through specification work with Chris.

Dispatch Web is the browser workspace for Dispatch: a general-purpose platform for solving client problems with reusable agents, independent agent instances, handoffs, and event- or schedule-triggered work. These are product goals, not implemented features in this repository.

## Development approach

Follow the specification-led, incremental approach demonstrated in Pi Durable's [Pico5 handoff](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/docs/pico-v5-handoff.md):

1. Specify the user workflow and observable outcomes for the first slice.
2. Define contracts, state ownership, failure and recovery behavior, and acceptance checks before implementation.
3. Break the agreed design into ordered implementation packages.
4. Implement one package, run its tests and repository checks, and review it with Chris before moving to the next.

Use stock Pi Durable through its public interfaces. The upstream runtime owns durable execution and recovery; Dispatch owns the application experience and its integrations. The detailed application boundary will be established in the specification.

The wiki owns maintained product intent and decisions. Keep implementation specifications and technical documentation in this repository and link them to the relevant wiki decisions.

## References

- [Repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/)
- [Dispatch Web product history and current rebuild direction](https://wiki.chrisreynolds.me/wiki/dispatch-web/)
- [Pi Durable capabilities, examples, and design documents](https://wiki.chrisreynolds.me/wiki/pi-durable-capabilities/)
- [Pi Durable 1.0.0 documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)
- [Pi Durable normative specification](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/docs/spec.md)
- [Existing Dispatch Web repository and Omarchy pilot](https://github.com/dispatchlabs-ai/dispatch-web)

The existing application and pilot are references for behavior and prior decisions. This repository has its own fresh history.
