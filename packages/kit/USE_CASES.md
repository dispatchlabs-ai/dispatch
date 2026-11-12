# Kit use cases

This catalog records intended actor goals; accepted additions do not establish
implementation or deployment.

- **KIT-001 — Start from the kit:** a company with only a `factory.yaml` builds
  a release whose catalog lists the kit agents and skills.
- **KIT-002 — Add company agents:** company agents and skills sit beside the
  kit's in one definitions root, and may delegate to or message kit roles.
- **KIT-003 — Extend a role:** a company adds instructions to a kit role with
  `agents/ROLE/company.md` and keeps receiving the kit's own changes.
- **KIT-004 — Replace deliberately:** a company replaces a kit file only by
  declaring it with a reason; an undeclared collision or a stale declaration
  fails the build with the path and the fix.
- **KIT-005 — Trace a release:** an operator reads from the release which kit
  revision it contains and what the company replaced or extended.
- **KIT-006 — Stay generic:** a maintainer's change that puts an owner, company
  or host identifier into the kit fails the build and `nix flake check`.
- **KIT-007 — Leave others alone:** a release built without `withKit` contains
  exactly the company tree, as before.
