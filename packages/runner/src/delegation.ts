import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineExtension, defineTool, type AgentChange } from "@earendil-works/pi-durable";

/** Native foreground children: parallel tool calls delegate in parallel; abort follows ownership. */
export function delegationExtension(owner: string, agents: { name: string; description: string; configuration: AgentChange }[]) {
  return defineExtension({
    name: `dispatch.delegation.${owner}`,
    tools: [defineTool({
      name: "delegate",
      description: `Delegate a bounded assignment and return its result. Assign disjoint files when workers edit the same checkout; use scouts for independent investigation. Available agents: ${agents.map(agent => `${agent.name}: ${agent.description}`).join("; ")}`,
      parameters: Type.Object({ agent: Type.String(), task: Type.String({ minLength: 1 }) }),
      replay: "safe",
      async execute({ agent, task }, api, context) {
        const target = agents.find(candidate => candidate.name === agent);
        if (!target) throw new Error(`Unknown delegate: ${agent}`);
        const cwd = api.env?.cwd ?? (await api.agent(context)).cwd;
        const childId = await api.commit(async tx => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing) return existing.id;
          const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, child.id, { ...target.configuration, cwd });
          return child.id;
        }, context);
        await api.details({ agent, conversationId: childId }, context);
        const child = await api.conversation(childId, context);
        if (!child) throw new Error("Delegate conversation disappeared.");
        const receipt = await (await child.submit({ type: "input", content: task, requestId: `delegate:${api.taskId}` }, context)).wait(context);
        if (receipt.status !== "done" || receipt.type !== "input") throw new Error(`Delegate did not complete: ${receipt.status}`);
        const entry = await api.commit(tx => tx.entry(AssistantEntry, receipt.answer), context);
        const answer = entry?.model?.[0];
        if (answer?.role !== "assistant" || answer.stopReason === "error" || answer.stopReason === "aborted") {
          throw new Error("Delegate did not return a successful answer.");
        }
        const text = answer.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
        return { output: [{ type: "text", text: text || "Delegate completed without a text response." }] };
      },
    })],
  });
}
