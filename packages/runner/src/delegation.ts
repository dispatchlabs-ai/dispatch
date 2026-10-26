import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry, configure, defineExtension, defineTool,
  type AgentChange, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration,
} from "@earendil-works/pi-durable";

/** Native foreground children: parallel tool calls delegate in parallel; abort follows ownership. */
export function delegationExtension(owner: string, agents: { name: string; description: string; configuration: AgentChange }[], clones = false) {
  async function runChild(agent: string, task: string, configuration: AgentChange | undefined, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
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
    const receipt = await (await child.submit({ type: "input", content: task, requestId: `delegate:${api.taskId}` }, context)).wait(context);
    if (receipt.status !== "done" || receipt.type !== "input") throw new Error(`Delegate did not complete: ${receipt.status}`);
    const entry = await api.commit(tx => tx.entry(AssistantEntry, receipt.answer), context);
    const answer = entry?.model?.[0];
    if (answer?.role !== "assistant" || answer.stopReason === "error" || answer.stopReason === "aborted") {
      throw new Error("Delegate did not return a successful answer.");
    }
    const text = answer.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    return {
      output: [{ type: "text", text: text || "Delegate completed without a text response." }],
      details: { agent, conversationId: childId, answer: receipt.answer },
    };
  }
  const tools: ToolRegistration[] = [];
  if (agents.length) tools.push(defineTool({
      name: "delegate",
      description: `Delegate a bounded assignment and return its result. Assign disjoint files when workers edit the same checkout; use scouts for independent investigation. Available agents: ${agents.map(agent => `${agent.name}: ${agent.description}`).join("; ")}`,
      parameters: Type.Object({ agent: Type.String(), task: Type.String({ minLength: 1 }) }),
      replay: "safe",
      async execute({ agent, task }, api, context) {
        const target = agents.find(candidate => candidate.name === agent);
        if (!target) throw new Error(`Unknown delegate: ${agent}`);
        return runChild(agent, task, target.configuration, api, context);
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
