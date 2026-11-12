---
name: project-work
description: Create and maintain project pages, work items, bugs, decisions and results; resolve company project context and hand authorized work to existing agent workflows.
---

# Project work

## Start with the company

Read the **company agents repo's** `factory.yaml`, not a target product repo's.
Resolve its wiki, project key, canonical project URL, repositories, connections
and workflow entry points. See [manifest conventions](references/manifest.md)
when registering a project or interpreting an unfamiliar inventory.

Use an authorized repo reader or the selected manifest context supplied by the
coordinator. Without either, obtain the missing context; do not guess a project
from a repository shared by several projects or substitute another company's wiki.
Connection declarations describe bindings, not credentials or grants.

## Create or maintain

- A draft-only request produces unpublished Markdown and stops. Do not publish,
  register projects or start work; mark any unperformed discovery/verification.
- Search the owning wiki/tracker before creating records. Every registered project
  has a wiki page; use [project.md](assets/project.md) as the one-page default.
  Publish and verify the page before registering its exact URL in the manifest.
  Report partial registration if either write fails; do not invent success.
- Templates are starting Markdown, not a required page set or new wiki types.
  Replace `{{...}}`, remove inapplicable fields, and use the wiki's title field
  instead of a duplicate top-level heading where appropriate. Do not add empty
  pages, dates, owners, estimates or approval gates to fill a template.
- Defaults describe new records only. When updating, preserve known assignments,
  states and evidence; do not reset them from a template or overwrite a full
  article from a partial read. An unsent proposal may describe the intended delta.
- New article IDs use `project-<project-key>`, with optional `-work`, `-decisions`,
  `-security`, `-results` or a lowercase item ID such as `-b101`. Preserve existing
  canonical URLs. Check collisions; actual manifest URLs and links beat guessed
  names. Keep linked ID headings stable when descriptive titles change.
- Each item has one canonical section/page, referenced by **project key + local
  ID + URL**. Group existing links into milestones, epics, cycles or initiatives
  as useful; do not copy work. Indexes and summaries are derived. When Linear,
  Jira or another tracker owns the item, link there rather than creating a
  competing wiki ticket/status.
- Ready means prerequisites are satisfied; it is not execution authority.
  Preserve blocker reasons, accepted/superseded decisions, duplicate/canceled
  dispositions and reopening history. Priority is not severity.
- Read the complete current article before replacement, preserve unrelated
  content/metadata and use the connection's revision preconditions. Preview
  significant formatting and read back publication. Reconcile stale revisions;
  after an uncertain write inspect durable state and reuse its request identity
  where supported, rather than blindly creating another record.

## Templates on demand

| Need | Resource |
| --- | --- |
| Small project, including inline work/decisions/results | [Project](assets/project.md) |
| Inline item or a larger standalone task/bug | [Work item](assets/work-item.md) |
| Expanded backlog and milestone navigation | [Work](assets/work.md) |
| Decision and preserved alternatives | [Decisions](assets/decisions.md) |
| Security assessment, coverage and finding disposition | [Security](assets/security.md) |
| Acceptance evidence, publication and updates | [Results](assets/results.md) |

For a split, keep the item ID and an onward link at the original section.
Use absolute Markdown links for cross-page fragments; verify rendered anchors.

## Execute through the existing workflow

Carry the project/work reference, selected manifest context, relevant decisions,
acceptance, authorized repositories and original authority into the existing
assignment contract. Inspect native assignments, source revisions and candidate
ownership before starting/resuming. A stale wiki status is not a reason for
another writer. Follow the manifest's workflow entry point; do not redefine its
roles, independent checks, publication rules or recovery here.

Keep bug repair and security assessment dispositions separate. A denied access
attempt can close the security hypothesis while a misleading UI remains a bug.
Link one coordinated repair; do not start competing repairs. Where the selected
Security workflow requires a finalized report before remediation, preserve it.

The authorized coordinator maintains canonical work and refreshes summaries from
verified results. Report-only workers return evidence without editing acceptance
records. Preserve original authority through routine handoffs; do not require
another approval for an already-authorized stage. Non-code work uses its own
acceptance, not invented software/deployment gates.

Link exact revisions, evidence and native run identities; do not copy transcripts,
secrets or a second execution ledger. Implementation, verification, publication
and deployment are separate outcomes. The runtime owns execution and recovery.
