# Changelog

## [Unreleased]

- Add the kit: generic `jett`, `development`, `developer`, `code-reviewer`, `use-case-tester` and five model-worker agents, with the `verification`, `project-work`, `slack-output` and `development` skills. `dispatch.lib.mkAgentRelease { withKit = true; }` composes them under a company tree; a company extends a role with `agents/ROLE/company.md` and replaces a kit file only through a reason in `kit.json`. A content check keeps owner, company and host identifiers out.
