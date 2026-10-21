# Host-owned API credentials

`UserCredentials` supplies a Pi `CredentialStore` for trusted local applications.
It supports native OS storage, a user-approved external vault helper, session-only
keys and explicitly selected environment compatibility. It never loads `.env`.

```ts
import { UserCredentials, credentialCommand, withPrivateProviderErrors } from "@dispatch/runner";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const credentials = await UserCredentials.open({
  root: process.cwd(),
  providers: [{ id: "anthropic", origin: "https://api.anthropic.com",
    environmentVariable: "ANTHROPIC_API_KEY" }],
});
const models = createModels({ credentials: credentials.store,
  authContext: credentials.authContext });
models.setProvider(withPrivateProviderErrors(anthropicProvider()));

// For a dedicated setup entry point:
// await credentialCommand(credentials, process.argv.slice(2));
```

The host registers trusted provider IDs, HTTPS origins and environment variable
names. Keep these bindings consistent with its actual Pi providers. Saved origins
must match on subsequent reads; changing an origin requires explicit setup again.
This is a configuration drift check, not network enforcement against malicious
host code. Do not allow model instructions to select credential destinations.

`open` does not read a key or create a profile. `read` resolves the configured
source; missing configuration returns `undefined`. A failed configured source
throws a `CredentialError` with a stable code and a message that excludes native
or helper error output. `status` and the store's `list` read source metadata only.
They neither retrieve native values nor execute a helper. Source metadata does
not prove that a saved credential is usable.

`setKey` writes an API key to native storage. `setHelper` verifies an absolute
executable outside the project, then saves its program/arguments and provider
binding in private user configuration. `remove` removes a native value and its
binding, or only a helper binding; it does not revoke a provider key or delete a
vault item. Native key rotation updates its existing entry; switching to a helper
removes that entry. If saving the profile fails, native changes are rolled back.
If rollback also fails, a recovery error identifies the native service/account
for cleanup. A failed operation is never reported as completed setup or removal.
Native storage and the profile are separate stores: a process crash or power loss
between their writes can still require inspecting the profile and OS store.

`useSession` and `useEnvironment` override a source for this process only;
`clearSession` drops those references. JavaScript does not guarantee memory
zeroization. The supplied `authContext` disables implicit ambient-provider
authentication. `useEnvironment` explicitly selects only the variable declared
for that provider and never writes environment variables.

The Pi store is read-only except for deletion. Manage keys through the setup
methods rather than `Models.login`. It rejects `modify` and does not persist
OAuth credentials. Helpers rerun on every resolution and own any expiry/refresh
of their returned API key. Existing applications can continue supplying their own
Pi credential stores, including stores with full OAuth support.

## Provider error privacy

Some providers echo rejected API keys in errors. `withPrivateProviderErrors`
wraps chat streams and deferred chat retrieval before messages reach the runtime.
It snapshots mutable partial messages and replaces raw errors with fixed safe
categories. Pi's existing retry and context-overflow classifiers select those
categories, preserving retry/compaction behavior without retaining raw details.
Authentication failures remain actionable; detailed provider diagnostics are
withheld. This wrapper does not cover image/classifier operations, cancellation
RPCs or host telemetry callbacks. Do not log raw SDK errors or request headers in
those integrations. The scaffold applies it to both chat providers.

## Native storage and host configuration

The optional MIT dependency `@napi-rs/keyring` is pinned to 2.1.2 and loaded only
when native operations are requested. It supports macOS Keychain, Windows
Credential Manager and Linux Secret Service. Linux entries explicitly require
`secret-service`; the dependency's automatic keyutils fallback is disabled.
Missing binaries, absent/unavailable stores and locked entries produce errors.
No plaintext secret file is created as a fallback.

Profiles live in `$XDG_CONFIG_HOME/dispatch/credentials` (default
`~/.config/dispatch/credentials`) or `%APPDATA%\Dispatch\credentials` on Windows.
An embedding application can select `configRoot`; it must be outside the project.
The canonical project path's SHA-256 scopes its profile and native service.
Copies or moved checkouts require separate setup. Metadata is written atomically
under a per-profile file lock. POSIX configuration directories/files must be
user-owned and private (0700/0600); symlinks and project-contained paths are
rejected. Windows relies on the user's profile ACLs.

Profile JSON contains source metadata, never resolved keys. Treat helper metadata
as executable authority: protect the directory and configure it through trusted
host setup. The runner does not import resolver commands from agent definitions,
skills or repository files. Native credential accounts use generated IDs.

## Helpers and terminal setup

`credentialCommand` implements `login PROVIDER [--stdin]`,
`helper PROVIDER /absolute/program ARGS`, `status [PROVIDER] [--json]`,
`check PROVIDER` and `logout PROVIDER`. The first-class
[scaffold guide](https://github.com/dispatchlabs-ai/agent-scaffold/blob/main/docs/credentials.md)
shows the user workflow. `promptForSecret` reads hidden terminal input and restores
terminal state on completion/cancellation. The explicit `--stdin` setup option
accepts a trusted secret-manager pipe; keys must not be command arguments.

Helpers run without a shell, from the user's home directory, with stdout captured
privately and stderr withheld. Registered provider key variables and `NODE_OPTIONS`
are removed from their inherited environment. Other host environment values can
still be available to the trusted helper, including its own vault authentication.
The helper must return one nonempty line; output is bounded to 1 MiB and execution
to 60 seconds. Cancellation aborts a running helper. A helper may need its own
interactive login beforehand. Never place a secret value in helper arguments.

## Security boundary

This protects persistence and avoids automatic propagation into process
environment variables. It is not a sandbox: trusted app code and dependencies
share the process; an authorized credential reader can access the secret.
Native store access controls differ by platform and may authorize a shared
runtime rather than one script.

Untrusted coding tools need a real sandbox and an authenticating broker outside
that boundary, with destination and operation policy. This module does not supply
that isolation. For services, use workload identity or managed secret delivery
where appropriate through a host-provided Pi store/context. The local helper
interface is an integration option, not a requirement to deploy a desktop keyring
on a server.
