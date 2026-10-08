# ECS configuration-file bootstrap

`dispatch-bootstrap` adapts ECS secret/environment delivery to Dispatch's existing restricted-file configuration. It does not fetch secrets, provision databases, migrate state, acquire controller ownership, or change Pi recovery. Native `dispatch-backend`, `dispatch-launcher` and other launchers remain unchanged. Nix includes the helper in the application package and therefore both OCI variants.

## Operator contract

Container command:

```text
dispatch-bootstrap backend
```

Supported roles are `backend`, `launcher`, `auth` and `provider-auth`. Remaining arguments pass directly to that role's entrypoint. The authentication CLIs retain their existing stopped-owner requirements; the wrapper does not make concurrent maintenance safe. Use Node 24 on Linux; the wrapper replaces its process using `process.execve`, preserving PID, stdio and signal delivery without a shell or supervising child.

`DISPATCH_BOOTSTRAP_FILES` is a **public** JSON object mapping flat output names to environment sources. For example (names only; no secret values):

```json
{
  "provider-store.json": { "env": "DISPATCH_RENDERED_PROVIDER_CONFIG", "encoding": "utf8" },
  "provider-database.url": { "env": "DISPATCH_SECRET_PROVIDER_DATABASE", "encoding": "utf8" },
  "provider-credentials.key": { "env": "DISPATCH_SECRET_PROVIDER_KEY", "encoding": "base64" },
  "postgres-ca.crt": { "env": "DISPATCH_PUBLIC_DATABASE_CA", "encoding": "utf8" }
}
```

The module supplies configuration pointers separately: `DISPATCH_BACKEND_WORKERS_CONFIG_FILE=/tmp/dispatch-bootstrap/backend.json` or `DISPATCH_LAUNCHER_CONFIG_FILE=/tmp/dispatch-bootstrap/launcher.json`. Backend JSON's `providerStoreConfigFile` points to `/tmp/dispatch-bootstrap/provider-store.json`; the provider maintenance CLI takes that path via `--config`. Rendered JSON values must reference the same `/tmp/dispatch-bootstrap/<name>` paths. The wrapper does not interpolate JSON or expand shell variables.

File names begin with an ASCII letter or digit and contain only letters, digits, `.`, `_` and `-`, up to 128 characters. No paths, nested directories or traversal. `encoding` defaults to `utf8`; `base64` must be canonical padded standard base64 with no whitespace. It is decoded to raw bytes, suitable for existing 32-byte encryption keys. Source values must exist and be nonempty. Never generate replacement keys during startup; retaining the same configured secret versions is essential to reopening encrypted records and store bindings.

All inputs are validated before writing. A fresh `/tmp/dispatch-bootstrap` is created with mode `0700`; existing directories, files or symlinks at that path cause failure. Files are created exclusively with `O_NOFOLLOW`, mode `0600`, owned by the service UID. Only after every file is complete does the selected service start. A partial failure leaves the restricted directory intact and starts no service; retry in a fresh task-local filesystem after investigating privately. Do not recursively remove/reuse a directory while a service could still be using it. No persistent-state cleanup occurs.

The helper removes `DISPATCH_BOOTSTRAP_FILES` and every referenced source variable from the replacement service's environment. Nonreferenced variables remain available for ordinary configuration and the ECS task-role credential provider. This does not erase the ECS control plane's task configuration or make injected secrets inaccessible to operators with its authority. The service can still read its materialized files; service-account coding execution is not isolated from them. Existing private-file validators continue running after materialization. Errors print only a fixed stage label, never raw input, filenames, exception objects or forwarded arguments.

## Deployment inputs and boundaries

- Run UID/GID 65532 with task-local writable `/tmp` and `/data` under the selected image-root policy. Ensure actual mount ownership/modes let this UID create its files; a declared mount alone does not prove that. `/tmp` must permit exclusive directory creation. No host installation-state mount is required by this helper.
- Backend and launcher have separate explicit manifests, secret references and execution-role secret allowlists. Do not supply either bundle to workers. Plain configuration/environment enters Terraform/task-definition state; secret values belong in deployment-specific Secrets Manager/SSM values delivered through ECS `secrets`, not plaintext Terraform configuration, logs or argv.
- Raw credential URLs, encryption/signing keys and bearer tokens remain secret even if embedded in a configuration JSON object. Such JSON must itself use secret delivery. Public config may contain file paths and secret ARN references, not resolved secret bytes.
- This helper does not modify existing authentication/provider/MCP key checks, grant permissions, enable automatic takeover or bypass confirmed-controller-retirement requirements. It also does not deliver trust to workers; their independently supplied backend CA/bootstrap contract remains separate.
- Materialized files are ephemeral startup inputs, not authoritative backup storage. Retain matching secret versions outside the task and preserve the installation's PostgreSQL, artifact and key-escrow recovery set across upgrades.

## Acceptance evidence

Implementation delegated for the Terraform-managed Surton POC, retained and improved in place. Source review covers validation before writes, exclusive private files, binary decoding, environment removal, fixed-role exec, untouched native entrypoints and failure without secret-bearing errors. Nix-shell TypeScript/application builds, Apple Silicon `nix build --no-link`, flake checks (zero runnable checks; Linux omitted) and whitespace review passed. The initial check invocation could not locate Nix on PATH; rerunning with its installed absolute path passed. Source/deslop review retained direct fixed-role execution, native file validation and failure without a fallback/retry path. No runtime bootstrap, Linux image or AWS execution is established by these checks; the deployment owner must observe actual materialization, permissions, child environment, service startup and signal behavior with harmless fixture values before claiming runtime acceptance.
