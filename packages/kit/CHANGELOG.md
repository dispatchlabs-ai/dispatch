# Changelog

## [Unreleased]

- Preserve the shared MIT notice at `kit/LICENSE` in direct and Nix compositions; it cannot be omitted or replaced.

## [0.11.0] - 2026-11-12

- Composition no longer copies `kit.json` or applied addendum files into the definitions root, so a skill folder holding only an addendum composes cleanly. The Fable worker's description no longer names a model version. Document composing without the Nix builder.

## [0.10.2] - 2026-11-12

- `kit.json` accepts `models`: set a kit role's provider, model and thinking level without replacing its `agent.md`.

## [0.10.1] - 2026-11-12

- Development no longer names the kit's cleanup skill by its catalog identifier, so omitting that skill leaves no dangling reference.

## [0.10.0] - 2026-11-12

- `kit.json` accepts `omit`: leave out a kit agent or skill, by file or directory, with a reason. `DIR/NAME.company.md` is appended to any kit `DIR/NAME.md`, not only a role's `agent.md`.

## [0.9.0] - 2026-11-12

- Add the kit: generic `jett`, `development`, `developer`, `code-reviewer`, `use-case-tester` and five model-worker agents, with the `verification`, `project-work`, `slack-output` and `development` skills. `dispatch.lib.mkAgentRelease { withKit = true; }` composes them under a company tree; a company extends a role with `agents/ROLE/company.md` and replaces a kit file only through a reason in `kit.json`. A content check keeps owner, company and host identifiers out.
