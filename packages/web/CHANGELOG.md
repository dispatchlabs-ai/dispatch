# Changelog

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
