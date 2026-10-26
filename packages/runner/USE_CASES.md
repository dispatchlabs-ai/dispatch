# Runner use cases

- **RUN-001 — Start company definitions:** discover agent folders and run manual,
  continuous or interval work without a browser or customer-specific service.
- **RUN-002 — Recover work:** preserve native tasks, conversations and submissions
  across restarts, with one owner per SQLite session and stable native identities.
  Secure new and existing stores with owner-only POSIX permissions or native
  Windows ACLs before opening them; reject unsafe paths or unsupported permission
  enforcement without asking users to configure permissions themselves.
- **RUN-003 — Share conversations:** admit idempotent turns, inspect history and
  streaming state, and bind external thread keys to application-supplied origins.
- **RUN-004 — Attach domain workflows:** share a host with specialized native
  workflows while giving discussions their own configured tools and instructions.
- **RUN-005 — Delegate privately:** keep each conversation's helper and progress
  separate, preserving the existing native ownership and recovery model.
- **RUN-006 — Use scoped skills:** opt into company and agent-specific skill
  discovery, load instructions/resources on demand and retain revision evidence.
- **RUN-007 — Chat in a terminal:** stream turns directly through the local
  service, resume named conversations and suspend work safely on process exit.
  Keep a continuous agent working in that conversation across completed passes,
  suspend and recover its native loop, and resume an explicit blocker pause with
  the needed user input.
  Display untrusted terminal controls as visible escapes, including streaming
  chunks and saved history, without changing stored conversation content.
- **RUN-008 — Use host-owned credentials:** configure a native store or trusted
  vault helper, resolve API keys directly into Pi, inspect only source metadata,
  and explicitly select session/environment compatibility without plaintext
  fallback. This does not supply isolation for untrusted code or OAuth storage.
- **RUN-009 — Work in a repository:** supply each agent with repository instructions
  and its own role instructions, select a saved working directory, and delegate
  bounded assignments to named agents with native ownership and recovery.

- **RUN-010 — Choose storage:** supply an application-owned Pi Storage factory,
  including the optional remote SQLite service, while retaining local status
  projections, ownership checks and the default local SQLite path.

- **RUN-011 — Install a shared agent service:** independently select runtime
  and definition revisions, discover available agents, and use local clients
  and transport adapters against the same native conversation owner.

- **RUN-012 — Message independent instances:** address permitted agent instances,
  create an independent recipient when needed, deliver assignments/updates and
  optional replies through native queued inputs, and inspect attributed outcomes
  without parent-owned delegation or another persistence/recovery system.

The extraction supports Node, SQLite and trusted company definitions.
Hosted Dispatch Web adoption, portable coding isolation, npm
registry publication and broad installation qualification remain separate work.
Runner source snapshots can be installed from public GitHub release archives;
their exact tag, source revision and lockfile integrity identify the bytes.
