# Generic workflow records

Observer uses one journey and evidence reader, not a screen per orchestrator.
Native ownership and retained labelled handoffs work without instrumentation.
For richer structure, a producer may retain a Pi document of kind
`observer.workflow`. Observer never writes it or executes its contents.

## Version 1

The [schema](../src/shared/workflowDocument.ts) is the contract. A synthetic value:

```json
{
  "version": 1,
  "id": "example-review",
  "title": "Example review",
  "cycle": "Round A",
  "nodes": [
    { "id": "round", "type": "group", "title": "Round 1", "kind": "Round" },
    {
      "id": "attempt",
      "parent": "round",
      "type": "activity",
      "kind": "Attempt",
      "title": "Inspect source",
      "status": "Changes requested",
      "evidence": [{ "conversationId": 12, "entryId": 34 }]
    },
    {
      "id": "follow-up",
      "type": "group",
      "title": "Remediation",
      "workflow": { "documentId": 56 }
    }
  ],
  "edges": [
    { "from": "attempt", "to": "follow-up", "kind": "requested remediation" }
  ]
}
```

- Each node has a stable unique `id`, `title`, and `type` (`group` or `activity`).
  Optional `parent` defines containment; arbitrary `kind` labels need no adapter.
  Use nesting for rounds, branches, cases, attempts, turns, passes or scopes.
- Optional `order` sorts siblings; then `at` (Unix milliseconds), then identity.
  Neither ordering nor timestamps establish dependencies. `edges` record named,
  directed relationships independently of containment, including many-to-one links.
- Optional `summary` and string-valued `attributes` describe scope/revision/context.
  Node and workflow `status` are producer reports, never verified execution.
  Workflows without an explicit result remain unknown.
- Each `evidence` item requires `conversationId` and optionally **one** of
  `entryId`, `taskId`, `documentId`, plus a display `label`. Multiple items can
  point to different entries in the same conversation or multiple conversations.
  Full transcripts remain full transcripts, not inferred activity segments.
- `workflow.documentId` links to another workflow document. References default
  to the owning source. Optional `source: { "agent": "...", "namespace": "..." }`
  resolves only against unambiguous, already loaded sources in that installation.
  Missing and ambiguous references stay unavailable. Documents never supply paths,
  connections, SQL, commands or executable adapters.
- Native IDs are positive safe integers. Unknown fields are ignored; unknown
  versions, malformed values and duplicate node IDs produce evidence notices.
  Missing/circular containment is detached with a notice; unresolved edges remain
  explicit. Unknown relationship and activity kinds are ordinary text.

Use stock Pi document APIs and a distinct document key per retained workflow/cycle.
Do not edit live SQLite tables to add metadata. Groups and edges are presentation
records, not a second scheduler. Updating a document shows its latest reconstructible
value; it does not reconstruct historical structure at the conversation playhead.
Emit explicit revision/attempt nodes if those distinctions matter.

## Reading and boundaries

**This machine** catalogs available local stores. **This source** also presents the
selected SQLite or Postgres source, including explicit remote connections; it does
not discover remote peers. Generic documents, native families and handoff cycles
are distinct views and may reference the same conversation. A partial document
never suppresses other recorded relationships.

Search retains matching nodes and their ancestors. Expand/collapse and selection
persist per workflow during the app session. Relationships and evidence open on
demand. Exact-entry inspection is scoped to its source and conversation and does
not advance frozen playback. Missing retained entries/tasks/documents are errors,
not empty successful evidence. Linked workflows retain a return path.

All retained received handoffs with leading `workflow:` and `cycle:` labels
participate, not just the first entry. Reused conversations remain shared: their
latest activity and owned children are not attributed to either cycle. Producers
should supply explicit document nodes/evidence for more precise scope.
Document workflow recency uses only explicit node timestamps, not later unrelated
conversation activity.

Run the [synthetic sample](../README.md#try-it) for nested groups, parallel branches,
recovery, same-conversation scopes, linked workflows, native delegation, reused
handoffs and unavailable evidence. It starts no agents. Platform/transport
qualification remains in the [usage guide](usage-guide.md#compatibility-and-qualification).
