# Open-source standards

Read this guide when developing, documenting or preparing a release of any
Dispatch package. These public standards apply proportionately to the package's
scope and maturity. [CONTRIBUTING.md](CONTRIBUTING.md) owns the development
commands, testing policy and publication workflow.

## Public information boundary

Keep secrets and private company, customer, infrastructure and personal
information out of source, documentation, examples, Git history, commit messages
and release artifacts. This includes live installation addresses, private wiki
links, account/request/session identifiers, personal paths, raw operational
logs, conversation transcripts and authenticated captures. Review image content
and embedded metadata as well as text.

Use synthetic examples, reserved domains such as `example.com`, and public
qualification summaries. Retain necessary private evidence in approved private
records or gitignored `.local/`; keep credentials in an approved secret store.
Exclude private inputs from package archives, container build contexts and other
published assets even when Git ignores them. Preserve license notices, upstream
credit and approved public author attribution.

Before committing or publishing:

1. Review the staged changes and proposed commit message against this boundary;
   visually inspect changed images and check their metadata.
2. Before a push, review every outgoing commit and its message. Before a release,
   inspect release notes and the actual archives, packages, images and other
   assets being published. Removing a value from the latest files leaves earlier
   commits unchanged.
3. Use available secret scanning alongside this review. A clean scan does not
   establish that operational details, screenshots or transcripts are public.
4. Remove private material from all unpublished commits and assets before
   publication. If it is already public, report the affected locations privately
   and arrange remediation without repeating sensitive values in public reports.

## Independently useful packages

- Keep packages focused on supported user goals. State intended users,
  prerequisites, compatibility boundaries and known limitations; keep each
  package's use cases and documentation with its implementation.
- Make public setup and verification reproducible without access to a
  maintainer's private infrastructure, paths or records. Document optional
  integrations and the credentials users must supply themselves.
- Give a new user one small, useful result with an action and an expected output.
  Use synthetic data for examples. When an agent can operate the package, provide
  a copyable prompt linking to public operational guidance and a manual path.
- Verify documented workflows from a clean checkout using the repository's
  [permitted checks](CONTRIBUTING.md#testing-policy). State the platforms and
  client integrations actually checked, and label remaining qualification work.

## Consistent interfaces

- Build supported clients on shared application operations and authorization.
  Preserve permissions, validation, data visibility and usage attribution across
  interfaces for the same identity and scope.
- Document inputs, outputs, errors, side effects, continuation and retry behavior.
  Keep machine-readable contracts current where the package exposes them;
  schema coverage alone does not establish working integration.
- Keep commands predictable, with useful exit codes and separate structured
  output and diagnostics. Distinguish ordinary authenticated service operations
  from direct-storage administration.

## Licensing and release claims

- Preserve the [MIT license](LICENSE), copyright notices and upstream licenses.
  Keep public authorship and attribution accurate.
- Publish reproducible, versioned artifacts with supported installation paths,
  compatibility notes and package changelogs. Follow the existing
  [release workflow](CONTRIBUTING.md#versioning-and-releases).
- Describe maturity and availability accurately. Distinguish implemented source,
  observed verification, distributed artifacts and deployed installations. Claim
  verified setup, platform or agent support only when the documented workflow
  has actually succeeded; record limitations without private installation data.
