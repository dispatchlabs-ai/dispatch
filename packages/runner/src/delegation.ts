import { Type } from "typebox";
import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry, configure, defineExtension, defineTool,
  type AgentChange, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { childUsage, delegationReceipts, observations, type DelegationReceipt } from "./delegation-receipts.js";

type Delegate = { name: string; description: string; fingerprint: string; configuration: AgentChange };

/** Native foreground children: parallel tool calls delegate in parallel; abort follows ownership. */
export function delegationExtension(owner: string, agents: Delegate[], clones = false) {
  async function runChild(agent: string, task: string, configuration: AgentChange | undefined, api: ToolExecutionApi, context: Context, fingerprint?: string): Promise<ToolExecutionResult> {
    const startedAt = await api.memo("startedAt", api.now(), context);
    const cwd = configuration ? api.env?.cwd ?? (await api.agent(context)).cwd : undefined;
    const childId = await api.commit(async tx => {
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing) return existing.id;
      // Pi copies the owner's stored agent, including tool/model-tool filters.
      // A clone deliberately makes no configuration change and copies no history.
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      if (configuration) await configure(tx, child.id, { ...configuration, cwd });
      return child.id;
    }, context);
    await api.details({ agent, conversationId: childId }, context);
    const child = await api.conversation(childId, context);
    if (!child) throw new Error("Delegate conversation disappeared.");
    // Preserve the existing request identity for interrupted delegate calls.
    const submission = await (await child.submit({ type: "input", content: task, requestId: `delegate:${api.taskId}` }, context)).wait(context);
    const entry = submission.status === "done" && submission.type === "input"
      ? await api.commit(tx => tx.entry(AssistantEntry, submission.answer), context) : undefined;
    const answer = entry?.model?.[0];
    const answered = answer?.role === "assistant" && answer.stopReason !== "error" && answer.stopReason !== "aborted";
    const parent = await api.agent(context);
    const receipt: DelegationReceipt = {
      kind: "dispatch.delegation", version: 1, agent, ...(fingerprint ? { fingerprint } : {}),
      model: configuration?.model ?? parent.model,
      thinking: configuration?.thinkingLevel ?? parent.thinkingLevel,
      conversationId: childId, submissionId: submission.id,
      outcome: answered ? "answered" : "unanswered", elapsedMs: api.now() - startedAt,
      recordedAt: new Date(api.now()).toISOString(), scope: "child_subtree",
      ...await childUsage(api, childId, context),
    };
    const text = answered ? answer.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
      : `Delegate did not return a successful answer: ${submission.status}${submission.status === "unanswered" ? ` (${submission.reason})` : ""}.`;
    const { kind: _kind, version: _version, fingerprint: _fingerprint, ...feedback } = receipt;
    return {
      ...(answered ? {} : { isError: true }),
      output: [
        { type: "text", text: `Recorded delegation receipt (estimated cost; answer quality is unscored):\n${JSON.stringify(feedback)}` },
        { type: "text", text: text || "Delegate completed without a text response." },
      ],
      details: { agent, conversationId: childId, ...(submission.status === "done" ? { answer: submission.answer } : {}), receipt },
    };
  }
  const tools: ToolRegistration[] = [];
  if (agents.length) tools.push(
    defineTool({
      name: "list_agents",
      description: "Inspect your configured delegates and your own model: purpose, model/thinking, declared tools, host catalog prices and observations from this conversation's retained delegation receipts. No inference or credential probe. Use before choosing unfamiliar workers; refresh when availability or prices matter.",
      parameters: Type.Object({}),
      replay: "safe",
      async execute(_args, api, context) {
        const parent = await api.agent(context);
        const receipts = await delegationReceipts(api, context);
        const modelCard = (ref: AgentChange["model"]) => {
          const model = ref ? api.models.getModel(ref.provider, ref.modelId) : undefined;
          return {
            selection: ref ?? null, registered: !!model,
            ...(model ? { contextWindow: model.contextWindow, input: model.input, rates: model.cost } : {}),
          };
        };
        const catalog = {
          observedAt: new Date(api.now()).toISOString(),
          pricing: { currency: "USD", unit: "per_million_tokens", source: "host_model_catalog", billingVerified: false },
          notes: "Registration is not a live availability check. Catalog rates can be stale or zero placeholders; subscription billing can differ. Declared tools remain subject to inherited filters and host permissions. Observations cover recorded receipts for this exact definition in this conversation; answered is not a quality verdict or comparable-task benchmark. Receipt costs exclude the coordinator; include coordination and retry costs in your choice.",
          coordinator: { agent: owner, thinking: parent.thinkingLevel, ...modelCard(parent.model) },
          agents: agents.map(agent => ({
            agent: agent.name, description: agent.description, thinking: agent.configuration.thinkingLevel,
            ...modelCard(agent.configuration.model),
            declaredTools: [...new Set((Array.isArray(agent.configuration.extensions) ? agent.configuration.extensions : [])
              .flatMap(extension => extension.tools?.map((tool: ToolRegistration) => tool.name) ?? []))],
            observations: observations(receipts, agent.name, agent.fingerprint),
          })),
        };
        return { output: [{ type: "text", text: JSON.stringify(catalog) }] };
      },
    }),
    defineTool({
      name: "delegate",
      description: `Delegate a complete assignment; return its result and recorded usage/cost receipt. list_agents provides model prices and capabilities. Parallel calls create independent children, including multiple instances of the same definition. Assign disjoint files to concurrent editors. Available agents: ${agents.map(agent => agent.name).join(", ")}`,
      parameters: Type.Object({ agent: Type.String(), task: Type.String({ minLength: 1 }), reason: Type.Optional(Type.String({ description: "Brief reason this worker fits the task and expected total cost." })) }),
      replay: "safe",
      async execute({ agent, task }, api, context) {
        const target = agents.find(candidate => candidate.name === agent);
        if (!target) throw new Error(`Unknown delegate: ${agent}`);
        return runChild(agent, task, target.configuration, api, context, target.fingerprint);
      },
    }));
  if (clones) tools.push(defineTool({
      name: "clone_agent",
      description: "Create a fresh, private child with your current instructions, model, thinking level, extensions and tool filters, but no conversation history. Send a complete bounded assignment and necessary context. Parallel tool calls run concurrently under the host's native tool-execution settings. The child returns its final report here; completion is not acceptance. Replaying this call recovers the same child. Host permissions still apply; use isolated resources for concurrent work.",
      parameters: Type.Object({ task: Type.String({ minLength: 1 }) }),
      replay: "safe",
      execute({ task }, api, context) {
        return runChild(owner, task, undefined, api, context);
      },
    }));
  return defineExtension({ name: `dispatch.delegation.${owner}`, tools });
}
