# Dispatch Web package

This package owns the Dispatch browser workspace and its application integration with stock Pi Durable. Chat with a default agent is the agreed first feature, followed by named agent definitions and further native capabilities. Detailed contracts and implementation packages remain to be specified.

**Status: design stage.** There is no runnable application or install/build/test command yet. The source and test directories reserve their locations for implementation; no runtime capabilities are claimed.

## Documentation

- [Specification](docs/spec.md): accepted requirements and first chat workflow, with unresolved contracts labeled.
- [Implementation handoff](docs/handoff.md): decisions, ordered work packages, and acceptance criteria; no implementation package is approved yet.
- [Usage guide](docs/usage-guide.md): reserved for integration guidance when working interfaces and examples exist.
- [Changelog](CHANGELOG.md): package changes.
- [Repository contribution workflow](../../CONTRIBUTING.md): shared development and publication steps.
- [Repository wiki home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/): maintained product intent, decisions, and prior work.

Code belongs in `src/`, tests in `test/`, and runnable examples in `test/examples/`. Add package manifests and build configuration alongside these files when the implementation tooling is chosen.
