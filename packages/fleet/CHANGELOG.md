# Changelog

## [Unreleased]

- Align shared Pi dependencies with Runner at 1.5.2 for native Fable 5.2 support; existing installations remain pinned.

## [0.7.0] - 2026-11-09

- Add immutable native run adapters, coordinator-owned Pi storage and run-bound
  relays for replaceable EC2 execution workers.
- Preserve source and artifact bytes across fenced worker handoffs using an
  exact EFS workspace bind and private DynamicUser artifact ownership.
- Add pressure placement, graceful retirement, durable cancellation intent,
  watchdog recovery, and a token-free Slack execution bridge.
- Keep staged Nix closures unchanged when root fleet processes import Python
  modules by disabling runtime bytecode writes.
- Allow the trusted root worker to verify its workspace firewall without
  changing native agent or computer-service permissions.
- Use the operating system's socket backlog for fleet control and run relays
  so bursts of native storage connections can wait for acceptance.
- Finish suspended runs through their cleanup assignment before releasing
  retained workspace and artifact files.
- Render Slack service working directories and credential paths with systemd's
  scalar syntax so the installed units load correctly.

## [0.6.0]

Repository lockstep development version; no standalone fleet release published.
