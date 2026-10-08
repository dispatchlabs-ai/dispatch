# Changelog

## Unreleased — continuing simplification

- Align runtime/setup guidance with shared-project authority, Developer defaults and safe idle definition/skill adoption; use canonical testing-policy links.
- Ignore root generated image outputs/run metadata without deleting user files or tracked design assets.

- Share agent-connection polling, remove an unused account dirty-state callback, and centralize fixed capability mappings.
- Replace unconditional image-directory retries with one exclusive creation and remove unused in-memory reference paths; retain audit metadata.

Integrated source/build checks passed; runtime/rendered qualification remains unverified. See [acceptance evidence](docs/handoff.md#continuing-simplification--october-8-2026).

## Unreleased — five-finding simplification

- Replace full-transcript chat listing with lightweight summaries and target pending base upgrades instead of scanning all chats after unrelated commits.
- Consolidate composer state and coordinate list refreshes with stale-response protection, preserving draft and retry safeguards.
- Reconcile current agent-management status/default-target eligibility and link check guidance to the canonical testing policy.

Integrated source review and TypeScript/application/Apple Silicon Nix checks passed; no deployment or new runtime/UI qualification is established. See [acceptance evidence](docs/handoff.md#five-finding-simplification--october-8-2026).

## Unreleased — chat presentation performance candidate

- Replace sidebar transcript projection with transactionally maintained public summaries and checkpointed existing-chat initialization.
- Load recent chat/thread previews first, fetch older history on demand, stream delivered-state deltas, and virtualize transcript rows. Expand paired tool activity in pages; complete message/activity downloads retain access to oversized content.
- Candidate implementation and scoped measurements are recorded in the [performance package](docs/handoff.md#chat-presentation-performance--october-8-2026). Final authenticated-service responsiveness, integrated checks, local installation and demonstration remain acceptance gates; no general performance or deployment qualification is claimed.

## Unreleased — chat criteria response

- Detach saved Definition of Done criteria inside the native read transaction so chats with criteria can serialize after settlement.

## Unreleased — chat Definition of Done

- Add shared Markdown completion criteria in chat Details, with authorized editing, revision conflicts, retained drafts and refresh-before-retry. Agents receive current criteria as guidance, not completion or work authorization.

## Unreleased — agent management eligibility

- Allow explicitly granted agent management for agents with tools, skills, extensions or connections, including default-agent and granted-editor targets. Preserve human grants, revision pins and permitted tuning fields.

## Unreleased — project working directories

- Add an optional service-host working directory in Project settings. New agent instances retain the selected workspace; changing project settings never redirects existing instances. Blank uses the installation default.

## Unreleased — shared work continuity

- Align shared-chat instructions and both history notifications: check recent history and relevant spec/work-package criteria before ending, and continue authorized, unblocked work without redundant public replies. No scheduling, native lifecycle or agent-definition changes.

## Unreleased — integration secrets

- Add Settings → Secrets for encrypted Exa keys or explicit server-environment grants, owner-scoped management, revision-conflict protection, and use-time credential authorization. Environment-only search now requires explicit agent grants.

## Unreleased — starter and GitHub bundles

- Add an explicit-model Developer starter through the existing archive preview/import path.
- Add public GitHub commit-pinned imports and tracked updates with durable reviewed previews, conservative local-edit conflicts, retained removed entries and atomic retry receipts. Updated definitions follow the existing safe-idle adoption policy. Source/build checked; runtime and rendered UI remain unverified. See [portability evidence](docs/handoff.md#portable-definitions-and-project-data--october-8-2026).

## Unreleased — portable agent and skill bundles

- Add Agents import/export with bounded ZIP parsing, requirement preview, exact assigned skill revisions and independent local copies. Native atomic receipts preserve same-operation retries; connections, credentials and existing instances remain untouched. Source/build checked; runtime and rendered UI qualification remain outstanding in the [handoff](docs/handoff.md#portable-definitions-and-project-data--october-8-2026). GitHub updates, starter distribution, project exports and backups remain later work.

## Unreleased — native web research

- Add the Web research capability with native search, page reading, literal find and numbered-link traversal, durable instance-local evidence and source citations. Interrupted network batches are not automatically replayed. Qualification tracked in [WP-054](docs/handoff.md#wp-054--native-web-research).

## Unreleased — agent authoring design

- Redesign agent overview, editor, sidebar and evaluation configuration around the approved concepts. Add section/case navigation, a persistent required evaluation change reason and shared Markdown formatting controls. Preserve existing draft, revision and profile-only boundaries. See [acceptance evidence](docs/handoff.md#agent-authoring-redesign--october-8-2026).

## Unreleased — Developer default

- Make Developer the company default and archive retired Dash/Dispatch without deleting revisions or changing existing conversation instances. Preserve Developer settings and migrate project defaults; new projects and implicit chat selections use Developer. Acceptance evidence and remaining qualification are tracked in the [handoff](docs/handoff.md#developer-default-and-dash-retirement--october-8-2026).

## Unreleased — browser skills

- Add pinned agent-browser core and dogfood exploratory-QA guidance for explicit skill assignment, without installing browser tooling or changing existing instance snapshots. Checks and activation limits are recorded in [the handoff](docs/handoff.md#bundled-agent-browser-and-dogfood-skills).

## Unreleased — project overview

- Add project chat search, All chats/Active filters, status and last activity. Move members, default agents and existing settings into the contextual details panel, with adaptive desktop/phone rows. See [implementation evidence](docs/handoff.md#project-overview-redesign--october-8-2026).

## Unreleased — in-place agent base upgrades

- Apply saved base revisions to active instances at safe idle boundaries, preserving identity/history, instance supplements and workspace paths. Retain immutable revisions and explicit MCP assignment; display applied base revision separately from actual connections. Source/build candidate evidence and outstanding recovery/UI qualification are tracked in [the handoff](docs/handoff.md#in-place-agent-upgrades--october-8-2026).

## Unreleased — project-row chat creation

- Start a chat directly from a project row using its default agents, without a setup dialog; focus the new composer and retain existing drafts. Use Chat terminology in product controls.
- Remove obsolete personal-project creation/listing/move paths; preserve ungrouped access and stored retry identities. Source/build checked; rendered and functional qualification remains outstanding in [WP-053](docs/handoff.md#wp-053--project-row-chat-creation-and-shared-only-projects).

## Unreleased — multiple agent instances

- Add explicit same-definition instances with optional names and creation-only instruction supplements, immutable instance targeting and stable creation retries. Source/build checked; runtime and rendered UI remain unqualified. Evidence in [WP-050](docs/handoff.md#wp-050--multiple-agent-instances-and-supplemental-instructions).

## Unreleased — MCP credential renewal recovery

- Preserve authorization after known pre-exchange connection failures and explicit temporary OAuth errors; allow the next attempt to renew. Keep uncertain rotations and rejected grants blocked, and report safe renewal reasons to tools.

## Unreleased — conversation agent removal

- Add per-instance removal: fence participation, cancel native work durably, preserve history and require explicit human re-addition as a fresh instance after cleanup. Source/build checked; runtime and rendered UI remain unqualified. Evidence and outstanding acceptance are tracked in [WP-049](docs/handoff.md#wp-049--remove-conversation-agents).

## Unreleased — inline agent invitations

- Extend inline `@` selection to available company agents, inviting them only on Send. Resolve invitation mentions and save the message/deliveries in one native commit; preserve existing instances and unchanged-request retries. Implementation and local acceptance evidence are tracked in [WP-048](docs/handoff.md#wp-048--invite-agents-through-inline-mentions).

## Unreleased — agent evaluation profiles

- Refine editing into a focused evaluation workspace with scannable expectations/cases, progressive disclosure, persistent save controls and profile history in context/phone Details. Gemini’s scoped designer-agent assessment is 91/100 (A−); human comprehension, broader accessibility and native-select arrow behavior remain unverified. See [WP-047](docs/handoff.md#wp-047--agent-evaluation-profiles-and-editor) for receipt-review limits.

- Add independently versioned evaluation profiles, criteria and standalone cases to saved agent definitions, with immutable history, conflict checks and retry receipts. Keep evaluator-only material out of operating instructions.
- Preserve archived profile access and company boundaries. This slice edits evaluation definitions; it does not execute cases, assess real conversations or produce results.

## Unreleased — image editing and visual verification

- Stop injecting `input_fidelity` into GPT Image 2/2.5 edits, including when older skill snapshots request it; retain explicit supported legacy-model values.
- Return generated pixels to the model for visual review alongside existing paths and audit records. Clarify mask preparation, review-before-publication, rejected-parameter recovery and truthful fallback guidance in the reusable image skill.

## Unreleased — permissioned agent management

- Add native authorized definition reads, revisioned tuning saves and forward restoration, with trusted instance identity, dual editor-revision pins, atomic receipts, explicit rolling quotas and no live rollout.
- Add separate human-session grant administration and audit APIs. No grants are seeded; Doctor's target and direct-save trial remain unconfigured. Proposal workflows, eval automation and a grant UI are not included.

## Unreleased — specification reconciliation

- Separate current acceptance contracts, legacy personal-group compatibility and future designs. Reconcile project authority, agent editing/context, admitted public replies and conversation-wide Stop; scope deployment and PostgreSQL evidence without claiming full qualification.

## Unreleased — agent file sharing

- Prepare workspace files privately with `conversation_attach` and publish saved attachment IDs through contribution review. Reuse existing attachment storage and rendering; Stop/discard does not publish prepared files.
- Omit `input_fidelity` on prompt-only image generation and include sanitized rejected-parameter diagnostics. Live generation, publication and recovery remain unverified.

## Unreleased — agent archive response

- Detach nested agent configuration from the catalog transaction before returning it, so successful archives do not display a failed-request error. The same public projection covers saved-agent retries and retained skill selections.

## Unreleased — backend reload cleanup

- Release cached model WebSockets and provider idle timers after Pi work drains, allowing backend reloads to finish without waiting for cache expiry.

## Unreleased — local PostgreSQL storage

- Add an opt-in PostgreSQL adapter for Pi Durable 1.0.4, with isolated logical stores, atomic batches, document history and a dedicated single-owner connection. SQLite remains the default; existing state is not migrated.
- Document separate-state PostgreSQL 17 container and Homebrew setups. Authentication, connections and attachments remain local; distributed workers, automatic takeover and AWS deployment are not implemented. Runtime qualification remains pending.

## Unreleased — preserved contribution review

- Add opt-in OpenAI image generation/editing and separately assigned skill guidance, with workspace output records and explicit interrupted-request uncertainty.

- Preserve prepared contributions and their speaking reservation through final review/publication while other work continues. Human typing pauses publication without discarding drafts.
- Explicit posts report pending until sibling tools finish; stable publication receipts, native successor checks and Stop cleanup cover the new ownership boundary. Runtime qualification remains pending.

## Unreleased — container architectures

- Add Linux ARM64 image output and default ECS to ARM64, retaining explicit X86_64 selection. Multi-platform registry publication and per-platform execution remain pending.

## Unreleased — independent agent work

- Separate concurrent model/tool work from public speaking admission; keep unadmitted prose private, including Stop/failure output.
- Scope conversation observation and reuse unchanged committed histories. Runtime performance and recovery qualification remain pending.

## Unreleased

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

- Corrected MCP connection setup to be provider-neutral: remote Streamable HTTP with OAuth, bearer tokens, custom headers or no authentication; server-supplied tool labels; migration of existing Wiki credentials/bindings; explicit local-only disconnect when provider revocation is unavailable. Wiki principal provisioning remains separate future work.
- Rebuilt agent editing around compact identity, dominant instructions, model/capability summaries, staged MCP changes and one revision-save bar on desktop and phones. Added Settings authorization for existing Wiki agents, owner-managed disconnect/renewal, explicit application to existing instances, and retry-safe revision saves. API-based Wiki agent registration and delegated personal access remain deferred.

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

- Per-agent MCP connections with dedicated identity, tool discovery, native Pi tool execution, connection status and reconnect controls. Developer can use all personal-Wiki article and evidence tools through a separate, operator-provisioned credential; explicitly granted existing instances retain their history and workspaces.

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


## Portability continuation — October 8, 2026

- Add bounded project-history JSON export/import with attachment checksums, manager export authorization, independent projects, inert history and atomic retry-safe admission.
- Add restricted offline SQLite recovery tooling requiring stopped writers and fenced original ownership; restore never starts a service.
- Package existing native capabilities for reviewed host installation on Pi Durable 1.0.4; bundle import never installs code.
- Type/build checks passed; functional, recovery and portability UI qualification remain outstanding.
