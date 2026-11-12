# Changelog

## [Unreleased]

## [0.10.1] - 2026-11-12

- Development no longer names the kit's cleanup skill by its catalog identifier, so omitting that skill leaves no dangling reference.

## [0.10.0] - 2026-11-12

- `kit.json` accepts `omit`: leave out a kit agent or skill, by file or directory, with a reason. `DIR/NAME.company.md` is appended to any kit `DIR/NAME.md`, not only a role's `agent.md`.

## [0.9.0] - 2026-11-12

- Add the kit: generic `jett`, `development`, `developer`, `code-reviewer`, `use-case-tester` and five model-worker agents, with the `verification`, `project-work`, `slack-output` and `development` skills. `dispatch.lib.mkAgentRelease { withKit = true; }` composes them under a company tree; a company extends a role with `agents/ROLE/company.md` and replaces a kit file only through a reason in `kit.json`. A content check keeps owner, company and host identifiers out.
