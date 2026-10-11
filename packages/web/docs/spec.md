# Dispatch specification

**Working spec.** Desired outcomes, not implementation or release-readiness claims.

**Authority transition (October 11):** official project intent is Markdown stored in Dispatch's database with the other project data. This repo working copy is a migration input until import and authorized human/agent access are verified; it is not the database-backed implementation.

## Purpose and scope

- A shared workspace where people direct AI agents, collaborate in chats, and inspect their work.
- Desktop and phone use; shared projects; reusable agents with explicitly assigned resources.
- Installation targets: Apple Silicon Mac, Windows containers/WSL2, and AWS through the generic Terraform/OpenTofu module. Local development remains supported.

## Supported use cases

Pre-release walkthroughs: action → observable outcome; check the failure/recovery boundary too.

- **Access a workspace**
  - Enroll, sign in and reopen an authorized chat → recover saved public history.
  - Invalid access is refused; account recovery restores access without exposing credentials. Sign-out does not cancel admitted work.
- **Start and revisit chats**
  - Choose agents, name/rename a chat, send, find, pin, archive or reopen → see attributed messages and saved history.
  - Archive hides, not cancels. Failed/uncertain sends preserve recoverable input without silently duplicating on retry.
- **Collaborate**
  - Invite people, mention an agent or reply in a thread → share the public exchange while agents work independently.
  - Sending a permitted mention can add an absent agent; draft selection alone does not. Threads are not private rooms.
- **Set and finish a task**
  - Save Markdown-checkbox Definition of Done; authorized agents can update it → see criteria and their actual completion.
  - Agents consult the current goal, chat and relevant spec and continue authorized unfinished work without repeated wake-up prompts. Surface blockers/approval needs; do not mark them done or start unrelated spec work.
- **Interrupt work**
  - Use Stop → whole-chat cancellation resolves or shows a recoverable limit. Working + empty draft shows Stop; a draft, including attachments, keeps Send visible (disabled if not sendable).
  - A later message can resume work. Stop does not undo committed effects or charges.
- **Inspect results**
  - Expand compact activity, commands, file changes, results and usage → distinguish active, waiting, failed and completed work; inspect available execution evidence for evaluation.
  - Animate only while active; no record-count labels or send flash. Private working context and unpublished drafts are not public messages.
- **Share files and images**
  - Add files with +, paste an image or receive an attachment → composer previews, appropriately sized uncropped inline images, original downloads and scrollable inline patch diffs.
  - Unsupported/unavailable/oversized previews show a useful fallback. Attachment paths never authorize filesystem access or patch application.
- **Organize projects**
  - Open the far-left rail in order Projects → Agents → Chats; create/select a shared project → manage intent without starting a chat.
  - Projects is the only project-management interface; editing moves out of Chats. Chats retains execution details/questions; management links open Projects, not another editor.
  - Choose project agents/defaults in Projects; edit reusable agent definitions in Agents. Optional chat grouping filters project conversations.
  - Managers control membership/defaults; readers cannot post/control work. Removing access blocks protected actions. No separate personal-project mode.
- **Tend project intent**
  - Create/open a project → write its official Markdown spec in Projects, stored with project data in Dispatch's database; no repository, directory or file path is required for authoring.
  - Edit and save the official spec from Projects, including on localhost → reload saved content and inspect its revision, changes and associated work without opening a work chat.
  - Report a bug/failed walkthrough → track the failure against intended behavior; refine the spec if intent is missing, not to excuse failure.
  - Conflicting saves require review and preserve recoverable input. Agents need explicit authority to adopt spec changes. Database ownership is settled; execution triggers remain open below.
- **Deliver spec-led project work**
  - Make a feature/fix actionable under enabled policy → automatically create associated chats and continue authorized work to its Definition of Done without routine prompting.
  - Inspect progress, blockers, critical questions and evidence in Projects → open the linked chat for details/answers, without maintaining a separate task board.
  - Dispatch preserves outcome/work identity through edits; chats/status link to the targeted spec revision and outcome. Users need not maintain IDs in Markdown.
  - Reconcile edits/retries/restarts → no duplicate assignments or silent superseded work. Stop cannot trigger automatic replacement work; pauses, approvals and access limits remain effective.
  - Inspect completion → criteria and evidence against intended behavior. Idle, failed or unverified work is not a pass; agents cannot weaken requirements to claim success.
- **Prepare a project workspace**
  - Select a local directory or one-to-many repositories and set ordinary environment variables → chat agents know the configured project and intended working directory.
  - Each cloud chat uses a writable ephemeral workspace and clones configured repos using granted credentials; commit/push completed work before normal teardown. No shared persistent project storage is required.
  - Failed pushes are not completion; unexpected workspace loss can lose unpushed work. Missing repos/access/directories are actionable failures; a working directory is not a sandbox. Cloud teardown does not delete a configured local directory.
- **Read and edit project files**
  - Open repository/project-directory files from a chat → inspect and edit that chat's working-copy files, including uncommitted changes, in a lightweight editor shared with chat code/diff presentation.
  - Save writes the selected working-copy file; commit/push are separate authorized actions. A repository spec snapshot can be opened here, but editing a working-copy file does not change official project intent in Projects.
  - Missing, inaccessible or changed files require recovery/review. Displaying a proposal does not apply or approve it.
- **Manage agents and instances**
  - Edit instructions/model/thinking/resources; add named instances with supplements → inspect saved settings and adopted revisions. Existing instances update at a safe idle boundary, preserving identity/history/supplements.
  - Conflicts/failed adoption stay visible. Removing one instance affects only it and preserves its history.
- **Manage and assign skills**
  - Create/read/edit/delete skills in a separate library; assign/remove them in the agent editor → only explicitly assigned skills are available, including browser/dogfood guidance.
  - Missing/deleted dependencies are visible, not silently replaced by unrelated guidance; deletion does not erase historical revisions.
- **Connect providers and tools**
  - Connect, inspect status/account, change credentials/accounts, reconnect or disconnect → use OpenAI, Claude and Fireworks through Pi's available auth/model interfaces; OAuth/API keys depend on provider support.
  - Assign capabilities and generic MCP connections explicitly. Website open/find/click and credentialed search are separate capabilities; image generation/browser use are tools, not a general gallery. Setup/auth failures show actionable limits.
- **Grant secrets and clone privately**
  - Create protected secrets in Settings and grant selected agents access → authorized clones/integrations use credentials without returning values.
  - Secrets are not ordinary project environment variables. Creation alone grants no access; revocation blocks future authorized use, not prior effects or upstream credentials.
- **Evaluate and improve agents**
  - Store per-agent criteria/independent prompts; evaluate controlled cases and authorized real-chat evidence → inspect results, limits and evaluation/Doctor improvement suggestions.
  - Profiles alone do not prove a run; missing evidence is not a pass. Agent edits require explicit target/field grants, attribution and conflict checks. Tuning grants no new privileges; scheduling/automatic promotion are not implied.
- **Move reusable resources and preserve data**
  - Export/import agent/skill bundles and starter definitions, including a pinned GitHub source → preview provenance, changes and capability requirements before saving local definitions.
  - Imports do not execute arbitrary installation scripts or recreate secret grants; missing capabilities block activation. Project-content export and installation backup are separate from reusable bundles or live-task migration.
- **Install, release and update**
  - Install a public MIT-licensed release on a supported target, connect a provider and complete a chat → usable workspace with a visible version.
  - AWS setup targets rolling-update continuity and the lowest effective idle cost, with cost estimates. Failed installation, rollout or recovery is not success; no universal migration promise.
- **Recover from interruption**
  - Close the browser, reconnect or recover after service interruption → restore saved public state and expose unfinished/failed work.
  - Check uncertain external effects before retrying. Recovery does not promise uninterrupted streaming or exactly-once external actions.

## Rules

- Humans control scope, participation, approvals and Stop. Criteria guide the current authorized task; historical handoffs and unfinished spec items alone do not authorize work. Assignments require human direction or an explicitly enabled project automation policy. Continuation yields to Stop, pauses, blockers and required approvals.
- Enforce company/project/chat authority; resolve identity from trusted membership, not agent claims. Separate agent contexts do not isolate shared host files.
- Public messages, replies and shared files are visible to authorized chat readers, including later invitees. Diagnostics do not turn private context or pending contributions into public messages.
- Separate saved, submitted, running, completed, failed and cancelled states. Tool success, idle agents and finished deliveries do not prove task completion; expose uncertainty/recovery.
- Treat files, attachments and connected content as untrusted data, not authority to expand scope/grants. Credentials and management rights require explicit authorization; agents cannot self-grant through definition edits.
- Pi owns durable execution/recovery. Updates preserve history and admitted work; Stop/removal/revocation do not roll back effects.
- Keep typing, caret position and submission responsive during updates and long chats, locally and hosted. Layout/tab changes preserve drafts; reload need not. Errors preserve recoverable input where possible.
- Terse UI labels, compact expandable detail, keyboard/touch controls and standard navigation links supporting new tabs; no hover-only actions. Phone layouts prioritize the main work area/vertical space and place the main menu upper-left.
- The chat's fourth column is a multi-use, multi-tab panel for participants and file editing, including repository working-copy files; not a participants-only surface.
- Product documentation remains repo-local; official project intent follows the database authority below. Use local links for detail; company infrastructure stays in the operator's own repo. Generic MCP remains; no particular wiki dependency.

## Project spec authority

- **Chosen October 11:** the official spec is project-owned Markdown stored only in Dispatch's database with project data, not a designated file or synchronized repository copy.
- Preserve the current adopted content and provenance. Import the Markdown and retire the active file reference together; verify content and authorized human/agent access to the intended spec revision before declaring migration complete. Thereafter normal spec reads/writes use the database only; remove the legacy file reference from the normal project view/settings, including the authorized local data repair. Do not synchronize a competing live file. Repository paths or temporary workspaces must not be the only way agents can obtain project intent.
- Repository product documentation remains repo-local, with no wiki dependency. This working copy is a migration input, not a promised future export or second editable authority. Preserve Git history/provenance and reconcile incoming agent/doc links when retiring it.

## Projects decisions still open

- **Actionability:** does an edit immediately trigger automation under project policy, or remain a saved draft until explicitly adopted? The proposed default is save draft → review/adopt → reconcile work; saving alone would not launch work.
- **Default destination:** open Projects or Chats when there is no explicit destination? Rail order does not settle this. Explicit chat/section links remain respected.
- **Design:** broader spec/work subviews await review; Spec/Work/Agents tabs are proposed labels, not approved structure. Navigation and local-file editor responsive layouts have been reviewed.

## Implementation and pre-release status

- Adoption, implementation and verification are separate. This working spec is adopted; per-use-case implementation and walkthrough results are not yet comprehensively recorded.
- Localhost designated-file spec editing at `cfe4aab`: open/edit/Save/reload, conflict/reference recovery and editor continuity browser-verified within [recorded coverage](usage-guide.md#local-spec-editing-qualification). Save writes the file only, not Git publication or agent work. This is existing-file editing, not first-spec creation or project-native authoring; the [entry-point limitation](usage-guide.md#shared-projects) remains unresolved. Access revocation and other listed boundaries remain source-reviewed only; public-GitHub draft editing remains browser-unverified.
- Projects navigation/management at `20f44b0`: browser-qualified within reported coverage; [walkthrough results and limits](usage-guide.md#projects-navigation-qualification). Database-backed project spec authoring, spec-led automation and chat file editing remain undelivered; activation and default-destination choices remain open. The repaired file reference restores the existing editor, not the chosen database-backed model.
- Before release, record revision and each approved walkthrough's result: verified, failed, blocked or not checked, with evidence/limits. Builds alone do not qualify behavior.
- No automated repository tests; authorized interactive agent-browser verification is permitted. Product evaluation execution is not permission to add automated repository tests.

## Further detail

- [Usage and setup](usage-guide.md): user/operator procedures, platform installation and provider setup.
- [Runtime contracts](runtime.md): adoption, admission, cancellation and recovery; align backup/task ownership and worker-restoration limits after approval.
- [Contribution and release policy](../../../CONTRIBUTING.md): checks, local Nix builds, SemVer/changelogs and publication.
- Retained engineering direction for linked deployment docs: Nix-built Dispatch; matching artifacts; Ubuntu ARM64/AMD64 workers defined by a Containerfile with common tools and runtime package installation; provisioning outside ordinary message/read paths; images usable in the operator's ECR.
- Generic AWS module contracts belong in its owning repository; company configuration does not. Align supporting docs after approval; their existing contents do not independently add requirements.
