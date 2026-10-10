---
description: Audit package changelogs against the relevant commit history
argument-hint: "[release tag or commit range]"
---

Audit changelogs. Requested baseline or range: $ARGUMENTS

1. Read `CONTRIBUTING.md`, relevant package READMEs, and their existing changelogs. Establish the range from the supplied baseline or the latest applicable release tag. If no release tag exists, audit from repository creation and say so. Use the lockstep SemVer policy in `CONTRIBUTING.md`; do not infer a release from manifest metadata alone.
2. Inspect the commits and affected files in that range. Map meaningful behavior, API, compatibility, and operational changes to the package that owns them. Distinguish implemented changes from drafts or planned capabilities.
3. Compare those changes with each affected package's `Unreleased` entries. Find missing, duplicate, misleading, or incorrectly attributed entries. Avoid filling the changelog with mechanical cleanup and minor documentation edits.
4. Correct current unreleased entries in the existing format, linking relevant issues or PRs where supported. Summarize user-visible effects accurately. Do not rewrite published release sections or copy an entry across packages unless each package has a distinct user-facing effect to describe.
5. Report the audited range, changed entries, and anything requiring a product or release decision. Run the documented documentation checks.

This is a changelog audit. Do not bump versions, create tags/releases, or publish artifacts unless that work is also requested. The release command prepares versions and changelogs but does not publish; use the [release procedure](../skills/release.md) for release work.
