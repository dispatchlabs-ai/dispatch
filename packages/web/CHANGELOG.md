# Changelog

## Unreleased

### Changed

- Removed the required passkey-name field from signup and recovery enrollment; creation proceeds through the browser or password manager.

- Replaced the plain prompt field with an editable Markdown composer that formats typed and pasted content, copies Markdown, and retains per-chat drafts. Removed the inner focus box and the privacy/status sentence from its toolbar.

- Show bash output once by omitting completed assistant messages that only repeat the preceding terminal output; explanations and native records are preserved.

- Removed raw debug-data disclosures from tool activity while retaining command/output/status and native stored records. Grouped the terminal and follow-up text beneath one agent heading.

### Added

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

- Added proposed ImageGen designs following Chris's Slack visual reference: a shared message flow with contextual replies, starting-agent selection, participant invitations, and phone layouts. No application behavior changed.

- Recorded the accepted shared-conversation policies: agents consider other participants' messages with silence allowed, agents can invite company agents, each conversation has independent agent instances, and newcomers can read all public history. Prepared WP-024 with native Pi ownership, compatibility, access, recovery, and desktop/mobile acceptance criteria; implementation remains pending.

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
