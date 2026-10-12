# Dispatch native capabilities

`@dispatch/pi-capabilities` is a private, host-installed code artifact for **Pi Durable 1.1.0**, built from the same TypeScript modules used by Dispatch Web. It is not an agent bundle or a plugin loader. No registry publication, service deployment or runtime qualification is implied by building it.

## Build and distribute

From a clean, reviewed repository revision, using the repository's Nix toolchain and locked dependencies:

```sh
npm run build:capabilities --workspace @dispatch/web
mkdir -p .local/capabilities
npm pack ./packages/web/capabilities --ignore-scripts --pack-destination .local/capabilities
```

The regular application build also compiles this artifact. Nix builds retain the package directory at `$out/share/dispatch-web/capabilities`, ready for `npm pack`. The explicit `files` allowlist includes only the five compiled module pairs (JavaScript/declarations); npm also includes this README and package metadata. No credentials, databases, live settings, application server or lifecycle scripts belong in the tarball. Build before packing: packing alone does not compile or establish completeness.

Record the source commit and tarball SHA-256 with any distribution; version `0.1.0` alone is not immutable provenance. Review the artifact and its dependency lock in the consuming host. Install the approved tarball through that host's normal dependency/deployment workflow with scripts disabled, pinning the exact artifact and peer versions. This private package is not published to npm. Do not ask Dispatch's bundle importer to install it.

## Exports and host responsibilities

| Import subpath | Exports | Native names / requirements |
| --- | --- | --- |
| `@dispatch/pi-capabilities/coding` | `Coding` | `coding` prompt sections; install stock `CodingTools` from `@earendil-works/pi-durable/tools` separately. `files-and-commands` requires both, with tools `read`, `write`, `edit`, `bash`. |
| `@dispatch/pi-capabilities/skills` | `Skills`, `SkillBindingsDoc`, `SkillSnapshot` type | `dispatch-skills`, tool `load_skill`; host admits authorized immutable skill snapshots into the conversation document alongside agent configuration. No catalog, package reader or automatic skill assignment. |
| `@dispatch/pi-capabilities/web` | `createWebResearch`, `WebCapability` and `WebResearchAccess` types | Call `createWebResearch(backend, access)` to obtain `reading` (`dispatch-web-read` / `web_read`), `search` (`dispatch-web-search` / `web_search`) and `legacy` (`dispatch-web` / `web_run`). Native web-reference document kinds/versions stay unchanged. |
| `@dispatch/pi-capabilities/web-backend` | `WebBackend` type, `WebBackendError` | Backend must enforce URL/DNS/redirect and network safety, bound reads and honor cancellation. Search/provider credentials remain host-owned. The Dispatch HTTP/search backend is **not** included. |
| `@dispatch/pi-capabilities/image-gen` | `createImageGen` | `dispatch-image-gen`, tool `generate_image`; inject host `Models` with credentials suitable for the [image-generation route](../docs/usage-guide.md#image-generation) and supply a writable local execution environment. Uses credential-specific Codex subscription/OpenAI API-key routes, route-specific model defaults and local output/evidence files. |

For subscription images, the host's resolved `openai-codex` OAuth authentication must include `chatgpt-account-id` from the same credential's saved account selection. Dispatch's `server/codex-image-provider.ts` wrapper supplies this while retaining Pi login/refresh ownership; that application wrapper is not a portable-package export. API-key image access does not require it. Source support alone is not independent-host or hosted execution qualification; the linked guide records Dispatch's local reference-edit evidence.

For web tools, inject a safe `WebBackend` plus trusted `WebResearchAccess` callbacks: `authorize(instanceId, capability, signal)` checks current permission for each operation, including saved-reference reads; `search(instanceId, query, signal)` resolves current credentials/grants and performs search. Do not derive authority from caller arguments or historical agent configuration, and never put secrets in native documents. Install all three returned extensions before recovery; select only reading/search for newly configured agents. Legacy registration preserves persisted calls, not permission to bypass disabled operations.

These modules are trusted host code, not a sandbox. Coding tools can access files and execute commands with the environment's authority; a working directory is not an isolation boundary. Image generation makes paid external requests and writes local files. Web retrieval sends queries/URLs externally. Skills provide instructions, not permission grants. Shared-conversation, agent-management and authenticated connection extensions remain Dispatch-owned and are not portable exports.

## Native installation

Install implementations into the process registry **before opening/recovering stored work**. For example, the coding extension setup is:

```ts
import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Coding } from "@dispatch/pi-capabilities/coding";

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Coding);
// Pass registry to Harness.open with host storage, models and environment.
// Set explicit Harness settings and per-conversation extensions/tools.
```

**Installation is not authorization.** Pi's default is to select installed extensions; set explicit harness defaults and explicit per-conversation extension/tool selections so adding code cannot silently grant it to unrelated agents. Preserve existing stored extension/tool/document names and compatible implementations across restart. Do not register both the packaged and source-imported copies under the same names. Dispatch itself continues importing its source modules; this artifact provides those implementations to other reviewed hosts without rewriting Dispatch's runtime.

Use stock Pi storage, registry, tasks and recovery. There is no dynamic discovery, package hook, custom executor or automatic upgrade mechanism. Definition bundles continue carrying capability requirements only. An implementation upgrade is a host deployment with compatibility review, not an agent-definition import.

Native replay declarations are unchanged: skills are read-only/replay-safe; web and image requests are replay-unsafe. A lost external response can have an uncertain outcome; packaging does not add exactly-once external execution. Recovery also needs the compatible host environment, credentials, native/application storage and relevant files—not just this tarball.

## Qualification

Build/type checks and archive-content inspection are packaging evidence only. [Dated portability observations](../docs/handoff.md#portability-manual-qualification--october-8-2026) cover bounded independent-host installation/execution/reopen of the earlier artifact; they do not qualify the revised web factory or every provider/credential integration. [Native web split observations](../docs/handoff.md#wp-054--native-web-research) record separate extension gating/recovery evidence and its limits. No runtime tests are included or authorized by this package.

Native contract: [Pi Durable v1.1.0 extensions](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md#extensions).
