# Changelog

## [Unreleased]

- `kit.json` accepts `roles`: change a kit role's message recipients, delegates and extensions without replacing its `agent.ts`. A changed role is composed as `agents/ROLE/agent.ts` beside the kit's definition in `agents/ROLE/agent.kit.ts`.
- The composer gains `status` and `accept`, run as `nix run --inputs-from . dispatch#kit -- status`. `accept` records the kit's files in `kit.lock.json`; `status` lists what the kit changed for the repository since. A build warns when a replaced file's kit original changed since the record or has none, and `NAME catalog` repeats the warning.
- Add a flake template, `nix flake init -t github:dispatchlabs-ai/dispatch/TAG#kit`, bound to one model provider, and a first-conversation guide. `example/` is now `template/`.
- The composer's summary (`share/NAME/kit.json`) adds `roles` and `review`.

## [0.11.2] - 2026-11-12

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
