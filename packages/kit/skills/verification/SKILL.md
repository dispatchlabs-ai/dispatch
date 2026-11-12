---
name: verification
description: Select and execute verification for a software change, or reassess evidence after a repair or integration.
---

# Verify a change

Use the target's requirements and required checks to establish confidence in the
assigned outcome. Optimize total work through acceptance, including setup, model
calls, repeated checks and repairs. This skill grants no execution or publication
rights and does not expand a bounded assignment into a product-wide audit.

Read [the testing policy](references/testing-policy.md) before choosing retained
checks or removing test code. It owns the shared defaults for creation, ordinary
development and cleanup.

## Select the work

Map the baseline/candidate diff to affected actor goals, shared dependencies and
credible failure paths. Use the existing use-case catalog where available; a
missing catalog does not require creating one. Include required checks and
material authorization, data-loss, recovery and integration risks. Broaden the
selection when coupling, uncertainty or observed failures justify it. Reserve
whole-product acceptance for an assigned release/audit or a change with that reach.

Use existing deterministic checks directly. Add real-interface inspection where
those checks cannot establish the outcome, including rendered interaction for UI
changes. Preserve the target's test-retention and no-test policies.

Keep disposable browsers off the host user's credential stores and profile. A raw
Chrome/Chromium launch needs a fresh `--user-data-dir` plus `--use-mock-keychain
--password-store=basic`; a scratch `HOME` alone still makes macOS prompt to
create a login keychain. Playwright and Puppeteer launchers already add both
flags. Never apply them to the user's regular or production browsing. Passing
assertions do not show the host was undisturbed: report any OS prompt raised.

## Separate feature and release verification

During feature development, verify the changed behavior, affected dependencies
and credible regressions, including focused rendered checks for UI changes.
Read the target company's delivery policy to identify environments, promotion
order, required evidence and artifact identity. Do not assume environment names,
a Demo-to-Production flow, or that every deployment requires full release
qualification. Assign each gate to its actual phase and target. A task that
includes eventual delivery still has separate phases; do not repeat broad
application/platform qualification after every feature change.

Distinguish checks required by the target policy from CI jobs triggered by a
broad path filter and from optional local reproductions. A triggered job is not
by itself a requirement to recreate the whole CI environment locally. Use valid
CI and prior evidence when available. Identify inherited or main-branch changes
separately from the feature delta; they can affect integration and release scope
without making all their behavior part of feature acceptance.

When a known blocker remains unresolved, explain the value of additional later-
phase qualification before starting it; defer work that cannot advance the next
decision. Report pending or blocked gates without claiming they passed. If the
build/publishing pipeline conflicts with the authorized delivery policy, identify
the exact mismatch for correction. State the current phase and why each broad
check is needed. Preserve the target's authorization and promotion requirements.

## Allocate the work

Choose from the installation's available roles, models, reasoning settings and
observed results. Use cheaper models for clear, bounded checks when credible;
reserve stronger reasoning for ambiguous impact, difficult diagnosis and material
review decisions. A lower token price is not proof of lower cost through completion.
Report an unavailable capability rather than silently claiming a model switch.

Independent checks may run concurrently on the same immutable candidate with
separate fixtures, browser sessions, ports or worktrees as needed. Split by
behavior or dependency, not arbitrary file counts. Keep implementation separate
from independent approval. Do not parallelize checks that mutate shared state
without isolation, or duplicate broad reviews simply to use more workers.

Give each worker the candidate identity, selected goals/risks, relevant prior
evidence, expected result and resource ownership. Small workers need concrete
checks and escalation criteria; do not send the entire conversation. Escalate
uncertain or contradictory results to the coordinator for diagnosis or a stronger
available reviewer. No prescribed worker count or universal model order is needed.

## Reassess after a change

Keep the original review baseline and previous candidate. Inspect the intervening
diff and relevant changes in dependencies, configuration, build inputs, fixtures
and environment. Reuse evidence only where those inputs and the covered behavior
remain applicable. State its source revision and why it still applies; never
present a carried-forward result as a fresh run. Unknown provenance requires a
recheck. A documentation-only edit can need a documentation/release check without
repeating unaffected browser journeys; a shared auth change reaches its callers.

Rerun failed cases and affected neighboring paths. Required target checks still
apply. Each independent reviewer/tester issues a current verdict for the new
candidate, identifying new evidence, carried-forward evidence and gaps. An old
verdict does not automatically become approval of a new commit. When separate
workers cover subsets, the coordinator checks their combined coverage before
claiming acceptance; uncovered required goals remain not run or blocked.

## Return evidence

Report the exact candidate, selected goals and their outcomes, reproduction and
impact of findings, evidence provenance, and remaining gaps. Separate observed
defects from optional preferences. Use native usage/time receipts when available;
do not invent cost savings or treat assertion counts as a quality score. Retain
useful evidence in the task record and remove owned disposable scaffolding after
its users finish. Completion requires the assigned outcome and applicable gates,
not merely a successful tool call or worker handoff.
