import { configure, defineDoc, type Agent, type ConversationId, type Extension, type TaskRuntime, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { RequestCompletion } from "./request-completion.js";

/** Each immutable request has a native child and submission identity across task recovery. */
export function reviewConversation(kind: string, extension: Extension, tools: ToolRegistration[], thinking?: Agent["thinkingLevel"]) {
  const calls = defineDoc<{ children: Record<string, { child: ConversationId; prompt: string }> }>({ kind, version: 1, scope: "task",
    checkpointWhen: () => false, initial: () => ({ children: {} }) });
  return async <I, S, R, H extends object>(runtime: TaskRuntime<I, S, R, H>, ctx: Context,
    key: string, prompt: string, research: boolean) => {
    const parent = await runtime.agent(ctx);
    let call: { child: ConversationId; prompt: string };
    await runtime.commit(async tx => {
      const state = await tx.doc(calls, runtime.taskId);
      if (state.children[key] !== undefined) { call = state.children[key]; return; }
      const record = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
      const skills = parent.extensions.flatMap(extension => extension.tools ?? []).filter(tool => tool.name === "read_skill");
      const selected = research ? [...tools, ...skills] : [];
      await configure(tx, record.id, { model: parent.model, thinkingLevel: thinking ?? parent.thinkingLevel,
        cwd: parent.cwd, instructions: parent.instructions,
        extensions: [...parent.extensions.filter(item => item.name !== RequestCompletion.name), extension],
        tools: selected, modelTools: selected });
      call = state.children[key] = { child: record.id, prompt };
    }, ctx);
    const chat = (await runtime.conversation(call!.child, ctx))!;
    const submission = await chat.submit({ type: "input", requestId: "review:" + runtime.taskId + ":" + call!.child, content: call!.prompt }, ctx);
    const receipt = await submission.wait(ctx);
    if (receipt.type !== "input" || receipt.status !== "done") throw new Error("The private review ended without an answer.");
    const answer = (await runtime.context(call!.child, ctx, { at: receipt.answer })).entries.find(entry => entry.id === receipt.answer)?.model?.[0];
    const text = answer?.role === "assistant" ? answer.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
    return { child: call!.child, text };
  };
}
