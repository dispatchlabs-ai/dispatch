# Changelog

## [Unreleased]

### Worker startup

- Add an opt-in single warm spare with durable one-time chat assignment,
  replenishment, observable readiness and drain/sleep integration.
- Batch ECS task descriptions and reuse their authoritative results during admission; directly inspect journaled tasks missing from discovery. Omit build-only dependency declarations/source maps from runtime artifacts and report worker-ready startup duration without conversation or credential data.
- Exclude authoritatively stopped Fargate tasks from active inventory before decoding ownership tags. Retained completed diagnostics no longer block new-chat admission; active or uncertain tasks and explicit retirement still require complete identity checks.

## [0.4.0] - 2026-10-13

### Agent definitions

- Default a saved agent to Pi when both the save request and prior definition omit the execution backend, while preserving explicit selections and legacy request replay fingerprints.
- Add explicit grants for self-target definition edits and managed skills, capabilities and connection delegation, with human grant administration in the agent editor. Definition edits preserve existing grants until human revocation; technical access does not replace per-change manager approval.
- Let every agent read the company skill library without a grant; creation and editing remain separately grant-controlled. Report rolled-back management and library refusals as tool errors rather than successful results.

### Evaluation comparisons (local pilot)

- Add frozen baseline/candidate comparisons, paired case inspection, evidence availability and append-only judgments attributed to the authenticated account; creating a comparison does not launch work or adopt instructions.
- Add explicit per-variant Start run confirmation and retry-safe admission for local Muse execution with pinned configuration, verified fixture contents and exclusive fixture-instance claims. Reject non-regular and hard-linked fixture inputs rather than omitting them from verification.
- Distinguish pending admission, execution completion, confirmed silence and missing output evidence. Critical failures block acceptance; missing required evidence remains unresolved. Hosted execution, automated grading, clean held-out certification and automatic promotion are not included.

### Shared conversation context

- Make Claude/Muse contribution-review settlement replay-safe, committing the review prompt with its listening cursor so recovery does not reapply an older answer against a newer review round. Exact crash-window behavior remains interactively unverified.
- Avoid repeated full-history searches when projecting chat activity and reduce mention-history indexing, preserving aliases, ordering and privacy filtering.
- Preserve authenticated mention metadata in saved messages and their read projections, including permitted mention-based invitations.
- Avoid saving a duplicate recent-history snapshot in new delivery notifications; retain fresh request-time context for Pi, Claude SDK and Muse execution without changing recovery cursors or historical inputs.
- Deliver new message images by reference instead of copying base64 bytes into each recipient's input, task admission, and checkpoints. Pi requests resolve the delivered messages' images transiently per request; native Claude SDK and Muse runs resolve them at execute time after the recovery-intent commit, keeping every checkpoint reference-only. Already-admitted inline prompts still execute unchanged, attachment references remain discoverable for later `conversation_attachment` reads, and unloadable images surface as an explicit limitation rather than a silent omission. Historical inline entries are unchanged; explicitly reading an image through a tool still stores that tool result.

### Muse Code execution

- Add native Muse Code runtime/model selection, account-login defaults with optional explicit API keys, and Pi-owned execution/tool/publication wiring.
- Distinguish optional Dispatch tools from native Muse access in agent and participant summaries; explain runner access without implying a sandbox.
- Apply the operator-requested native YOLO posture with sandbox disabled and protocol auto-approval, retaining owner-bound Dispatch/Pi tool authorization and versioned session compatibility.
- Qualify local subscription inference, adopted instructions, committed Dispatch tool receipts/publication, native-session continuation, active-inference and active-tool Stop, and interrupted recovery without automatic replay. Verify changed UI at desktop/390 px; reconnect copy no longer promises continued execution.

### Bounded web search

- Request query-relevant Exa highlights instead of full pages, and bound excerpts before durable storage and tool publication.
- Honor short/medium/long search previews with serialized metadata-aware budgets and bounded batches; expose truncation and omission without breaking source URLs or reference-based page reads.

### Agent SDK execution

- Add an opt-in Agent SDK runtime using the unmodified official Claude Code binary and its native user-bound authentication, with a separate credential-independent model catalog.
- Keep execution admission, tool receipts, cancellation and contribution publication in stock Pi Durable tasks; preserve the existing Pi runtime by default.
- Expose committed SDK tool activity and explicit unavailable model-usage accounting. Document query-settlement publication and uncertain interrupted execution without automatic external-effect replay.
- Qualify local subscription-backed inference, authorized tools, Stop, controlled-restart uncertainty, and saved public readback; hosted execution remains fenced and other platform/auth modes unverified.
- Keep unknown Claude SDK query diagnostics out of persisted task errors by returning a fixed uncertain-effects outcome; categorized failures and cancellation remain distinct.
- Supply the current adopted system prompt on resumed SDK requests without reusing the SDK's earlier prompt snapshot. This preserves native session history; changed-prompt delivery remains live-unqualified.

### Image credential routing

- Add a separate Codex images connection using Pi-owned OAuth login/refresh and saved account selection, without changing agents' chat providers or copying CLI credentials.
- Select subscription or API-key image transport explicitly; prefer configured Codex access by default, reject incompatible credentials/controls before submission, and never retry a provider failure through the other billing route.

### Project-wide agent instructions

- Add a project-owned Markdown instructions setting and Projects editor with manager-only, revision-checked saves, no-op revision handling and actor-scoped retry receipts; keep spec and settings revisions separate.
- Preserve editor drafts and original-request retries across workspace navigation; distinguish conflicting, rejected and uncertain saves, with read-only review before explicit reconciliation and per-agent adopted-revision inspection.
- Render adopted execution snapshots through stock Pi Durable's native project-instructions section, without copying project rules into reusable definitions or treating prompt text as permission grants.
- Adopt only the latest saved rules at safe idle boundaries, independently of agent-definition upgrades; initialize later invitees with current rules and propagate hosted changes without retiring active workers on acknowledgement failure.


### Agent project context

- Add project-scoped chat listing and passive public-history/detail reads without joining source chats or resuming their work; preserve project authorization on every page and refuse out-of-project IDs.
- Include archived chats in discovery, preserve source references, and exclude private working context and private attachments. Keep activity discovery explicit and distinguish stored activity from current liveness.
- Read hosted worker history through fixed read-only PostgreSQL snapshots without taking executor ownership, provisioning storage or launching workers. Project search and self-instruction editing remain separate future work.

## [0.3.0] - 2026-10-11

### Database-owned project specs

- Use the full spec-panel width for Markdown Preview, matching Source rather than applying a narrower reading-column cap.
- Store authoritative project Markdown as immutable database revisions; write a first spec or edit an existing one directly from Projects, without a file path or repository prerequisite.
- Preserve drafts on conflicts and uncertain responses. Stable actor-scoped Save receipts confirm the originally committed revision on retry, even after another writer advances the spec; Save does not start agents or publish Git changes.
- Import a reviewed legacy spec and retire its active file reference atomically, preserving source provenance and unrelated project settings. Remove the old file-write endpoint and normal spec-source configuration.
- Add `conversation_project_spec` for current or exact-revision agent reads, with explicit pagination; hosted workers use authenticated backend mediation rather than local disk.

### Projects navigation

- Add Projects before Agents and Chats in workspace navigation; move project creation, overview, settings and spec viewing out of Chats while retaining conversation grouping and legacy project links.
- Add project-list search, full-width spec references and upper-left narrow-screen navigation; keep project, spec and chat drafts mounted across destination switches.
- Navigation alone does not implement adoption-triggered automation or chat working-copy Save; database-owned spec editing is described separately above.

### Inline conversation diffs

- Preview published UTF-8 `.patch` and `.diff` attachments directly in messages using the Pierre fork, with expanded unified changes, file headers, bounded scrolling and an original-patch link. Invalid or oversized patches retain a readable fallback; previews never apply changes.

### Repository documentation reset

- Replace the former product specification with a short draft outline centered on supported use cases, rules and repo-local detail.
- Make repository guidance self-contained; retain the existing testing policy in the contribution guide and retire obsolete external-document references and illustrations.
- Align reusable workflows and injected collaboration guidance with the current authorized task; historical handoffs are evidence, not scope or a default destination for new work. Keep the draft spec empty until its content is agreed with Chris.
- Remove provider-specific MCP migration, identity checks, callback compatibility and activity labels while retaining generic MCP support. Existing pre-generic connection databases no longer receive that retired migration.

### Licensing

- License Dispatch under the MIT License.

## [0.2.0] - 2026-10-10

### Pi runtime and prompt caching

- Align Pi packages at 1.1.0, including upstream context derivation and Anthropic system/tool cache fixes.
- Align the shipped capability artifact’s exact Pi AI/Durable peers and host instructions with the 1.1.0 build.
- Cache saved conversation history before the fresh shared-context suffix, preserving listening behavior and native provider credentials.
- Support ordered PostgreSQL scans and cursor continuation, including inherited fork history. Scoped local SQLite/PostgreSQL tool-loop, reopen and live Claude cache-reuse observations are recorded in the [upgrade work package](docs/handoff.md#pi-110-and-shared-context-caching--october-10-2026); hosted worker and broad recovery qualification are not established.

### Pierre source editor and project spec reading

- Use the maintained Dispatch Pierre fork for chat file/diff presentation and the shared literal source editor, preserving historical excerpt semantics and React/worker import paths. Pin the immutable fork release with npm integrity and the Nix dependency hash; retain Apache notices.
- Add project-spec Preview/Source and in-memory editing labelled Draft · not saved, without a Save action. Load configured public GitHub specs at a pinned commit with bounded UTF-8 reads and access/source-identity rechecks. Directory references remain configurable but unsupported by this reader; repository writes and durable draft recovery are deferred. See the [work package](docs/handoff.md#pierre-fork-and-project-spec-editor--october-10-2026) for qualification limits.

### Model provider setup

- Remove the legacy Codex setup/model choice and reject new legacy-provider agent saves. Existing local OpenAI configurations were manually updated to the single OpenAI provider with the saved ChatGPT OAuth grant; no reusable migration code is shipped.
- Add Settings → Model providers for OpenAI ChatGPT OAuth/API keys, Claude API keys and Fireworks API keys. Keep Pi responsible for authentication, refresh and model catalogs; show stored authorization separately from live verification and externally managed credentials.
- Use encrypted application credential storage locally, preserving Pi `auth.json` without importing grants. Existing local credentials need a one-time application reconnect. Keep interrupted updates recoverable by explicit disconnect/reconnect and distinguish storage failure from an uncertain grant. Disconnect removes local credentials, not upstream authorization or operator-configured fallback credentials.
- Integrated source/type/build and scoped disposable-key browser checks pass, including four responsive sizes and recovery/restart observations. Local OpenAI OAuth replies and tool use are also verified after the manual cutover; broader account lifecycle and deployment qualification remain unverified. See [cutover evidence](docs/handoff.md#single-openai-provider--october-10-2026) and [original provider-package evidence](docs/handoff.md#model-provider-setup--october-10-2026).

### Repository identity

- Rename the private application repository to `dispatch` and update container source labels and documentation links. The retired repository is preserved privately as `dispatch-retired`; existing application, state and checkout paths stay compatible.

### Project repositories and spec reference

- Store manager-editable repository URLs and explicit directory-relative or repository-relative spec references. Directory specs need a saved project directory, not a repository URL; clearing their base or removing a selected repository requires clearing/reassigning the spec. No migration or legacy-source fallback. Preserve omitted metadata, manager/revision/retry checks and existing agent directories. Saving references does not clone repositories or verify access/spec-file existence.
- Add responsive main-area Project settings with source-specific path labels, shared inline errors and retained drafts. Show the single directory input beside directory specs, under Advanced otherwise; switching source or clearing the spec retains it. Show saved bases/paths separately on the overview and warn when changing the directory base used by new local agents. Source review and type/build checks pass; browser/runtime qualification remains pending. See the [work package](docs/handoff.md#project-repositories-and-spec-reference--october-10-2026) for evidence.

### operator idle sleep

- Add a non-cancelling operator sleep gate using sealed admission, native live/background work inspection and confirmed worker retirement. Busy workers keep support callbacks and reopen RPC admission; uncertain outcomes remain fail-closed. See [idle sleep](docs/idle-sleep.md) for partial refusal, recovery and live-qualification limits.
- Allow typed ECS public-IP assignment for outbound task networking and extend initial PostgreSQL connection deadlines to 60 seconds for cold resume, without transaction retries or relaxed ownership fencing.

### Single composer Send/Stop action

- Replace the separate Stop all control with a single fixed-position Send/Stop button for main and thread composers, with draft presence separate from send eligibility and explicit whole-chat cancellation scope. Source/type/build and synthetic component visual reviews pass; authenticated integration remains unverified. See the [handoff](docs/handoff.md#single-composer-sendstop-action--october-10-2026).

### inline image attachments

- Show large, uncropped, responsive image attachments in main chat and threads, with stacked previews and filenames underneath. Keep originals optional, small images at native size and non-image files compact. Retain original links and a short status when previews fail.

### Conversation workers and shared service storage

- Add opt-in per-conversation PostgreSQL workers with backend-owned authentication, catalogs and credential mediation, plus Docker/ECS launcher lifecycle and attempt-bound RPC/callback authorization. Preserve native single-runtime mode and Pi-owned execution/recovery; confirm old executors are stopped before replacement.
- Add encrypted PostgreSQL authentication/provider/MCP persistence, routing/admission journals, backend-mediated attachments and S3 project archives. Existing SQLite installations are not automatically migrated. See [worker contracts and bounded observations](docs/conversation-workers.md) for installation, recovery and remaining qualification limits.

### Named agent secrets

- Extend Settings → Secrets with write-only named credentials and explicit per-definition grants checked at use time. Add metadata-only `secrets_list` and credential-internal GitHub HTTPS `git_clone`; imported definitions do not inherit grants. Scoped disposable storage/browser and Git observations pass; real private cloning and hosted secret-tool acceptance remain unverified. See [acceptance evidence](docs/handoff.md#named-agent-secrets--october-9-2026).

### Ubuntu worker environment

- Add ARM64/AMD64 Ubuntu worker recipes retaining the pinned Nix application while allowing ordinary agent-shell package installation. Controllers remain non-root/read-only; coding workers are trusted environments, not hostile-code sandboxes. Bounded native and hosted new-chat installation observations pass; runtime-installed tools, local files and unpushed commits are not automatically restored. See [image acceptance](docs/handoff.md#ubuntu-agent-image--october-9-2026).

### Standalone AWS module

- Move AWS infrastructure, generated caller configuration and installation/update instructions to [terraform-aws-dispatch](https://github.com/dispatchlabs-ai/terraform-aws-dispatch). The application retains its runtime/bootstrap and OCI recipes; extraction does not migrate existing installations or qualify a fresh installation.

### Lockstep versioning

- Add SemVer release preparation, package-derived Nix and browser build versions. Keep release publication and deployment explicit.

### planned controller handover

- Keep undispatched request expiry separate from controller failure; reject public traffic while a claimed local owner is unready without blocking authenticated startup maintenance.
- Add opt-in backend/launcher listener overlap with identity-bound planned ownership transfer, fresh-state activation, private readiness, bounded undispatched waiting and response-body draining. Preserve worker executors and store recovery latches; do not replay dispatched mutations or take over on timeout.
- Add explicit snapshot-checked controller recovery and generic managed-launcher ingress with rolling drain budgets. Source review is not deployed continuity; see the [handover package](docs/handoff.md#safe-controller-overlap-for-ecs-rolling-deployment--october-9-2026) for activation prerequisites, observed native replacements and coverage limits.

### live agent indicator

- Replace Activity/Working disclosure labels with agent names and arrows; show current working/responding indicators separately without visible status text. Preserve accessible status and reduced-motion support.
- Remove the teal pending-prompt surface while retaining Sending and Retry.

### ECS deployment mode selection

- Add explicit per-controller `stop-first` (0/100) or `rolling` (100/200) deployment selection to the reusable AWS module; preserve stop-first defaults. Rolling requires application-level overlap and readiness support absent from legacy controllers. The selection option alone changes no live deployment mode.

### activity disclosure recovery

- Remove activity count labels and empty live-only timeline disclosures while preserving loaded historical activity.
- Resolve settled activity detail identities; stop loading on failure with Retry and retain output during background refresh.

### composer typing isolation

- Notify only the affected main/thread composer on draft edits rather than rerendering the workspace and unrelated chats; retain workspace-lifetime drafts, uploads and send/retry guards.
- Avoid duplicate mention scans for the same editor state while retaining synchronous Markdown updates, initial imports and external replacements. See the [correction package](docs/handoff.md#composer-typing-responsiveness--october-9-2026) for evidence and limits.

### project participants and sign-in diagnostics

- Include current project members in chat Participants and inline mention choices before their first message; preserve former authors and reject new mentions after project removal.
- Allow project changes while an existing member recovers their account, preserving that member's unchanged identity and role.
- Record structured authentication failures with browser context, safe passkey rejection categories and a user-visible support reference.

### borderless activity labels

- Remove the visible box around agent activity labels while retaining click-to-expand, hover feedback and keyboard focus styling. Tighten activity-only row spacing and label padding, retaining 44 px touch targets.

### chat completion guidance

- Point shared agents to the saved chat Definition of Done and latest human direction, use the conversation goal when blank, and finish after evidenced completion instead of expanding work from broader checklists.

### project import placement

- Move project import from the chat sidebar into Settings → Import & export, with paired project export, a file drop area and Continue to archive review. Retain existing approval and retry behavior.

### agent criteria editing

- Add opt-in Edit Definition of Done capability with current-chat read/write tool, revision protection and durable retry receipts. Disabled by default; existing instances adopt capability changes at safe idle boundaries.

### continuing simplification

- Align runtime/setup and agent workflow guidance with current contracts and testing-policy exceptions; distinguish historical editor proposals and deployment/qualification evidence from current claims.
- Ignore root generated image outputs/run metadata without deleting user files or tracked design assets.

- Share agent-connection polling, remove an unused account dirty-state callback, and centralize fixed capability mappings.
- Replace unconditional image-directory retries with one exclusive creation and remove unused in-memory reference paths; retain audit metadata.
- Project only transcript page candidates, compare window overlap with set membership, and avoid redundant history/connection reads; preserve page, ordering and authorization contracts. Share blob-download cleanup without changing output metadata.

Integrated source/build checks passed; runtime/rendered qualification remains unverified. See [acceptance evidence](docs/handoff.md#continuing-simplification--october-8-2026).

### five-finding simplification

- Replace full-transcript chat listing with lightweight summaries and target pending base upgrades instead of scanning all chats after unrelated commits.
- Consolidate composer state and coordinate list refreshes with stale-response protection, preserving draft and retry safeguards.
- Reconcile current agent-management status/default-target eligibility and link check guidance to the canonical testing policy.

Integrated source review and TypeScript/application/Apple Silicon Nix checks passed; no deployment or new runtime/UI qualification is established. See [acceptance evidence](docs/handoff.md#five-finding-simplification--october-8-2026).

### chat presentation performance

- Replace sidebar transcript projection with transactionally maintained public summaries and checkpointed existing-chat initialization.
- Load recent chat/thread previews first, fetch older history on demand, stream delivered-state deltas, and virtualize transcript rows. Expand paired tool activity in pages; complete message/activity downloads retain access to oversized content.
- Source-published at `e87c0ab`: scoped authenticated desktop/390 px presence-update measurements meet the <100 ms typing budget; native cancellation/paging/SSE and integrated Apple Silicon checks passed. Guarded local installation and source-equivalent authenticated desktop/390 px demonstrations are recorded. See the [performance package](docs/handoff.md#chat-presentation-performance--october-8-2026) for measurement limits; arbitrary model-output loads are not qualified.

### chat criteria response

- Detach saved Definition of Done criteria inside the native read transaction so chats with criteria can serialize after settlement.

### chat Definition of Done

- Add shared Markdown completion criteria in chat Details, with authorized editing, revision conflicts, retained drafts and refresh-before-retry. Agents receive current criteria as guidance, not completion or work authorization.

### agent management eligibility

- Allow explicitly granted agent management for agents with tools, skills, extensions or connections, including default-agent and granted-editor targets. Preserve human grants, revision pins and permitted tuning fields.

### project working directories

- Add an optional service-host working directory in Project settings. New agent instances retain the selected workspace; changing project settings never redirects existing instances. Blank uses the installation default.

### shared work continuity

- Align shared-chat instructions and both history notifications: check recent history and relevant spec/work-package criteria before ending, and continue authorized, unblocked work without redundant public replies. No scheduling, native lifecycle or agent-definition changes.

### integration secrets

- Add Settings → Secrets for encrypted Exa keys or explicit server-environment grants, owner-scoped management, revision-conflict protection, and use-time credential authorization. Environment-only search now requires explicit agent grants.

### starter and GitHub bundles

- Add an explicit-model Developer starter through the existing archive preview/import path.
- Add public GitHub commit-pinned imports and tracked updates with durable reviewed previews, conservative local-edit conflicts, retained removed entries and atomic retry receipts. Updated definitions follow the existing safe-idle adoption policy. Source/build checked; later bounded runtime/browser observations and remaining limits are recorded in [portability evidence](docs/handoff.md#portability-manual-qualification--october-8-2026).

### portable agent and skill bundles

- Add Agents import/export with bounded ZIP parsing, requirement preview, exact assigned skill revisions and independent local copies. Native atomic receipts preserve same-operation retries; connections, credentials and existing instances remain untouched. The initial slice excluded GitHub updates, starter distribution, project exports and backups; subsequent deliveries and bounded manual qualification are recorded in the [handoff](docs/handoff.md#portability-manual-qualification--october-8-2026).

### separate web capabilities

- Split Web research into independently assigned Web reading (`web_read`: open/find/click, no search key required) and Web search (`web_search`: search_query, requiring an Exa grant). Legacy combined assignments migrate to both without changing grants; saved evidence remains intact. Activation and full workflow qualification remain pending in [WP-054](docs/handoff.md#capability-split--october-9-2026).

### native web research

- Add the Web research capability with native search, page reading, literal find and numbered-link traversal, durable instance-local evidence and source citations. Interrupted network batches are not automatically replayed. Qualification tracked in [WP-054](docs/handoff.md#wp-054--native-web-research).

### agent authoring design

- Redesign agent overview, editor, sidebar and evaluation configuration around the approved concepts. Add section/case navigation, a persistent required evaluation change reason and shared Markdown formatting controls. Preserve existing draft, revision and profile-only boundaries. See [acceptance evidence](docs/handoff.md#agent-authoring-redesign--october-8-2026).

### Developer default

- Make Developer the company default and archive retired Dash/Dispatch without deleting revisions or changing existing conversation instances. Preserve Developer settings and migrate project defaults; new projects and implicit chat selections use Developer. Acceptance evidence and remaining qualification are tracked in the [handoff](docs/handoff.md#developer-default-and-dash-retirement--october-8-2026).

### browser skills

- Add pinned agent-browser core and dogfood exploratory-QA guidance for explicit skill assignment, without installing browser tooling or changing existing instance snapshots. Checks and activation limits are recorded in [the handoff](docs/handoff.md#bundled-agent-browser-and-dogfood-skills).

### project overview

- Add project chat search, All chats/Active filters, status and last activity. Move members, default agents and existing settings into the contextual details panel, with adaptive desktop/phone rows. See [implementation evidence](docs/handoff.md#project-overview-redesign--october-8-2026).

### in-place agent base upgrades

- Apply saved base revisions to active instances at safe idle boundaries, preserving identity/history, instance supplements and workspace paths. Retain immutable revisions and explicit MCP assignment; display applied base revision separately from actual connections. Source/build candidate evidence and outstanding recovery/UI qualification are tracked in [the handoff](docs/handoff.md#in-place-agent-upgrades--october-8-2026).

### project-row chat creation

- Start a chat directly from a project row using its default agents, without a setup dialog; focus the new composer and retain existing drafts. Use Chat terminology in product controls.
- Remove obsolete personal-project creation/listing/move paths; preserve ungrouped access and stored retry identities. Source/build checked; rendered and functional qualification remains outstanding in [WP-053](docs/handoff.md#wp-053--project-row-chat-creation-and-shared-only-projects).

### multiple agent instances

- Add explicit same-definition instances with optional names and creation-only instruction supplements, immutable instance targeting and stable creation retries. Source/build checked; runtime and rendered UI remain unqualified. Evidence in [WP-050](docs/handoff.md#wp-050--multiple-agent-instances-and-supplemental-instructions).

### MCP credential renewal recovery

- Preserve authorization after known pre-exchange connection failures and explicit temporary OAuth errors; allow the next attempt to renew. Keep uncertain rotations and rejected grants blocked, and report safe renewal reasons to tools.

### conversation agent removal

- Add per-instance removal: fence participation, cancel native work durably, preserve history and require explicit human re-addition as a fresh instance after cleanup. Source/build checked; runtime and rendered UI remain unqualified. Evidence and outstanding acceptance are tracked in [WP-049](docs/handoff.md#wp-049--remove-conversation-agents).

### inline agent invitations

- Extend inline `@` selection to available company agents, inviting them only on Send. Resolve invitation mentions and save the message/deliveries in one native commit; preserve existing instances and unchanged-request retries. Implementation and local acceptance evidence are tracked in [WP-048](docs/handoff.md#wp-048--invite-agents-through-inline-mentions).

### agent evaluation profiles

- Refine editing into a focused evaluation workspace with scannable expectations/cases, progressive disclosure, persistent save controls and profile history in context/phone Details. Gemini’s scoped designer-agent assessment is 91/100 (A−); human comprehension, broader accessibility and native-select arrow behavior remain unverified. See [WP-047](docs/handoff.md#wp-047--agent-evaluation-profiles-and-editor) for receipt-review limits.

- Add independently versioned evaluation profiles, criteria and standalone cases to saved agent definitions, with immutable history, conflict checks and retry receipts. Keep evaluator-only material out of operating instructions.
- Preserve archived profile access and company boundaries. This slice edits evaluation definitions; it does not execute cases, assess real conversations or produce results.

### image editing and visual verification

- Stop injecting `input_fidelity` into GPT Image 2/2.5 edits, including when older skill snapshots request it; retain explicit supported legacy-model values.
- Return generated pixels to the model for visual review alongside existing paths and audit records. Clarify mask preparation, review-before-publication, rejected-parameter recovery and truthful fallback guidance in the reusable image skill.

### permissioned agent management

- Add native authorized definition reads, revisioned tuning saves and forward restoration, with trusted instance identity, dual editor-revision pins, atomic receipts, explicit rolling quotas and no live rollout.
- Add separate human-session grant administration and audit APIs. No grants are seeded; Doctor's target and direct-save trial remain unconfigured. Proposal workflows, eval automation and a grant UI are not included.

### specification reconciliation

- Separate current acceptance contracts, legacy personal-group compatibility and future designs. Reconcile project authority, agent editing/context, admitted public replies and conversation-wide Stop; scope deployment and PostgreSQL evidence without claiming full qualification.

### agent file sharing

- Prepare workspace files privately with `conversation_attach` and publish saved attachment IDs through contribution review. Reuse existing attachment storage and rendering; Stop/discard does not publish prepared files.
- Omit `input_fidelity` on prompt-only image generation and include sanitized rejected-parameter diagnostics. Live generation, publication and recovery remain unverified.

### agent archive response

- Detach nested agent configuration from the catalog transaction before returning it, so successful archives do not display a failed-request error. The same public projection covers saved-agent retries and retained skill selections.

### backend reload cleanup

- Release cached model WebSockets and provider idle timers after Pi work drains, allowing backend reloads to finish without waiting for cache expiry.

### local PostgreSQL storage

- Add an opt-in PostgreSQL adapter for Pi Durable 1.0.4, with isolated logical stores, atomic batches, document history and a dedicated single-owner connection. SQLite remains the default; existing state is not migrated.
- Document separate-state PostgreSQL 17 container and Homebrew setups. Authentication, connections and attachments remain local; distributed workers, automatic takeover and AWS deployment are not implemented. Runtime qualification remains pending.

### preserved contribution review

- Add opt-in OpenAI image generation/editing and separately assigned skill guidance, with workspace output records and explicit interrupted-request uncertainty.

- Preserve prepared contributions and their speaking reservation through final review/publication while other work continues. Human typing pauses publication without discarding drafts.
- Explicit posts report pending until sibling tools finish; stable publication receipts, native successor checks and Stop cleanup cover the new ownership boundary. Runtime qualification remains pending.

### container architectures

- Add Linux ARM64 image output and default ECS to ARM64, retaining explicit X86_64 selection. Multi-platform registry publication and per-platform execution remain pending.

### independent agent work

- Separate concurrent model/tool work from public speaking admission; keep unadmitted prose private, including Stop/failure output.
- Scope conversation observation and reuse unchanged committed histories. Runtime performance and recovery qualification remain pending.

### Earlier unreleased changes

- Removed the attachment explanation paragraphs from the + menu and below the composer.

### Fixed

- Prevent unchanged parent drafts from rebuilding the Markdown editor during typing; isolate thread editor state by composer ID. The recorded stale-update path was source reviewed; post-fix typing and rendered UI remain unverified. See [composer regression evidence](docs/handoff.md#october-6-2026--composer-draft-synchronization-regression).

### Added

- Generic Terraform/OpenTofu ECS Fargate, HTTPS ALB and S3 Files service module, Linux Nix OCI recipe, and disposable-state deployment/recovery runbooks. Source/schema and Apple Silicon build checks passed; Linux artifact and live AWS qualification remain pending.

- Backend dependency watching during local development, with graceful sequential restarts and unchanged frontend hot reload; documented background start, log and stop commands.

- Composer + menu for files/images, pasted-image previews, independent main/thread attachment drafts and attachment-only messages. Uploads become shared conversation assets immediately; removing a preview does not delete them. Verified raster images use native delivery; UTF-8 text has scoped reads, while PDF/Office/binary files remain download-only. Implementation qualification is tracked in [WP-040](docs/handoff.md#wp-040--composer-files-and-images).

- Optional conversation naming in the starting-agent chooser, retaining unnamed first-message previews and preserving explicit names on creation retries and subsequent messages.

- Rename shared conversation display titles from conversation actions, without changing messages, agent context, workspaces or creation-retry identity.

- Shared projects with current manager/member access, full-history conversations, configurable default agents, and operator-designated read-all access. Legacy personal groups and invite-only conversations retain their audiences; audience-changing transfers are not enabled. Stream delivery checks current project access on the native transaction line. Application checks do not establish isolation for shared coding tools or credentials.

- Reusable company text skills with explicit per-agent revision selections and a native assigned-only loader. New instances copy complete skill snapshots; creation and revision edits never automatically assign or upgrade skills. File packages and uploads remain deferred.

### Changed

- Memoized unchanged conversation transcripts and indexed replies once per message-array change, keeping synchronous draft and send-settlement behavior. Browser latency improvement remains unmeasured; see [WP-039](docs/handoff.md#wp-039--composer-render-isolation).

- Removed obsolete single-agent snapshot consumers, consolidated company-scoped latest-agent lookups, and clarified watcher/speaking-turn transitions without changing API compatibility fields or durable execution policy.

- Coding agents now start in the configured workspace (`DISPATCH_WORKSPACE_DIR`), defaulting to the repository root in local launchers. Idle instances using the old generated folders migrate on startup; custom paths, unfinished work, history, and old files are preserved.

- Agent Instructions now use the shared live Markdown editor with document-style Enter behavior and retain rendered formatting in saved views. Markdown storage and revision saves are preserved; oversized instructions remain editable with a visible save-blocking error.
- Updated Pi Durable and the directly used Pi AI, Chord, Coding Agent, and MCP packages from 1.0.1 to 1.0.4, with matching dependency locks and Nix inputs. This includes upstream provider-session affinity, OAuth refresh, and file/tool fixes; resolution of the observed WebSocket authentication error remains unverified.

- Corrected MCP connection setup to be provider-neutral: remote Streamable HTTP with OAuth, bearer tokens, custom headers or no authentication; server-supplied tool labels; migration of existing connection credentials/bindings; explicit local-only disconnect when provider revocation is unavailable.
- Rebuilt agent editing around compact identity, dominant instructions, model/capability summaries, staged MCP changes and one revision-save bar on desktop and phones. Added Settings authorization for existing provider identities, owner-managed disconnect/renewal, explicit application to existing instances, and retry-safe revision saves. API-based provider registration and delegated personal access remain deferred.

- Refined Conversations around consistent left alignment, compact messages and navigation, contextual reply/copy actions, data-backed reply summaries, distinct agent avatars, and readable tool disclosures. Threads and participants open a contextual panel on demand; main and thread composers retain their own destinations and drafts.

- Simplified shared reply publication to one successful-final publisher. Removed separate published-reply lists and consolidated interruption recovery and message identity checks. Historical duplicate repair now runs once during migration. Existing history and thread references remain intact.

- Removed the redundant composer `@` shortcut and restored the compact arrow-only Send button in messages and replies. Inline mentions still open by typing `@`.

- Mention people and agents directly in messages and replies: type `@`, filter the participant picker, and insert a highlighted name with the keyboard or pointer. The detached mention dropdown and separate draft chips are replaced by inline tokens that retain participant identity through editing and draft switching.

- Agents listen before responding, refresh their shared context after waits and tool work, and can stay silent when another participant has covered the request. Native Pi speaking turns prioritize mentions, coalesce considered deliveries and release during background work. Main and thread composers publish expiring typing presence without draft text; participant states distinguish Listening, Responding and Working.

- Replaced left/right chat bubbles with a shared author-attributed flow, reply threads, participant context and independent thread drafts. Project, pin and archive preferences are personal to each human member.

- Removed the required passkey-name field from signup and recovery enrollment; creation proceeds through the browser or password manager.

- Replaced the plain prompt field with an editable Markdown composer that formats typed and pasted content, copies Markdown, and retains per-chat drafts. Removed the inner focus box and the privacy/status sentence from its toolbar.

- Show bash output once by omitting completed assistant messages that only repeat the preceding terminal output; explanations and native records are preserved.

- Removed raw debug-data disclosures from tool activity while retaining command/output/status and native stored records. Grouped the terminal and follow-up text beneath one agent heading.

### Added

- Per-agent MCP connections with dedicated identity, tool discovery, native Pi tool execution, connection status and reconnect controls. Developer can use all configured remote tools through a separate, operator-provisioned credential; explicitly granted existing instances retain their history and workspaces.

- Invite-only shared conversations with starting-agent selection, human/agent invitations, mentions, full public history and independent agent instances. Native Pi tasks deliver other participants’ messages, permit silence and recover admitted work; Stop all cancels the conversation’s admitted work. Existing conversations retain IDs, history, configuration, workspaces and queued work through migration.

- Name-only projects inside Conversations: collapsible groups, a project conversation view, and a single project assignment per chat through Move to project. Existing chats remain unassigned; Pi stores private project metadata alongside its native conversation state. Desktop and phone layouts share the same controls.

- Read file cards show the returned line count, original file range, and numbered source, including existing saved reads. Native truncation/continuation notices and failures remain visible; reads use neutral highlighting.
- Pierre Diffs file cards for `write` and `edit`, including existing recorded calls: all-additions written content, native edit patches, line numbers, syntax highlighting, and execution status. The viewer loads separately, with local highlighting workers and bounded virtualized content.

- Compact bash terminal presentation with command, native live output, result status, and visible diagnostics in one transcript item; a generic fallback preserves other tools.

- Registered Developer with Pi’s `Coding` extension, native read/write/edit/bash tools, and persistent local workspaces. It inherits the saved default model/thinking values once; basic edits preserve coding capabilities, and the UI shows tools and workspace details.
- Copied Pi Durable’s example `Coding` prompt extension into a reusable server module, preserving provenance and its MIT license.

- Saved conversation pin/unpin and archive/restore actions, with right-side hover/focus controls and an archived view; removed redundant leading chat icons.
- Independent desktop sidebar/details visibility controls and draggable, keyboard-accessible width dividers that preserve active work.
- Implemented company invitation enrollment, password/TOTP and user-verified passkeys, opaque sessions, account security, restricted recovery, and local operator provisioning. Initial users have equal capabilities; chats remain private to their creator.
- Integrated stock Pi Durable 1.0.1 for native chat entries, streamed snapshots, Stop, request identity, persistent history, and service recovery. A persistent owner remains independent of frontend hot reload; company-shared agent definitions use immutable revisions copied into new chats.
- Built the Dispatch-branded desktop/mobile workspace with original SVG assets, local Inter, shared Base UI controls, chat tabs, agent editing, contextual agent/run views, and responsive panels.
- Extended the pinned Nix artifact to include the service, static client, dependencies, and app/account launchers. Root development, account, and built-app commands share local state and origin defaults.
- Recorded zero tests during this implementation stage. Future coverage focuses on end-to-end and API tests only after useful behavior is stable enough to preserve. Removed the initial exploratory suites; source/type/build checks continue, with runtime/device qualification deferred.

### Fixed

- Aligned agent tool activity with human and agent messages using the same avatar and author layout. Terminal/file output stays beneath the author, including after failed responses. Compact bash-output references retain their actions and only follow the same author's adjacent activity.

- Fixed duplicate agent replies when the first native publication marker was lost. Existing duplicates from the same generation resolve to one public reply while retaining raw history and old thread references.

- Made the default agent editable through the shared revisioned editor. Seed its configuration once, preserve saved changes across restarts, and use the latest revision for new chats while keeping existing chats unchanged. Default-agent archiving remains blocked.

- Reworked Agents hierarchy and alignment, promoted Start chat, grouped editor fields with persistent actions, and added a live draft preview. Sidebar navigation now confirms before discarding unsaved agent changes. Improved phone facts/navigation, compact editor controls, and shared select/example styling; unified Chats/Agents header dividers and model labels.

- Aligned Agents with Chats: sidebar creation/search/list/archive navigation, shared selected rows and hover/focus actions, a compact selected-agent main view, and saved configuration in the right column. Preserved open editors and existing service rules.

- Made the rail select workspace sections with their own sidebar and main content, preserving chat tabs and open forms. Agents and Account no longer create main tabs. Removed the repeated sidebar logo.
- Aligned conversation search with the New chat button and placed its magnifying glass inside the field.
- Removed the entire single-view main header and its duplicate New chat action. Sidebar chat creation opens tabs; desktop column toggles live in the rail and narrow-screen navigation in the bottom bar.
- Right-aligned user message bubbles, labels, timestamps, and copy actions while keeping assistant responses on the left across desktop and mobile.
- Moved close buttons onto their individual main tabs and hid the main tab strip when only one view is open, including the extra phone tab row.
- Applied the UI/UX review's accepted rules: shared readable styles, stronger selection and focus, labeled phone navigation, visible active tabs, preserved open-form/scroll state, and honest connection status.
- Preserved saved agent names, clarified native transcript/setup events and supporting views, used service defaults for new agents, named passkeys during enrollment, and explained unavailable last-factor removal.
- Protected newly edited drafts from delayed send responses. Source/type/build and rendered-layout review passed; interaction and authentication qualification remains deferred under the zero-tests policy.

### Documentation

- Added approved ImageGen designs following Chris's Slack visual reference: a shared message flow with contextual replies, starting-agent selection, participant invitations, and phone layouts. The designs inform the shared-conversation implementation.

- Recorded the accepted shared-conversation policies: agents consider other participants' messages with silence allowed, agents can invite company agents, each conversation has independent agent instances, and newcomers can read all public history. Prepared WP-024 with native Pi ownership, compatibility, access, recovery, and desktop/mobile acceptance criteria; implementation and qualification evidence are recorded in WP-024.

- Recorded an independent UI/UX review of `d83f70d`, using source plus authenticated desktop and phone captures, and adopted UI implementation rules covering tokens, readability, shared controls, workspace keyboard/touch behaviour, work preservation, actions and defaults, and content hierarchy. Retaining drafts through re-authentication and in-place identity re-checks remain proposed. The review found contrast, token, status, and state-preservation deviations, plus gaps in shared controls, tab focus and visibility, navigation state, and right-column structure. That review update changed documentation only.

### Earlier foundation decisions


- Required established Dispatch logos, colors, typography, and visual identity across desktop and mobile, with shared design tokens and brand acceptance checks. The initial provisional startup styling has now been replaced.

- Localhost frontend foundation with React Router SPA mode, React, TypeScript, Vite hot reload, Tailwind, and a responsive startup page. Added npm workspace commands, locked Nix development/build inputs, static artifacts, and verified local setup instructions; Omarchy/Palm deployment is deferred.

- Agreed chat as the first feature on stock Pi Durable with a default agent, independent conversations, streaming, Stop, history, reconnection, and restart recovery. Named agent definitions follow; broader native capabilities remain product goals.

- Required all user-facing functionality on desktop and mobile from each implementation slice, with adaptive workspace presentation, touch support, state preservation, and device acceptance checks. The implementation now uses responsive navigation/context panels; device qualification remains deferred.

- Recorded the supplied workspace layout and reference sketch, with a full tab-capable right column scoped to the active main tab and matching acceptance requirements.

- Specified company login with mandatory 2FA, TOTP and passkey support, equal initial user capabilities, and future RBAC. The coordinated implementation subsequently settled login composition, enrollment/recovery, and one-company installation scope.

- Recorded the proposed SPA/service architecture, independent review, state ownership and recovery boundaries, and acceptance areas; transport was subsequently implemented as validated JSON commands and SSE snapshots; the local tooling package uses React Router framework mode.

- Accepted TypeScript throughout the application, local development on M1 Air, and Nix development/build requirements with initial tooling acceptance criteria. The local tooling package now provides these entry points.

- Initial package layout with draft specification, implementation handoff, and usage-guide locations. The initial skeleton reserved source and test locations.


### Portability continuation — October 8, 2026

- Add bounded project-history JSON export/import with attachment checksums, manager export authorization, independent projects, inert history and atomic retry-safe admission.
- Add restricted offline SQLite recovery tooling requiring stopped writers and fenced original ownership; restore never starts a service.
- Package existing native capabilities for reviewed host installation on Pi Durable 1.0.4; bundle import never installs code.
- Type/build checks passed; later bounded functional, disposable recovery and desktop/390 px evidence, plus remaining acceptance limits, are recorded in the [portability handoff](docs/handoff.md#portability-manual-qualification--october-8-2026).
