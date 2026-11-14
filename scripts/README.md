# Reusable npm package release

This prepares reusable packages, not an application deployment. Publication needs
separate explicit authority. Root, Observer and Eval remain application
packages excluded from npm publication. The public library set is Runner, Remote,
Postgres, Backend, Workers, Slack, Google Chat, Email and Fleet. Web ships as an installable browser client and MCP as an optional conversation connector. Install only the
packages your application uses. Backend's central storage peers and Fleet's Slack
peer are optional; explicit subpath imports activate those integrations.

The [v0.19.0 release](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v0.19.0)
provides the nine library archives, Web client and MCP connector archives with their source manifest and SHA-256 checksums.
Web’s GitHub archive references its exact Runner and Backend release archives; MCP references Runner, so npm can resolve either client from its URL. Graph edges in the source workspace stay at the lockstep version. Install matching library archives
together; npm publication remains separate. Future breaking 0.x changes require
a new minor release.

Node 24.22.1 and the repository Nix shell are the supported preparation environment.
All packages remain lockstep at the source version until a release is authorized.
No registry publication is claimed by this source change. Registry ownership of
`@dispatch`, login/2FA and package-name/version availability must be checked by the
release operator; metadata does not grant access. Never republish a used version.

## Prepare and qualify

1. Follow [CONTRIBUTING](../CONTRIBUTING.md), prepare the authorized lockstep version
   with `npm run release -- VERSION`, commit it, then check/build from a clean tree.
2. In `nix develop`, run `npm ci`, `npm run build`, `npm run check`, measured dependency-hash builds
   and the affected release artifacts. Do not run automated tests.
3. `npm run pack:packages -- --out /tmp/dispatch-packages-RELEASE` builds the public
   workspaces in dependency order, checks exact public internal dependencies and
   shipped export/type/bin files, then writes tarballs and `manifest.json` with
   source identity, SHA-256 and npm SHA-512 integrity. The directory must be new.
   Use a **clean** source for a release; `source.dirty: true` is development evidence
   only. Failures leave incomplete output for inspection, not publication.
4. Inspect the actual tar contents, notices, metadata, declarations and files for
   privacy and licensing. Compare `sha256sum *.tgz` with the manifest. Install selected
   packages together in a fresh ESM directory **outside** this checkout. For
   library-only checks, local archive paths work. For Web checks, npm tracks the
   source URL as well as package name and version. Install Web, Runner and Backend
   from their matching GitHub URLs. Supplying local archive paths for those same
   packages can make `npm ls` report invalid dependency sources even with identical
   bytes. Before publication, use an isolated npm cache containing the reviewed
   assets at their intended release URLs. After publication, repeat the URL
   install with an empty cache and verify the lockfile integrity against the
   release manifest. Web-only and MCP-only installs must resolve their transitive archives.

   ```sh
   npm init -y --init-type=module
   npm install --save-dev typescript@6.0.3 @types/node@24.19.1
   ```

   Type-build real imports with NodeNext/strict, `lib: ["ES2024", "DOM",
   "DOM.Iterable"]` and `skipLibCheck: false`. Pi Chord declarations need ES2024
   Promise types. Pi AI 1.5.2 exposes Google GenAI 2.21.0 declarations, which
   reference an optional MCP peer even without MCP use: for full upstream library
   checking install a compatible `@modelcontextprotocol/sdk` (1.32.2 qualified) as
   a consumer dev dependency. This is not a Dispatch runtime requirement. Record
   the audit both before and after installing this optional upstream peer.
   Also install Runner + Backend without central peers, and Fleet without Slack,
   in separate external directories to verify optional features stay optional.
   Resolve the documented public subpaths and use the non-mutating bin usage commands.
   Check `npm ls` and `npm audit --omit=dev`, recording unresolved advisories
   honestly. Do not patch package manifests or rely on workspace symlinks.

## Publish only with separate authority

The preparation command deliberately never invokes `npm publish`. After independent
review and explicit release authorization, from the **retained, reviewed** artifact
directory (do not rebuild different bytes):

```sh
npm whoami --registry=https://registry.npmjs.org/
# Verify org/scope authority and absent versions with npm view before proceeding.
# Dry-run each reviewed archive first, then inspect npm's package file list.
node --input-type=module -e '
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (manifest.source.dirty) throw new Error("Release source must be clean");
for (const pkg of manifest.packages) {
  execFileSync("npm", ["publish", pkg.tarball, "--access", "public", "--ignore-scripts", "--registry=https://registry.npmjs.org/", "--dry-run"], {stdio:"inherit"});
}
'
```

For authorized actual publication remove **only** `"--dry-run"` from the reviewed
command, retaining manifest order. This is a manual authenticated release, not
Pi's CI provenance/OIDC flow; do not claim npm provenance without its supported
trusted environment. No GitHub Actions or persistent credential setup is added.

Before each actual publish verify the tarball integrity against the retained
manifest and that `npm view NAME@VERSION` reports an absent version, not an auth or
network error. If resuming a partial release, compare published
`npm view NAME@VERSION dist.integrity` against that manifest entry before skipping
it; a mismatch is a stop, not permission to replace bytes. Record each npm receipt.
Afterward, verify every registry `dist.integrity`, install the versioned registry
packages in another external consumer and repeat import/type checks without local
tarballs. Publish immutable source tags/assets only under that separate authority.
This does not deploy or change an installed application.

## Pi reference and deliberate differences

Rechecked November 13, 2026 against released Pi 1.5.2
(`b4afdddf44e059c67ccf5097e5317d913521b470`): Durable exports/types/files and exact
dependencies, `scripts/publish.mjs`, `scripts/check-package-install.mjs` and
release guidance. Runtime pins use that released version.
Dispatch uses a small artifact preparer and the manual npm commands above instead
of Pi's larger release framework, tests or provenance automation. Exact internal
versions, emitted types, dependency order, reviewed tarball bytes and independent
consumer installation are retained. Version preparation remains `release.ts`.
