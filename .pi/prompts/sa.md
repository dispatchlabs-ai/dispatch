---
description: Prepare a security advisory draft grounded in verified evidence
argument-hint: "<advisory URL, draft path, or issue>"
---

Prepare or revise a security advisory draft for: $ARGUMENTS

Read the supplied material, repository instructions, relevant code and contracts, and any verified fix. Treat reported impact and root causes as claims to check. Keep private reports and reproduction details within their authorized audience.

Establish the affected component and versions or revisions, required conditions, demonstrated impact, supported cause, fix, and regression coverage. Distinguish confirmed facts from hypotheses; do not invent affected releases, severity scores, CVE identifiers, or validation results. Describe mitigations only when their effect is supported.

Write a concise draft covering the issue, who is affected, impact, resolution or mitigation, and supporting references. Identify missing evidence and the publication decision separately. Use an existing draft path when supplied; otherwise return the draft in the conversation. The existence of this prompt does not imply this design-stage repository has released artifacts or a known vulnerability.

Changing a remote advisory, publishing, requesting a CVE, or messaging others requires authorization for that action. Reuse authorization already present; a request to prepare a draft alone does not grant it. Verify any authorized remote update and report its actual state.
