# Operator-only PostgreSQL initialization

`dispatch-database-init` prepares a **fresh, dedicated PostgreSQL 17 installation**
for the retained worker POC. It is not a service, migration, password-rotation or
recovery command. The application’s normal loaders own schema migrations. No
existing installation is converted, reset or deleted by this helper.

## Invocation and secret boundary

Run from a trusted operator host with private database reachability, or the
module’s separate, unscheduled operator Fargate task. Use the immutable qualified
image. Keep backend, launcher and workers stopped; independently inspect actual
ECS tasks before launching the operator task. A zero desired count or this CLI’s
confirmation flag is not proof that an old owner has terminated. The initializer
does not query ECS or fence executors.

```sh
# Default operator task command: verification only.
dispatch-bootstrap database-init --config /tmp/dispatch-bootstrap/database-init.json --verify
# Explicit one-off override after confirming fresh target and stopped services:
dispatch-bootstrap database-init --config /tmp/dispatch-bootstrap/database-init.json --create --confirm-services-stopped
```

Native operators may call `dispatch-database-init` directly with their own private
paths. `--help` performs no connections. Select exactly one operation. `--verify`
does not create, rotate, repair or migrate anything. It connects using the supplied
identities and checks the same contract as creation; retain the seven URL secrets.

The operator task alone gets the RDS-managed master secret and seven store URL
secrets through its explicit execution-role allowlist. Its task role needs no AWS
API permissions. The backend receives its six store credentials, the launcher
only its journal credential, and workers get neither bundle. **Never add the RDS
master secret to service/worker configuration.** Do not expose the operator task
through a service, ALB, ECS Exec or application endpoint. Remove its optional task
configuration after use without changing retained database/secret resources.

## Configuration

The configuration is a `0600`, nonsymlink regular file owned by the running UID:

```json
{
  "installationId": "installation-specific-stable-id",
  "host": "installation.cluster-region.rds.amazonaws.com",
  "port": 5432,
  "adminSecretFile": "/tmp/dispatch-bootstrap/rds-master.json",
  "caFile": "/tmp/dispatch-bootstrap/rds-ca.pem",
  "stores": {
    "auth": "/tmp/dispatch-bootstrap/auth-db-url",
    "provider": "/tmp/dispatch-bootstrap/provider-db-url",
    "catalog": "/tmp/dispatch-bootstrap/catalog-db-url",
    "directory": "/tmp/dispatch-bootstrap/directory-db-url",
    "routing": "/tmp/dispatch-bootstrap/routing-db-url",
    "launcher": "/tmp/dispatch-bootstrap/launcher-db-url",
    "workers": "/tmp/dispatch-bootstrap/worker-db-url"
  }
}
```

`adminSecretFile` accepts the RDS-managed JSON object containing `username` and
`password`, including additional RDS metadata. It connects to database `postgres`.
Alternatively replace `adminSecretFile`, `host` and `port` together with
`adminUrlFile`, pointing to a private operator PostgreSQL URL. Do not supply both
forms. Every initializer for this installation must use the same maintenance
database so its advisory lock has the same scope.

Each store value points to a separate `0600` UID-owned nonsymlink file containing
one PostgreSQL URL, **not** a plaintext Terraform input. `catalog` is the MCP
connection catalog. All seven URLs must share the operator endpoint/port, contain
no query parameters/fragments, and use distinct role names, database names and
passwords. Role/database names are lowercase identifiers, 3–63 characters, not
`pg_` names. They cannot reuse the operator role/database. Generate each password
privately from at least 32 random bytes as unpadded base64url (43–256 characters);
retain matching secret versions rather than regenerating on retry. The helper
prints neither URLs nor passwords and does not create secret-manager versions.

The CA file must be a non-writable-by-others regular file owned by root or the
operator. The existing verified PostgreSQL helper enforces certificate chain and
URL-host identity, TLS 1.2 minimum and no URL SSL override. Use the reviewed RDS CA
bundle and exact endpoint; never disable verification to get initialization past
an error. The operator master URL is constructed in memory, never emitted.

## Creation, permissions and failure

Creation first validates every input and refuses **any** pre-existing target role
or database before mutation. Seven NOLOGIN roles are created transactionally.
Databases are created with connections disabled, then database PUBLIC privileges
are removed before opening connections. Only after all databases exist does a
transaction set the supplied SCRAM passwords and enable LOGIN; only the worker
store owner receives CREATEROLE. Each owner removes PUBLIC privileges on its public
schema. Roles are non-superuser, NOINHERIT, NOCREATEDB, NOREPLICATION and NOBYPASSRLS;
no application role belongs to another role. PostgreSQL 17’s operator-to-owner
SET membership permits the operator to create and secure each database; this is
not a reverse application-to-operator grant. The master remains privileged.

Passwords are bind parameters to a temporary SECURITY INVOKER function, not SQL
text sent by Node. Before sending them the operator session disables statement,
duration/sample, error-statement and parameter logging, sets terse error verbosity,
and disables pgAudit/pg_stat_statements utility capture when those settings exist.
The function masks internal password-assignment errors. Each required session
setting is read first; an already-effective safe value needs no `SET` privilege.
Otherwise the helper sets it and checks the effective value again. If the value
cannot be made safe, creation fails **before creating roles or sending passwords**.
RDS can deny operator `SET` on bound-parameter logging even though its dedicated
parameter group can enforce `log_parameter_max_length=0` and
`log_parameter_max_length_on_error=0`; configure those dynamic DB parameters in
Terraform and verify the new session sees them. Never grant setting authority to
app roles or skip a logging protection. Database audit/proxy/monitoring policy
remains an operator responsibility; actual RDS behavior needs live observation.

Success verifies authentication/TLS, owner and installation markers, role flags,
no role memberships, absence of PUBLIC database/schema grants, and all 42
cross-store CONNECT denials. This is not a full application authorization audit.
Workers’ per-conversation roles/row-security policies remain the native backend
provisioner’s responsibility.

`CREATE DATABASE` cannot join the role transaction. A crash, timeout or partial
failure can therefore leave NOLOGIN roles, disabled databases or a partially
secured installation. **Preserve the original inputs and partial state; stop and
inspect privately.** A subsequent `--create` refuses those existing names. There
is no automatic retry, deletion, adoption, credential reset or resume mode.
`--verify` reports only a fully matching completed contract; it does not repair a
partial result. An operator-reviewed recovery is separate from this command.
Never remove retained resources merely to rerun creation. Application startup and
schema migration are later stages after this helper exits successfully.

## Scoped evidence

The initial implementation passed TypeScript/application builds and a focused
synthetic-secret macOS ARM64/PostgreSQL 17.11 check using verified TLS/SCRAM and a
non-superuser operator granted only the required creation/session-setting powers.
Eleven observations covered fresh initialization, seven-owner/isolation checks,
repeat verification, existing-target refusal, a real worker provisioner creating
and opening a scoped store, unsafe-file/reused-identity/confirmation refusal, and
no fixture passwords in command output or database logs. The local receipt is
`.local/rds-init-result.json` in the initializer worktree; fixtures are not product
tests or AWS evidence. Initial fixture setup failures (Unix socket path length and
CA certificate construction) were corrected before these observations.

Documenter inspected the [integrated native-image receipts](https://github.com/dispatchlabs-ai/dispatch-infra/blob/7d5ace9/environments/surton/dispatch-workers/evidence/6aa1b82-native-images.json)
at `6aa1b82` for Linux ARM64 and AMD64. Network-disabled synthetic-secret containers
passed volume initialization, nonroot/read-only bootstrap `database-init --help`,
0700/0600 UID-owned materialization, exact key decoding and collision denial.
These are packaging checks, not database initialization; their local image IDs
are not registry/index digests. No database, hosted model or ECS was exercised.

The first October 8 Surton operator task reached private RDS PostgreSQL 17.9 with
verified TLS and completed volume initialization, then failed before role creation
because RDS denied `SET log_parameter_max_length`. Its sanitized stage error and
private RDS log were independently inspected; `DescribeTasks` confirmed STOPPED,
initializer exit 1 and volume-init exit 0. Original inputs remain preserved.
The correction checks effective values before changing settings, with the two
bound-parameter settings enforced by the dedicated RDS parameter group. A new
image and explicit operator-controlled attempt are required; this is not an
automatic retry/resume or permission to reset partial state. Correction source/deslop
review, TypeScript/application checks and Apple Silicon Nix build passed; flake
evaluation passed with zero runnable checks and omitted Linux systems.
A subsequent focused macOS ARM64/PostgreSQL 17.11 TLS/SCRAM qualification denied
the synthetic operator `SET log_parameter_max_length`: inherited `0` permitted
full fresh creation and verification, whereas an unsafe inherited value was
refused before any store role existed. Repeat-create refusal and password-free
client/server logs also passed. The initial fixture needed an explicit safe
server default; after correction, all eleven observations passed and the stopped
fixture was removed. Receipt: `.local/rds-settings-result.json` in the initializer
worktree. These observations do not establish the corrected image's RDS execution.
Successful live creation, complete RDS logging/privilege qualification and live application/browser behavior
remain unverified. This helper is preparation toward the live Surton URL, not
completion of that handoff.
