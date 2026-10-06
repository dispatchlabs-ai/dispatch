# Handoff to Claude: agent definition design review

October 6, 2026. Chris requested an independent opinion on the design, with the proposed screen and its Pi Durable explainer available together. This is a review request; the advanced agent editor has not been approved for implementation.

## Read and inspect these first

Open both PNGs as images, rather than inferring their contents from filenames or this document. The numbered groups 1–10 match across them.

1. [Proposed agent editor](assets/agent-definition-2026-10-06/01-agent-editor.png): the Recovery Engineer definition and a separate project assignment panel.
2. [Pi Durable field mapping](assets/agent-definition-2026-10-06/02-pi-durable-mapping.png): how those fields relate to saved configuration, registered executable code, and runtime state.
3. [Detailed design and storage reference](agent-definition-design.md): the precise mapping, current/proposed distinctions, and links to inspected implementation sources. Treat this text and the source as the authority when an illustration simplifies a detail.

The canonical local checkout is `/Users/chrisreynolds/Work/m1-air/repos/dispatch-web-next`. These files live under `packages/web/docs/`. The visual proposal was published in `868d95954976e834de787a250087b645f068243e`, following the conversation-layout implementation recorded in `98d2ad20553a51fb15465224cc7b820bac450473`.

## What led to this design

Chris was considering reusable agents for investigating old backups and recovering photos, email archives, and other useful files. Suggested roles included Recovery Engineer, Archivist, and Evidence Reviewer. He then asked how to define agents in a way that also works for other projects.

The proposal separates reusable expertise, working method, capabilities, knowledge, identity, and execution choices from one project's goal, inputs, output location, collaborators, and constraints. A definition can serve many projects; a participant selects a particular saved revision. Home Photos is an example assignment, not a restriction on the product or on the reusable agent.

Chris specifically wanted to understand whether each UI field becomes extension code or saved data and, for SQLite data, where it lives. The mapping graphic answers that technical question; it is an explanatory companion, not a proposed end-user product screen.

## Current implementation versus proposal

The current editor saves name, description, instructions, provider/model, and thinking level. The runtime has revisioned definitions, extension/tool names, per-conversation agent configuration, and operator-managed MCP connections. New definition revisions apply to newly created participants; do not assume an edit silently changes existing instances.

The additional capability controls, knowledge/procedure/memory choices, runner selection, workflow picker, qualification controls, and richer project assignment are proposals. Example recovery extensions, tools, storage identities, and readiness checks are illustrative, not installed capabilities. Current projects organize conversations by name; they do not implement the pictured assignment contract. The mockup's surrounding navigation is also illustrative and does not authorize changes to the established app navigation.

The implementation evidence uses stock Pi Durable **1.0.1**:

- `dispatch.catalog` holds Dispatch's reusable definition revisions. Each instantiated agent has a native conversation and `pi.agent` configuration. Participant metadata pins the definition ID and revision.
- In `<stateDir>/pi.sqlite`, `documents` supplies document identity/address metadata. Configured values are reconstructed from `document_revisions.content` base values and later deltas. `documents.record` is metadata, not the configured values. There is no native `agents` SQL table.
- Saved extension and tool names select registered executable implementations. Prompt sections, hooks, wrappers, tools, tasks, and the host's `ExecutionEnv` still require code. A selected field alone does not implement retrieval, memory, scheduling, access enforcement, or recovery.
- Proposed `profile`, `dispatch.assignment`, and `dispatch.qualification` names belong to Dispatch; they are not built-in Pi types or accepted schemas. Their detailed contracts remain open.
- Native durable task state/checkpoints are different from definition configuration and ordinary conversation history. External-job reconciliation belongs in the implementation. Credentials and large source/recovered artifacts remain in their owning systems; documents can hold references. A working directory is not a sandbox.

## Screen work already completed

We previously compared Dispatch's conversation view with Slack and implemented the approved [main-conversation and open-thread refinements](conversation-layout-refinements.md). That work established shared alignment, denser messages, contextual actions, visible reply summaries, distinct agent identities, readable tool disclosures, separate main/thread composers, and an optional right context panel. [WP-028](handoff.md#wp-028--conversation-layout-refinement) records the actual desktop, narrower-desktop, and 390 px browser observations and their limits.

Use those existing screens as visual and interaction context. The new editor proposal uses the same general Dispatch navy/aqua palette, Inter typography, rail/sidebar/content structure, and right context area. It has not had responsive or interactive acceptance review. Generated desktop imagery is not proof of keyboard, phone, focus, save/error, or recovery behavior.

Optional local actual captures are in the canonical checkout's ignored `.local/conversation-refinement/2026-10-06/` directory, especially `after-main.png` and `after-thread.png`. Keep account-bearing captures out of Git. The maintained [repository home](https://wiki.chrisreynolds.me/wiki/dispatch-web-next/) records product intent; [agent runtime architecture](https://wiki.dispatchworks.ai/wiki/agent-runtime-architecture/) and [no-code agent factory](https://wiki.dispatchworks.ai/wiki/no-code-agent-factory/) supply the business design context. The newly connected personal `wiki` MCP accesses the Palm wiki; do not assume it also grants access to the separate Dispatch wiki.

## Review requested

Please give Chris your own judgment, including disagreements with this proposal. Evaluate the images themselves as well as the explanation:

- Is the reusable definition versus project assignment distinction clear? Does the screen support the order in which someone would actually create and use an agent?
- Are the layout, density, hierarchy, terminology, and defaults suitable for someone defining useful agents without understanding Pi internals? What deserves progressive disclosure, a different screen, or removal?
- Are saving a revision, assigning an agent, readiness checking, and handling unsaved edits clear enough? Identify ambiguous states or actions rather than assuming their behavior.
- Does the proposal accurately respect Pi Durable's ownership of execution and state? Identify places where the UI could imply behavior or guarantees that selected configuration cannot provide.
- What should be kept, what are the most consequential problems, and what is the smallest coherent next design step? Include narrow-screen and accessibility implications, distinguishing visible problems from untested concerns.

Start with a concise overall verdict, then prioritize concrete findings and recommendations. Refer to the numbered groups where helpful. State that you opened both images, and say explicitly if either could not be inspected. Separate established facts, design opinions, and unresolved contracts. Propose changes for review; do not modify code, launch implementation, or run tests. Return your critique in the existing Claude conversation so Chris can discuss it with you directly.
