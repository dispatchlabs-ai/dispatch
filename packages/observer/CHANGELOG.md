# Changelog

## [Unreleased]

### Credential-free startup

- Open the viewer, settings and local discovery without initializing OS credential
  storage. Check protected storage only when reading or saving a password, retaining
  explicit errors and refusing plaintext fallback.

### Desktop reading polish

- Compact conversation headers and context so saved messages appear sooner.
- Inspect exact workflow evidence beside the conversation, expanded with native
  records, without moving playback.
- Populate workflow overviews with recorded work and expose primary evidence and
  linked-workflow actions directly; preserve modified-arrow history navigation.
- Widen connection setup, separate transport/database fields, and keep the title
  and Cancel/Test/Save controls visible while scrolling.

### Generic workflow journeys

- Use one searchable, collapsible journey for native delegation, retained handoffs
  and optional versioned `observer.workflow` documents. Represent arbitrary groups,
  attempts, branches, scope revisions and relationships without screen adapters.
- Open exact saved entries, native tasks/documents and linked workflows without
  changing conversation playback. Keep missing or ambiguous evidence explicit.
- Include repeated handoffs in reused conversations without assigning shared
  activity to older cycles; expose journeys for the selected explicit source too.
- Extend the synthetic walkthrough with nested structure, recovery, scope changes,
  linked remediation and incomplete evidence.

### Workflow reading and evidence

- Show saved workflows by default with consistent names and recorded-activity ordering.
- Discover validated sibling Runner stores so stopped handoff senders and assignments remain reachable.
- Separate unknown execution, task bookkeeping, source connection and reported assignment results; expose partial handoff chains.
- Add a beginning-of-message latest-response shortcut and matching-result tool disclosures with wrapped commands.
- Maintain a terse stable-ID use-case catalog, with behavioral contracts and qualification evidence kept separately.

- Navigate recorded local workflow cycles before their assignments and
  conversations, with available sender links across agent stores. Include saved
  local history, keep unrelated conversations separate, and distinguish declared
  handoff membership from native ownership and workflow completion.
- Open conversations at assignment context with the original handoff and actual
  peer author. Group tool activity, collapse long requests, and make following
  latest activity explicit without stopping live reads.

- Move saved connections and appearance into Settings, leaving the navigation
  rail focused on local work and conversations. Preserve the inspection view
  when closing Settings and keep automatic playback paused.

- Start on This machine with read-only local Pi store discovery, unfinished work
  first, separate process/task evidence, search, and one-click conversation access.
  Keep manual connections and historical inspection.
- Open Conversation by default, prefer saved chat titles, hide the unused inspector,
  and display shell arguments as multiline commands beside inline tool results.

- Add Back, Forward, and Parent conversation controls with keyboard navigation.
  Returning to a conversation restores its inspection tab, filters, selected
  evidence, and live/paused viewing state without resuming playback or agent work.

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
