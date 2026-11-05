# Changelog

## [Unreleased]

- Add immutable native run adapters, coordinator-owned Pi storage and run-bound
  relays for replaceable EC2 execution workers.
- Preserve source and artifact bytes across fenced worker handoffs using an
  exact EFS workspace bind and private DynamicUser artifact ownership.
- Add pressure placement, graceful retirement, durable cancellation intent,
  watchdog recovery, and a token-free Slack execution bridge.
- Keep staged Nix closures unchanged when root fleet processes import Python
  modules by disabling runtime bytecode writes.

## [0.6.0]

Repository lockstep development version; no standalone fleet release published.
