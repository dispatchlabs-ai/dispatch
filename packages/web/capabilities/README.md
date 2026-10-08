# Dispatch native capabilities

`@dispatch/pi-capabilities` is a private, host-installed code artifact for **Pi Durable 1.0.4**, built from the same TypeScript modules used by Dispatch Web. It is not an agent bundle or a plugin loader. No registry publication, service deployment or runtime qualification is implied by building it.

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
| `@dispatch/pi-capabilities/web` | `createWebResearch` | `dispatch-web`, tool `web_run`; inject a host `WebBackend`. Native web-reference document kinds/versions stay unchanged. |
| `@dispatch/pi-capabilities/web-backend` | `WebBackend` type, `WebBackendError` | Backend must enforce URL/DNS/redirect and network safety, bound reads and honor cancellation. Search/provider credentials remain host-owned. The Dispatch HTTP/search backend is **not** included. |
| `@dispatch/pi-capabilities/image-gen` | `createImageGen` | `dispatch-image-gen`, tool `generate_image`; inject host `Models` with OpenAI authentication and supply a writable local execution environment. Uses the existing fixed OpenAI Images endpoint/model defaults and local output/evidence files. |

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

Build/type checks and archive-content inspection are packaging evidence only. Installation in a separate host, tool execution, restart/recovery, provider/network behavior and credential/environment integration require separately authorized functional qualification. No runtime tests are included or authorized by this package.

Native contract: [Pi Durable v1.0.4 extensions](https://github.com/earendil-works/pi/blob/v1.0.4/packages/durable/README.md#extensions).
