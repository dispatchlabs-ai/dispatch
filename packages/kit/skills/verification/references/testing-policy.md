# Testing policy

Verify working behavior with the lowest-total-cost credible method. Prefer relevant
builds, static checks and focused disposable behavioral/API checks. This policy
covers new projects and ongoing development; explicit user choices or applicable
target policy can override the defaults.

- Do not introduce new unit or integration tests by default at any project age.
  An agent's cost-benefit judgment alone does not override this preference.
- Add no initial E2E suite, test frameworks or generated test boilerplate. Retained
  API/E2E checks may become worthwhile when stable behavior, repeated failures or
  repeated verification justify their total cost. Do not manufacture a suite for
  a stub or a framework merely to retain a one-off check.
- Assess existing tests individually during authorized cleanup. Preserve useful
  checks, required suites, runtime safeguards and required evidence. Remove
  authorized low-value tests together with obsolete fixtures, dependencies,
  scripts and CI wiring; a category-wide deletion is not an assessment.
- Count authoring, maintenance, execution and agent-context costs as well as the
  material failures prevented or repeated work saved. Favor stable observable
  behavior over implementation details. Missing automated coverage alone is not
  a defect; identify the concrete risk or required verification gap.
- Use focused feedback while building. Concentrate formal review and broader
  acceptance at the end of the requested scope. After repairs, rerun failed and
  affected checks, carry forward evidence whose inputs remain applicable, and
  broaden only for demonstrated risk, uncertainty or explicit requirements.

A retained test restriction is not permission to skip verification or an excuse
to stop useful work while seeking a routine exception. Use permitted disposable
checks and preserve the results in the existing task record. Keep required CI and
verification commands even when adding new tests is not authorized.
