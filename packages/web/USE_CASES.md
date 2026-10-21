# Dispatch use cases

Dispatch is a self-hosted workspace where people and AI agents solve problems together in shared chats. This inventory describes supported actor goals and approved additions for development and behavior preservation; DSP-046–DSP-048 and DSP-050–DSP-051 are planned additions awaiting implementation; DSP-049 is implemented with scoped local acceptance. It is not a release-qualification checklist or a replacement for the [authoritative project specification](docs/spec.md). Procedures, prerequisites and verification limits remain in the [usage guide](docs/usage-guide.md).

| Term | Meaning |
| --- | --- |
| Company | The people, agents and shared resources belonging to one installation. |
| Project | A shared grouping of chats, members, workspace settings, specifications and operating instructions. |
| Agent definition | A reusable, versioned configuration of instructions, model, skills and capabilities. |
| Agent instance | An independent participant created from a definition, with its own working context and optional supplemental instructions. |
| Definition of Done | Shared criteria for a chat's authorized task. |
| Skill | Reusable instructions selected from the company's versioned library. |

People act through their own accounts; project managers maintain project settings and membership. Agents act under their instance identities and granted access. Operators maintain the installation and provision accounts; integrations and library consumers use the application's authenticated interfaces or reusable capability package.

## 1. Workspace access

- **DSP-001 — Join and access a workspace.** An invited person enrolls and signs in with a verified passkey or password plus an authenticator to access authorized work.
- **DSP-002 — Maintain account security.** A person manages sign-in factors and active sessions, signs out, or recovers access with supported recovery methods.
- **DSP-003 — Provision and recover accounts.** An operator issues enrollment invitations or resets an independently verified person's account for fresh enrollment.

## 2. Conversations and collaboration

- **DSP-004 — Work with agents.** A person starts a chat with selected agents and exchanges messages to accomplish an authorized task.
- **DSP-005 — Collaborate with people and agents.** A participant brings available agents into a chat, while a human participant can also invite company colleagues to share its public history and ongoing work.
- **DSP-006 — Focus a discussion.** A participant uses mentions and reply threads to direct attention and discuss a particular message within the shared chat.
- **DSP-007 — Divide work among agent instances.** A person or agent adds independent instances with optional names and supplemental instructions to address different parts of the task.
- **DSP-008 — Coordinate dependent work.** A Pi agent waits for explicitly identified results from other participants and resumes when results, intervention or its review deadline require attention.
- **DSP-009 — Maintain completion criteria.** A human participant or capability-enabled agent reads, updates or clears the chat's shared Definition of Done.
- **DSP-010 — Control ongoing participation.** A human participant stops all responses or removes an agent instance while retaining published history and completed effects.
- **DSP-011 — Resume observation of work.** A person reopens a chat after disconnecting to inspect saved history and ongoing or recovered agent work.
- **DSP-012 — Organize personal chat visibility.** A person names chats and manages personal pins and archives to find relevant conversations without cancelling their work.
- **DSP-013 — Inspect execution evidence.** A person reviews attributed replies, tool activity, commands, file changes, failures and available usage to understand what agents actually did.
- **DSP-046 — Obtain independent review.** A requester asks a separate reviewer agent to assess a change against its completion criteria and return actionable findings to the original implementer.
- **DSP-050 — Resolve work needing attention.** A participant identifies chats needing input or review, resolves their outstanding items and distinguishes task completion from agent execution.

## 3. Files, research and tools

- **DSP-014 — Exchange working material.** People and agents share files and images in chats, inspect supported previews including patch diffs, and retrieve original attachments.
- **DSP-015 — Use supplied context.** An agent reads public conversation history and supported text or image attachments to inform its work.
- **DSP-016 — Work on project files.** A suitably configured agent reads and edits workspace files and runs commands to carry out the authorized task.
- **DSP-017 — Research public sources.** An enabled agent reads public web pages and, with a search credential grant, searches for source material.
- **DSP-018 — Create visual assets.** An enabled agent generates or edits images through a configured provider and shares selected results with chat participants.
- **DSP-019 — Use connected services.** An authorized agent invokes tools from connected MCP servers to carry out work in external systems.
- **DSP-020 — Work with protected repositories.** A granted agent clones private repositories and uses project GitHub App access to fetch, inspect remote refs or push permitted commits.
- **DSP-048 — Keep work artifacts accessible.** A participant maintains named links and pinned attachments for a chat's originating request, plan, PR, deliverables and verification evidence.

## 4. Shared projects and intent

- **DSP-021 — Establish a shared project.** A project manager organizes chats, membership and default agents around a common body of work.
- **DSP-022 — Configure the working environment.** A project manager selects project directories or repositories for agents' workspaces.
- **DSP-023 — Maintain product intent.** A project manager or human-directed project-chat agent reads and saves versioned Markdown specifications with conflict protection and attributable revisions.
- **DSP-024 — Set common operating rules.** A project manager maintains shared instructions that project agent instances adopt at safe idle boundaries.
- **DSP-025 — Consult related work.** An agent discovers and reads other chats' permitted public context within its current project without joining or reactivating them.
- **DSP-047 — Preserve intended behavior.** Implementation and review agents identify affected use cases and verify that a change preserves them or implements an explicitly approved change.
- **DSP-049 — Review changes to project intent.** A person browses saved project-spec revisions and compares changes to understand how intended behavior evolved. **Implemented; local acceptance passed.** See [usage and verification limits](docs/usage-guide.md#saved-spec-history-dsp-049).

## 5. Reusable agents, skills and access

- **DSP-026 — Configure reusable agents.** A person creates, revises or archives named agent definitions with selected instructions, execution backend, model, thinking settings, skills and capabilities.
- **DSP-027 — Understand active configuration.** A person inspects an instance's definition, supplemental instructions and adopted project instructions to understand its effective configuration.
- **DSP-028 — Maintain a skill library.** A person manages versioned shared skills and explicitly selects the skill revisions available to each agent.
- **DSP-029 — Let agents maintain shared guidance.** An agent on the local backend reads the shared skill library and, with separate library-write access, creates or revises reusable skills.
- **DSP-030 — Delegate definition maintenance.** A human grants or revokes target-specific agent-management access so an authorized agent can inspect, revise or restore permitted definition fields.
- **DSP-031 — Connect model providers.** A person configures supported provider authentication and selects available models for agent execution.
- **DSP-032 — Manage external tool access.** A person authorizes, inspects, reconnects or disconnects MCP connections used by agents.
- **DSP-033 — Control credential use.** A person stores or rotates protected credentials and grants or revokes selected agents' access to supported credentialed operations.
- **DSP-034 — Control GitHub repository access.** An authorized person connects an existing GitHub App installation and a project manager grants agents repository-specific read or write access.

## 6. Agent evaluation

- **DSP-035 — Define evaluation expectations.** A person maintains versioned responsibilities, criteria and independent cases for assessing an agent.
- **DSP-036 — Compare instruction changes.** An eligible evaluation requester runs a local Muse baseline and candidate instruction comparison against prepared, separately registered fixtures.
- **DSP-037 — Record evidence-based judgments.** A human reviewer inspects comparison runs and available evidence and records criterion judgments without automatically changing the agent.
- **DSP-051 — Derive evaluations from real work.** A person turns a selected chat or agent contribution into a reviewed standalone evaluation case with starting conditions, success criteria and source provenance.

## 7. Portability and integration

- **DSP-038 — Reuse agent and skill collections.** A person previews, exports or imports agent and skill bundles, including starter definitions and updates from pinned public GitHub sources.
- **DSP-039 — Preserve project history.** A project manager exports selected chat history and attachments, and a person imports an archive as a new project with read-only historical content.
- **DSP-040 — Integrate an application client.** An authenticated integration manages permitted chats, projects and reusable resources and observes conversation updates through the application API.
- **DSP-041 — Reuse native capabilities.** A compatible Pi Durable host embeds Dispatch's coding guidance, assigned skills, web research or image-generation capabilities with its own tools, execution environment and credentials.

## 8. Installation and operation

- **DSP-042 — Operate an installation.** An operator runs and updates Dispatch using its source, portable Mac package or container artifacts with retained application state.
- **DSP-043 — Operate distributed conversations.** An operator runs conversation workers with durable history, optional warm capacity and idle retirement to support hosted work. The opt-in [portable protocol](docs/portable-workers.md) runs the whole conversation worker on an installation-selected ECS or exe.dev provider while the main service owns its PostgreSQL access; portable ECS warm capacity remains unsupported.
- **DSP-044 — Preserve and recover installation state.** An operator creates and restores offline SQLite installation backups containing the selected state, workspaces, credentials and configuration needed for recovery.
- **DSP-045 — Diagnose service problems.** An operator correlates reported failures with application diagnostics and inspects configuration and worker state to restore service.
