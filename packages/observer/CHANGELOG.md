# Changelog

## [Unreleased]

- Update Chord and the Pi Durable sample dependency to 1.4.0, removing
  Observer's remaining 1.3.0 dependency copies. Read Pi 1.4's
  SQLite schema 2 alongside schema 1 without migrating existing databases;
  refresh the bundled Chord license notice.

- Render conversation messages as Markdown and tool calls/results as expandable
  rows. Decode JSON text envelopes into multiline output, preserve code layout,
  format other JSON, and keep native records available in the inspector.
- Establish the Observer package's desktop use cases and design guide for
  read-only Pi Durable inspection through SQLite, Postgres, SSH, and AWS SSM.
- Add three ImageGen design references for live activity, workflow playback,
  and connection setup, with synthetic data and reproducible prompt records.
- Implement the Electron desktop app with SQLite/Postgres readers, SSH/SSM
  transports, protected saved connections, native hierarchy/task/document
  inspection, and retained-event playback with live following and pagination.
- Package an unsigned macOS app with bundled dependency notices; register the
  workspace and Nix build inputs. Document qualified paths and outstanding
  Windows/Linux and Postgres-over-SSM checks.
