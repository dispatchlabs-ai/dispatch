# GitHub App integration design

**October 14, 2026 — implementation plan, not supported usage.** This chat covers planning only; building and deploying the feature need a separate agreed completion target. This note consolidates the investigation and decisions made by Claude and Astra under Chris's delegation. Official project intent remains in the [database spec](spec.md); this document is supporting technical detail, not a competing spec or authorization to provision infrastructure. GitHub App connection, credential issuance and end-to-end ECS Git operation have not been verified.

## Ownership and user flow

Dispatch owns company connection, project repository selection, agent grants, commit attribution and authenticated Git execution. The generic [AWS module](https://github.com/dispatchlabs-ai/terraform-aws-dispatch) owns reusable deployment configuration; an operator's infrastructure repository owns its deployment values and secret references. Selecting repositories or changing grants should not require Terraform deployment.

Proposed UI:

- **Settings → GitHub:** connect, inspect the verified installation/account, reconnect/disconnect and inspect resolved bot identity.
- **Project settings → Repositories:** select connected repositories; preserve the distinct manual repository-metadata path.
- **Repository → Access:** grant/revoke agent Read or Write access against a saved repository binding. Do not reuse “Agent access,” which controls definition editing.

Connected does not imply project selection or agent access. Default-agent membership grants neither. Grant saves are separate from project drafts; discarding a draft must not appear to undo an applied grant.

V3 supersedes the shared-App entry with deployment-owned setup and adds Registered/Installed/Connected, restricted-management, return-failure, stage-specific interruption, revoke/disconnect and conflict-comparison designs: 56 synthetic frames across 1440×900, 1280×720, 768×1024 and 390×844. V2's repository picker, grant/capability and pending-removal proposals remain applicable. Narrow layouts use the upper-left Menu. Claude and Astra approved V3 for planning; Pi Durable Expert reviewed its lifecycle states without remaining findings. These are design reviews, not rendered application acceptance. The frame packets remain attached to the originating chat; do not treat synthetic examples as real account data.

The V2 interaction proposal clarifies that a grant does not enable Git tools: **Files and commands** must be present on the acting instance, including pinned revisions. Mark unavailable capability rather than infer every instance's access from the latest definition. Removing a repository leaves a pending-removal row with Undo and the number of grants Save would revoke; Undo/Discard preserves saved access. Recheck that impact at Save and require renewed review if it changed. Project saving does not start agent work. These proposal refinements received Claude's visual review, not implementation acceptance.

### Interaction and recovery boundaries

- Navigation uses links, even when styled as buttons, supporting Cmd/Ctrl-click, middle-click and new tabs without mutating drafts or initiating credential exchange. Setup-attempt initiation and mutations use buttons.
- GitHub registration, installation/repository selection and login/consent pages are provider-owned handoffs. Show Installed only after the App-authenticated lookup; show checking state while pending. Connected requires the full user/installation verification, not callback parameters.
- Failure actions return to Dispatch's GitHub settings to refetch authoritative status or open the intended organization's App settings from trusted server IDs and fixed GitHub origin. Expired/mismatched state must not overwrite a valid connection or expose callback-supplied foreign-account details. Distinguish expired manifest code from uncertain exchange; the one-hour wording is not an OAuth-code lifetime claim.
- When expired state belongs to an App-registration return, reuse the existing `expired-code` recovery actions but label the actual failure as **state expiry**, not code expiry: GitHub may already have created an App while Dispatch has no credentials. Determine the stage from the saved, authorized attempt, not callback fields. OAuth-stage expired state retains its own frame; mismatched state stays rejected without changing the connection. Recovery may display the stored requested App name and attempt time to help identification, never untrusted callback identity.
- “Recovery complete” is operator acknowledgement, not verified deletion. Start again returns to the form; only explicit Create begins a new attempt. Recheck the saved outcome and management authority first; resume saved credentials rather than recreate. An unavailable status read is an error, not proof that credentials are absent. Clear sensitive callback parameters before downstream navigation.
- Revoke names the agent/repository and blocks its subsequent authenticated remote operations through this GitHub App connection. Disconnect requires company connection authority, covers all linked projects and does not delete/uninstall the GitHub App. Local Git and the separate named-secret clone path remain distinct. Neither removes shared files, reverses pushes or guarantees cancellation of in-flight work. Both use revision checks and stable retry receipts; uncertain responses require status reconciliation. Discard project cannot undo either applied action.
- Disconnect retains the encrypted App record, repository bindings and **current** grants while stopping credential issuance. Reconnect runs Verify GitHub account again, checks the connection revision and fresh repository/permission access, and resumes only still-existing grants for the same company/connection, App ID and installation ID. Never restore a revoked grant, deleted binding or old snapshot, or carry access to a different installation; a stale callback cannot undo a later disconnect. The confirmation includes “Repository access resumes if you reconnect this installation.”
- Conflict comparison shows latest saved access beside the retained draft. Explicit Save uses the reviewed binding/grant version and a new logical mutation receipt; identical transport retries reuse it. Another conflict returns to review. Back preserves the draft/review requirement; missing/replaced bindings or lost authority block Save rather than rebind by name. Carry capability warnings into comparison.
- Compose shared controls in `src/components/ui.tsx`, with one dialog rather than stacked overlays, bounded scrolling, safe initial focus for destructive confirmations and visible progress/errors. Preserve long target names, focus containment/restoration and keyboard controls. Actual rendering, accessibility and interaction remain unverified.

## Authorization and credential contract

Keep three authoritative records separate:

| Record | Binding |
| --- | --- |
| Company connection | Verified GitHub installation/account and App identity/status |
| Project repository | Stable GitHub repository ID, connection and checkout metadata |
| Agent repository grant | Agent definition, project/repository and explicit read/write permission |

The existing project repository `{ id, name, url }` is metadata, not authorization. Caller-supplied URLs or installation IDs must not confer access. Connection verification needs a GitHub-authenticated flow; an `installation_id` callback alone does not prove control.

Deferred shared-App path (not the first implementation):

```text
Agent remote-Git tool
  → backend resolves current actor/project/repository/operation
  → broker authenticates deployment and checks its installation binding
  → GitHub issues a repository/permission-scoped installation token
  → local executor or worker consumes it for that operation
```

The broker must bind deployment/company to installation independently, not trust an arbitrary installation ID supplied by a deployment. Specify repository IDs and minimum permissions explicitly: [GitHub defaults omitted restrictions to the installation's authorized repositories and App permissions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app). Installation tokens expire after one hour.

Recheck current Dispatch grants inside execution/credential mediation for every authenticated operation, even when using a cached token. Pi replay-safe recovery does not necessarily rerun `beforeTool`; a hook-only authorization check is insufficient. Cache identity, if used, must include installation, repository and permission scope.

Worker requests should supply the authenticated actor claim, saved repository-binding ID and constrained operation. Derive company, project, installation, GitHub repository ID and permissions on the backend. Existing secret authorization does not establish project repository authority; use a dedicated GitHub authorization method. Recheck connection, binding, grant and worker attempt after credential acquisition before releasing credentials; discard stale results. Deleting/recreating a binding must not restore its old grants. Proposed project-manager saves use revision checks and actor-scoped retry receipts.

Keep tokens out of tool arguments/results, Pi documents/checkpoints, remote URLs, saved Git configuration and logs. Acquire credentials during execution; retain them only for the operation. This is credential mediation, not process isolation: agents sharing an OS identity may inspect other processes, and agents sharing a workspace may read its cloned files.

## Execution and recovery

Reuse the current [secret clone](usage-guide.md#named-agent-secrets) safeguards and authenticated worker mediation, without distributing the App private key to workers:

- [`agent-secrets.ts`](../server/extensions/agent-secrets.ts): use-time resolution, temporary helper, restricted Git configuration, suppressed raw errors and `replay: "unsafe"` clone execution.
- [`runtime.ts`](../server/runtime.ts): acting-agent/capability resolution.
- [`backend-owner.ts`](../server/workers/backend-owner.ts) and [`worker-main.ts`](../server/workers/worker-main.ts): authenticated worker credential requests and current-route/actor checks.

Recommended initial boundary: mediated clone/fetch/push, with local status/diff/branch/commit/merge/rebase remaining ordinary shell operations. Pull can compose authenticated fetch with local merge/rebase. Use the same authorization contract for local and ECS execution; no new scheduler or per-worker SSH setup.

Fetch/push operate on editable checkouts. Resolve remote URLs from the authorized binding, not `origin`, `pushurl` or supplied URLs. Prevent checkout configuration from redirecting authenticated execution through URL rewrites, extra HTTP headers, proxies, credential helpers, hooks or alternate transports; ignoring global configuration alone does not ignore `.git/config`. Accept constrained ref parameters, not arbitrary Git arguments. Initially push one resolved commit OID to one validated full destination ref; force, deletion, mirror and wildcard operations are outside the proposed initial scope. Share only the helper/socket, restricted execution and cleanup machinery actually needed, not a generic Git framework.

Keep Git mutations replay-unsafe initially. Before executing Git, persist a small native document through `api.commit()`, keyed by `${api.taskId}:${api.callId}` within its store/conversation, with only nonsecret push intent: authorized repository, full destination ref and resolved source commit OID. Execute that exact OID and record a sanitized outcome afterward. Neither document write is atomic with GitHub; activity output or `api.details()` alone is not a durable receipt.

An unfinished intent means uncertain, not no effect. Separately authorized read-only remote inspection can establish whether the ref currently matches the intended OID. A different value cannot prove the push never succeeded and does not authorize a force-push. Pi checkpoints and application operation IDs do not make pushes exactly-once. Reconciliation tools must also recheck current access.

Revocation blocks subsequent operations through the authorized path; it does not undo completed pushes, guarantee cancellation of in-flight operations or instantly invalidate every previously issued token. Branch-rule rejection is failure, not completion. Preserve and report unpushed work; unexpected ephemeral-worker loss can lose it. See [workspace guidance](usage-guide.md#chat-and-workspace) and [worker lifecycle](conversation-workers.md).

Resolve the actual App bot login and numeric ID rather than assume an email. Stable agent/conversation trailers provide attribution, not cryptographic verification. A bot identity on a shell-created commit does not by itself earn GitHub's “Verified” badge; [GitHub documents a separate verification mechanism for App-created bot commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#signature-verification-for-bots).

## Deployment-owned App setup

Use GitHub's [App manifest registration flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest): first choose the repository-owning organization, then send the authorized human to `https://github.com/organizations/<org>/settings/apps/new` with Dispatch's private manifest. A [private App can only be installed on its owning account](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private); personal registration must not promise installation in a different organization. The backend exchanges the temporary registration code within one hour and encrypts the returned App credentials, including private key and client secret. Registration does not prove installation or control.

Track Registered, Installed and Verified/Connected separately. Bind one-use registration state to the authenticated user/session, company, intended organization and pending connection. Save App ID/owner and client ID plus encrypted private key/client secret server-side. Set `request_oauth_on_install: false` and register Dispatch's return in `callback_urls`. After installation, Dispatch starts an explicit authorization step through `https://github.com/login/oauth/authorize` with fresh one-use state and an S256 PKCE challenge. The `redirect_uri` must match a registered callback; use the matching verifier for the backend code exchange. [GitHub documents this web authorization flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-web-application-flow-to-generate-a-user-access-token).

After installation, authenticate the GitHub user and inspect [`/user/installations`](https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token), including pagination, alongside `/user`. Independently [look up the installation](https://docs.github.com/en/rest/apps/apps#get-an-installation-for-the-authenticated-app) with the pending App's JWT. Match App, installation and owner IDs, account type, permissions and suspension status; recheck Dispatch connection-manager authority before Connected. GitHub-user installation access does not establish organization-admin status. GitHub explicitly warns that [an `installation_id` return can be spoofed](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).

Discard temporary user/refresh credentials after verification. Keep codes, secrets and token responses out of logs, referrers, UI errors and agent history. Registration return, user-authorization callback and setup return are distinct. Add browser-facing handlers under the configured Dispatch origin; no separate public webhook ingress is needed. Webhooks remain disabled initially, and actual localhost/hosted returns remain unverified.

The agreed v1 permission set is **Contents read/write + Metadata read**, with no Workflows permission. Report pushes changing `.github/workflows/` as unsupported/rejected in v1; never widen permissions automatically. [GitHub documents Workflows as a separate Git-access permission](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-git-access).

Storage uses a company-level encrypted record and existing encryption primitives, not a per-user named-secret grant or Terraform-managed private key. Workers receive only operation-scoped tokens. Continue checking installation ownership and repository access even for a private App.

### Setup exchange recovery

Persist setup-attempt identity and exchange intent before requesting credentials. Atomically save encrypted App credentials and Registered state afterward. Duplicate callbacks return a saved outcome when present; otherwise expose uncertain/recovery-required state, never automatically replay a consumed code or restart App creation. The external exchange and local save are not atomic.

Distinguish the persisted stage:

- **Manifest conversion uncertain, no App credentials saved:** show “Setup interrupted: an App may already exist on GitHub.” Link to the intended organization's App settings for operator inspection. Identify the App created by this attempt before explicit deletion/recreation, warn that deletion affects its installations, and never delete automatically or instruct deletion of an unidentified/existing production App. There is no manual key/secret upload in v1.
- **User-OAuth exchange uncertain, App credentials saved:** retain the registered App and start a new authorization attempt with fresh state/code. Do not replay the old code or delete/recreate the App.

Claude/Astra agreed on this stage-specific recovery, no manual key upload and no automatic exchange replay. None of these paths is an exercised GitHub flow.

This selected first implementation avoids a central broker, but each operator owns registration, permissions and rotation. Commits use that App's bot name, not necessarily `dispatchworks[bot]`. Keep a single token-issuance contract, without implementing a second provider before it is needed.

## Decisions

**Decided October 14 by Claude/Astra consensus at Chris's direction**, following his delegation in this chat. These are implementation-planning decisions, not applied access grants or working behavior:

- **App ownership:** deployment-owned private GitHub App through the manifest flow, with an encrypted backend-held key and operation-scoped worker tokens. Defer the shared DispatchWorks broker. A shared App key is App-wide; never distribute it to deployment backends as an installation-scoped credential.
- **Human authority:** default-deny operator-configured authenticated-user-ID allowlist for company connection management, separate from project roles and the read-all-project allowlist. Project managers control repository selection/grants. `AuthPrincipal` has no company-admin role; this policy does not create that role or grant anyone access now.
- **Commit verification:** no GitHub Verified-badge requirement in the first version. Use resolved App identity and agent/chat attribution. Signed-commit branch rules may reject ordinary pushes; do not bypass them or claim verified commits.
- **Git execution:** mediated remote Git with current-grant checks, hardened checkout execution and Pi-native uncertain-push recovery as described above.

Manifest, installation-verification and permission details above were checked against GitHub documentation and agreed by Claude/Astra. The V3 setup, revoke/disconnect, callback-failure and conflict-comparison proposals have completed planning review. The final note reconciles the reviewed designs and Claude/Astra's expired-state, disconnect-retention, operation-scope and navigation clarifications. See the originating chat for canonical local integration and task-only publication receipts. App provisioning, rollout and functional acceptance remain outside this planning task.

## Delivery and acceptance

Suggested order: verified connection/disconnect → repository selection/grants and clone → fetch/identity/push/reconciliation → generic deployment configuration and controlled worker rollout. Infrastructure work may proceed alongside application work once its contract is settled.

Before claiming support, record revision and observed outcomes for:

- Connection ownership verification, disconnect and installation/repository removal.
- Ungranted-agent and cross-company/repository denial; read-only grant cannot push.
- Clone/fetch/push locally and from a fresh ECS worker; replacement worker needs no manual credential setup.
- Next-operation denial after revocation, including a cached-token case.
- Token expiry/renewal and absence of credentials in durable history, logs and Git configuration.
- Branch-rule rejection and interrupted-push reconciliation without blind replay.
- Modified-checkout cases: changed `origin`/`pushurl`, URL rewrite, extra header, proxy, credential helper or installed hook cannot redirect credentialed execution or expose credentials through those mechanisms. Verify interactively under the repository's no-automated-tests policy; this does not prove process isolation.
- Saved UI state, conflict/retry recovery and whole-page review at the four required viewport sizes.

These are proposed acceptance cases, not successful observations. Source/build checks alone do not establish GitHub or distributed-runtime behavior. Update actual usage instructions only as interfaces become available and qualification is recorded here or in the owning handoff.
