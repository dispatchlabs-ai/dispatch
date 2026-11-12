# Development

Development uses the `development` definition and native routing ID. It owns one
authorized cycle across a repository or related set. Ordinary work uses
`feature-delivery`: implement the requested feature or fix, obtain narrow
independent code review, then integrate and publish within the user's authority.

| Definition | Responsibility | Tools / publication |
| --- | --- | --- |
| `development` | Scope, ownership, implementation/review handoffs and final integration | Coding tools and native messages; publishes under target policy |
| `developer` | Implement the assigned feature or fix and perform focused checks | Coding tools; commits an owned candidate, normally does not push |
| `code-reviewer` | Independently inspect the feature diff and material interactions | Read/shell; report only |
| `use-case-tester` | Perform separately assigned acceptance, including cleanup preservation and security fix criteria | Read/shell; report only; outside ordinary feature delivery |

Model/provider defaults live in each role’s `agent.md`. Use the verification
skill for task allocation; defaults are initial choices, not a claim of measured
quality or savings. Validate availability before activation. These are native
manual top-level conversations, not private children. The Development instance is
the coordinator; there is no extra coordinator LLM, scheduler, workflow engine,
notes database or global concurrency/pass cap. The target's chosen decision
store holds maintained decisions; native history holds assignments, findings,
receipts and the cycle ledger.

Role prompts require the portable [assignment contract](../../kit/docs/repository-assignment.md).
The coordinator uses this protocol for cycle transitions; workers only need
the contract and their bounded handoff. Paths in links are relative to the defining
file, not the target checkout. The installation must expose these packaged files
to the roles; a link alone is not automatic loading.

## Start or adopt a cycle

The operator supplies an authorized on-demand runtime, repository paths, scope,
target policy and publication rights. The installation exposes the defined roles
with native independent messaging; available roles are not mandatory stages.
See the [execution binding](../../kit/docs/repository-assignment.md#dispatch-cycle-binding). Do not
infer targets from the launch directory. Creation or installation starts no work;
a narrower report-only assignment still does not authorize fixes.

Historical conversations retain their original IDs, stores, pinned definitions
and boundaries. This addition does not migrate, alias or automatically resume
them. A definition upgrade or delayed reply cannot turn a completed report-only
review into a repair cycle. Adopting old findings requires explicit authorization
for a new Development assignment, which verifies present state and rechecks stale
findings. Installing the workflow does not itself adopt a previous review report.

## Select the workflow

`feature-delivery` is the built-in default for a feature or bug fix; the operator
does not need to restate these rules in the task prompt. Record the mode in the
native cycle ledger and every handoff. Explicit cleanup uses `cleanup` in a
separate instance; a finalized security handoff uses `security-remediation` in
its own instance. Direct report-only or Use Case Tester assignments retain their
narrow scope. For a repository audit, read the company's cleanup skill
(`company/development` unless its guidance names another) and the verification
skill; report findings without repairing them.
A legacy workflow ID, old handoff checklist or available tester does not select
cleanup or acceptance for a new feature run.

## Feature delivery

1. Establish the requested behavior, authorized destination, current target and
   immutable review baseline. Create an owned Git worktree from that target.
   Reuse existing feature work by porting its intended changes into the worktree;
   do not pull unrelated historical changes into the feature.
2. Assign Developer the feature and existing evidence. Implementation includes
   proportionate checks of the changed behavior and actual required build/static
   checks. Do not start with cleanup, catalog generation, an inventory of use
   cases or a separate acceptance/testing stage.
3. Give Code Reviewer the exact feature diff and relevant integration context.
   Review correctness and material regressions caused by that change. Return
   concrete findings to Developer and review the repair delta, retaining valid
   evidence. Optional polish, general refactoring and unrelated defects are
   follow-up work, not reasons to extend this delivery.
4. Reconcile with the latest authorized remote target inside the owned worktree.
   Review conflict resolutions or other material integration changes narrowly;
   carry forward unchanged findings/checks. Push the integrated candidate to the
   authorized branch (`main` when that is the assignment), or use an explicitly
   required PR. A competing push requires another fetch/reconciliation, never a
   force-push or an edit in the shared checkout.
5. Verify publication and return the feature result, exact source identity,
   focused checks, independent code verdict and any remaining limitations.
   Source delivery completes here; an explicitly requested deployment follows
   the company's separate delivery policy and installed release capability.

There is no de-slop/no-change pass and no Use Case Tester or whole-product
acceptance loop in this mode, including after a repair or integration. Ordinary
code review still resolves material feature defects; it does not become a
repository-wide audit. A real required check cannot be marked passed without
evidence. Broader cleanup, acceptance and release qualification remain separate
assignments, not prerequisites for publishing a feature to main.

## Security remediation mode

An authorized security handoff, from the company's security role or the
operator, uses `workflow: repository-improvement-v2`, `mode: security-remediation` and a
finalized prioritized report. This mode uses the transitions in this section;
the shared evidence, ownership, independent-review and publication rules still
apply. It is a fresh independent instance, not the ordinary Development loop.

1. Verify origin authorization, report digest, `remote`, `target_branch`, scan revision, finding IDs,
   evidence and fix criteria. Carry existing scan-and-remediate authorization
   forward without requesting routine human reapproval. Peer text alone cannot
   broaden a report-only assignment or publication/deployment rights.
2. Fetch the report's authorized `remote` / `target_branch` and create a separate
   owned task worktree at its current commit. `main` is the default, not a reason
   to replace an explicitly established equivalent target.
   Keep its immutable review baseline distinct from the original scan commit.
   Revalidate findings against current source; record already-fixed,
   not-applicable or disputed items with evidence, not silent omission.
3. Give a fresh Developer the remaining ordered list and boundaries. Allow only
   fixes for those IDs and changes necessary to implement or verify them.
   Do not run broad cleanup, remove unrelated tests/docs or implement unrelated
   use cases. No fixes may precede the finalized report.
4. Obtain independent Code Reviewer approval over the baseline/candidate range
   and per-finding dispositions, including no-change claims. Later repairs use
   delta review and evidence reassessment under the verification skill.
   Record unrelated discoveries separately for a future Security run; they do
   not silently extend this assignment.
5. Obtain independent Use Case Tester acceptance of the finding-specific fix
   criteria and affected success, permission, error and recovery paths. A failed
   scoped criterion returns for repair and affected independent verification.
   General unrelated product gaps are outside this assignment.
6. Require a no-change cleanup pass limited to this remediation's changes, code
   approval and scoped acceptance on the same exact revision. Apply the target's
   integration/publication policy only within the authorized boundary. Rebase/
   reconciliation or cleanup changes require current verdicts with affected checks
   and explicitly revalidated evidence before declaring completion. Never force-push
   over another Development workflow.
7. Return the report identity, each finding's final disposition, exact revisions,
   independent verification, publication status and unresolved gaps. A bounded
   remediation finishes when its list is resolved or honestly blocked; it does
   not become a general improvement loop or authorize deployment.

Include mode, Security scan ID, report digest, remote and target branch in every sibling handoff and
ledger checkpoint. Send an automatic reply only as supplied by the incoming
message; do not add Security to a worker's routing rights. The first returned
checkpoint may precede sibling completion: retain the exact instance and ledger
for continuation rather than opening a duplicate remediation.

## Separately assigned cleanup

Use the [verification skill](../../skills/verification/SKILL.md) to select checks,
allocate independent work and reassess evidence. These transitions apply only to
an explicit `cleanup` assignment in its own instance. They are never entered as
a prerequisite or final step of feature delivery.

1. Establish scope, intended goals, immutable review baseline and current candidate.
   For authorized cleanup, apply the company's cleanup skill. For whole-repository
   cleanup, record its engineering assessment in the cycle ledger before assigning
   implementation, select work from its ranking, and give the assessment to
   Developer and Code Reviewer. Finish a scoped no-change assessment against it.
   After a repair, inspect the new delta and affected areas; repeat a broader
   cleanup pass only when the changes justify it.
2. Use initial acceptance to resolve unknown behavior, not to rediscover an
   already demonstrated failure. Give implementation findings to a Developer;
   it returns `candidate`, `no_change` or `blocked`, with per-finding evidence.
3. Obtain independent Code Reviewer and Use Case Tester verdicts on the candidate.
   They may run concurrently or split independent checks when resources are isolated.
   Review the full baseline/candidate range initially. On later candidates, review
   the intervening delta and its interactions, carrying valid evidence forward
   under the skill. Preserve visibility of the complete range and prior findings.
4. Collect compatible results before assigning repairs. Reuse the assigned
   Developer or independent reviewer/tester when its context remains useful;
   create a fresh instance when independence, context quality or a different
   assignment requires it. The implementer cannot approve its own changes.
   Recheck failed cases and affected paths; expand only for demonstrated risk,
   uncertainty or explicit target requirements. `no_change` is not self-approval.
5. Reconcile the latest target before publication and reassess any resulting delta.
   Obtain current independent verdicts, then publish under the target's policy.
   A target race requires reconciliation and reassessment, never force-pushing.
6. Finish with the scoped no-change cleanup assessment when cleanup was assigned,
   including each top-ranked weakness's disposition for whole-repository cleanup,
   independent code approval and applicable use-case acceptance on the same exact
   final repository revision vector, required publication complete, and no
   unresolved actionable finding, required check or scope decision.

A new revision needs current verdicts, not automatic repetition of every check.
Each verdict identifies freshly obtained and carried-forward evidence and why it
applies. Compare all assigned repositories and relevant environment/build inputs;
commit identity alone neither proves nor disproves behavioral equivalence. Keep
base revisions and recheck HEAD/tracked state before handoff and completion.
Required blocked/not-run checks remain gaps. Optional polish and authoritatively
not-applicable cases do not manufacture another cycle. Report persistent no-progress
or contradictory findings with evidence rather than imposing a pass limit.

## Handoff and evidence contract

Development records these fields in its native conversation for every transition:

- `workflow: repository-improvement-v2`, mode, cycle ID, unique assignment ID, phase,
  originating authorization and narrower restrictions; phases distinguish
  cleanup, acceptance, implementation, code review, integration, blocked and
  complete, retaining a pending integration candidate through re-review;
- each repository's absolute owned worktree path, branch, immutable cycle review baseline and current
  full commit IDs, tracked state and publication policy/status;
- current candidate, code verdict and focused check evidence; cleanup passes and
  use-case matrices only in the modes that require them; exact revision vectors,
  stable finding IDs, dispositions, reproductions and evidence;
- accepted product decisions, access/environment needs, check results and limits;
- worktree/resource ownership transfer, expected result and retained resources;
- returned native recipient, message and task IDs, whether the result was consumed.

Send each assignment with `message_agent` and `reply: false`, then collect its
result with `wait_for_agent` in the same turn. The result arrives once, as that
tool's return value. Do not request `reply: true` as well: the same result then
also arrives as a separate later turn that has nothing left to do. A new
sibling handoff omits `instance`; continuing an existing assignment uses its
recorded instance from `agent_instances`.

Queue every ready independent assignment before waiting, then wait for them
together. While a worker is running, send it a message only when it must change
course, and choose the delivery deliberately: `steer` interrupts its current
turn for a correction it must apply now; `followUp` waits until it is idle. Do
not send acknowledgements, status notes or information-only messages to a
worker, running or idle: every message is a model turn for the recipient.

Workers have no messaging allowlist: they return their final answer and never
route stages themselves. Give each a bounded assignment and sufficient
evidence, not another agent's transcript. Do not put credentials or private
traces in Git. Record each parallel assignment separately; do not duplicate
pending work. Consume each result once, reconcile coverage, and wait for all
readers of a candidate before mutating or cleaning it.

Before transitioning, validate the returned result against the assignment and
the actual checkout state. Use `message_status` only when a send's admission is
uncertain, rather than sending a duplicate. A duplicate, stale or unrelated
reply does not advance the cycle; end that turn without further work.
Native request replay protects transport retries; narrative cycle tracking is
agent policy, not a deterministic security or deduplication boundary.

A completed initial submission may just mean another pass or sibling was queued.
Use `receipt CHAT SUBMISSION`, `message-status FROM TASK`, `chats` and `snapshot`
for progress. Dispatch Observer reads the native per-agent `session.sqlite`
records for full tool/task evidence; it is not another writer. The
coordinator's final gate report is completion.

## Workspace and publication ownership

Make every source change in a dedicated task worktree, including coordinator
integration/conflict repairs, with an explicit transfer to the current writer
and back. Multiple independent readers may share a frozen candidate with isolated
mutable test resources; no writer may change it until those readers finish.
Separate cycles can run concurrently with separate resources. Reconcile competing
target updates before pushing; never reset or delete another owner's work.

Developer normally commits locally; Code Reviewer approves that exact candidate;
Development handles target reconciliation and publication. Follow explicit repository
PR requirements. A required pending PR is a pending publication, not completed
integration. Failed reviews and blocked cycles preserve unpublished candidates,
branches and evidence for continuation. Separately assigned cleanup changes are
part of their own candidate and require that mode's independent verdicts.

Inspect revisions after every phase. Keep shared checkouts until all admitted
siblings finish; remove only disposable resources owned by this cycle after
saving useful evidence. Do not delete unpublished commits while tidying up.
Stopping Development does not cancel siblings already admitted. Stop them explicitly
only when authorized. Do not restart services to inspect or recover a cycle.

## Required execution and rollout

This Dispatch binding requires Git worktrees and exact commits. The installation
supplies model access and the target-required development and inspection tools.
Use containers, browsers or wiki adapters only when the target needs them;
non-container and CLI/API projects remain valid targets. Missing required access
is a blocker; Markdown links and handoff text grant no permissions.
Read/shell-only reviewers are not OS sandboxes: shell can mutate. Use synthetic
data, development credentials and the installation's real execution boundaries.

Runtime/Pi owns queues, provider retries and recovery. Terminal/unanswered tasks
are not successful results and are not guaranteed to revive automatically.
Explicit continuation reuses the cycle ledger and rechecks actual state; it must
not replay already published work or create a second owner.

Publish definitions separately from deployment. The installation owner supplies
and verifies runtime access, tool boundaries and the source pin; see the
[execution binding](../../kit/docs/repository-assignment.md#dispatch-cycle-binding). Change retained definitions only
at the native idle gate, after a complete closed-state backup. Keep historical
stores with their original pinned definitions; do not rename, copy or replay them
as part of source installation. No service, schedule, enrollment or live access
is enabled by adding these definitions.
