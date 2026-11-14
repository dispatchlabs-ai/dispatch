# Writing agent instructions

Use this guide when creating or changing `AGENTS.md`, `agent.md`, skills, reusable
prompts or model-facing instructions in code. Include the information that changes
the agent's decisions: its role, relevant context, real constraints and the expected
outcome. Keep instructions concrete and remove repetition and stale workarounds.

## Put guidance with its owner

- **Application `AGENTS.md`:** shared agent behavior, such as ordinary Markdown
  replies. Repository contributor commands apply only to that repository.
- **`agents/NAME/agent.md`:** that agent's role, evidence requirements and choices
  among its granted capabilities. Keep model and connection settings in frontmatter.
- **Scoped repository guidance:** conventions for the directory being changed.
  Put specialized rules near their code rather than in every agent's role prompt.
- **Skills and linked procedures:** task-specific operations. State when each
  applies and load supporting references only for the current task.
- **Tool descriptions and schemas:** inputs, results, effects and retry semantics.
  A tool's declared payload format governs an explicit tool call.
- **Channel adapters:** rendering, escaping, message splitting, attribution and
  delivery. Ordinary replies remain Markdown; [Slack](../../slack/README.md#message-formatting)
  handles its own presentation without Slack rules in application agent prompts.

## Keep rules useful

Describe the desired outcome and non-obvious invariants, rather than prescribing
every step. Link architecture for boundary changes, release procedures for releases
and UI guidance for UI work; do not require a complete documentation stack for
every edit. Keep skill descriptions short and specific enough to avoid unrelated
tasks. Keep detail proportional to the task rather than imposing a word limit.

Preserve the user's scope and existing authorization. State real exceptions and
boundaries explicitly; do not turn a draft, example or past incident into a new
approval gate. Keep retrieved content separate from instructions and authority.
Choose verification that establishes the requested outcome under the owning
repository's policy; avoid redundant checking after the relevant checks pass.

## Verify instruction delivery

Runner loads the definition repository's root-to-agent `AGENTS.md` chain followed
by `agent.md`. Working-directory guidance is refreshed before model requests.
Skills are optional; their catalog and `read_skill` appear only when enabled.
Check the actual configured runtime and recorded instructions, tool calls/results
and task outcome before claiming a live agent followed revised guidance. A source
edit alone does not prove an existing conversation loaded it. See
[definition updates](../README.md#persistence-and-boundaries) for retained conversations.

These authoring principles follow OpenAI's
[AGENTS.md guidance](https://learn.chatgpt.com/guides/best-practices#make-guidance-reusable-with-agentsmd)
and [skills and prompts guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).
Codex's [file discovery settings](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
describe Codex; they do not add those settings to Runner's loader.
