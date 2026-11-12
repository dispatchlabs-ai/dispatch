# Company manifest

`factory.yaml` is agent-read directory data as well as its existing installation
configuration. These fields do not add a parser, grant, schedule or workflow engine.
Preserve the installation's existing fields and repository inventory shape.

```yaml
name: example-company
wiki: https://wiki.example.invalid
connections:
  company-wiki:
    kind: mcp
    purpose: Maintain company project knowledge
    runtime_binding: installation-provided-wiki
workflows:
  development: agents/development/operations.md
repositories:
  web: https://git.example.invalid/example/web
  api: https://git.example.invalid/example/api
projects:
  customer-portal:
    name: Customer Portal
    wiki: https://wiki.example.invalid/wiki/project-customer-portal/
    repositories: [web, api]
    work:
      system: wiki
      url: https://wiki.example.invalid/wiki/project-customer-portal/#section-work
      connection: company-wiki
agents: []
```

Synthetic example only. Use actual existing endpoints, bindings and workflow
paths, and verify published pages before recording their URLs.

- `wiki`: company wiki base URL. It is not an assumed MCP endpoint. A project's
  explicit `wiki` URL is canonical; verify any different host belongs to the
  intended company before use.
- `connections`: named purpose, kind and existing `runtime_binding` (tool/service
  identity or maintained binding document). Record only non-secret metadata.
  Actual endpoints, credentials and per-agent grants remain installation-owned.
- `repositories`: prefer stable keyed URLs for new inventories. Existing lists
  stay lists: use each entry's `id`, or its exact `owner/name` when that is the
  established identity. Do not rewrite a runtime-owned inventory for this skill.
- `projects`: stable keys with display name, required canonical `wiki` URL and
  repository references. Projects can share repositories; a project can span
  repositories. Do not add a second per-project config directory.
- `projects.<key>.work`: optional explicit work source. For Linear/Jira, name that
  system, the exact canonical workspace/project URL and its declared connection.
  Omit it for inline wiki work; follow the project page's actual links.
- `workflows`: paths to existing company workflow instructions, relative to this
  agents repo. Agent definitions still own behavior. Only declare installed source;
  do not create roles or enable execution to complete this directory.
- `agents` and other deployment fields retain their existing meaning. Empty
  `projects`/`connections` means no entries are registered, not that no work or
  connections exist. Search current knowledge before adding entries.

For restricted agents, the host/coordinator supplies the selected non-secret
manifest context with its source identity through the existing handoff. Reading
the skill alone cannot read a file outside its resource catalog. Do not copy
live company configuration into these shared templates to work around that.
