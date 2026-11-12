# OpenAPI guidance

When the target requires OpenAPI work, create or complete authoritative OpenAPI specs for repository-owned HTTP APIs. Preserve the project's code-first or spec-first source of truth; regenerate outputs rather than maintain divergent copies. If there is no HTTP API, report this requirement as not applicable.

- Inventory every supported path/method, including internal and administrative endpoints. Document operation purpose, parameters, request bodies and media types, response schemas, headers and status codes, known errors, authentication and authorization requirements. Cover pagination, callbacks and webhooks where applicable.
- Use meaningful tags, stable unique `operationId` values, reusable components, resolvable references and useful examples. Preserve specs, referenced schemas and generation sources/tooling during cleanup.
- Reconcile the specs with implementation and the authoritative use-case catalog. Distinguish planned contracts from implemented operations; preserve intended behavior and report mismatches rather than silently redefining it.
- Validate with tooling compatible with the declared OpenAPI version. Compare the complete route/method inventory and representative actual responses against the specs; syntax validation alone does not establish coverage. Use existing tooling and the target's test policy; use disposable checks when retained suites are forbidden. Report uncovered operations and unverified behavior.
