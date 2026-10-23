import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";

export function createProgress(namespace: string) {
  const Progress = defineDoc<{ summary: string; sequence: number }>({
    kind: `${namespace}.progress`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    checkpointWhen: () => false,
    initial: () => ({ summary: "", sequence: 0 }),
  });

  const ProgressTools = defineExtension({
    name: `${namespace}.progress`,
    tools: [defineTool({
      name: "report_progress",
      description: "Record a brief factual milestone or blocker for the supervising agent. Describe completed actions and what you are doing next; never include private reasoning or claim work you have not done.",
      parameters: Type.Object({ summary: Type.String({ minLength: 1 }) }),
      replay: "safe",
      async execute({ summary }, api, context) {
        await api.commit(async tx => {
          const state = await tx.doc(Progress, api.conversationId);
          if (state.summary !== summary) { state.summary = summary; state.sequence++; }
        }, context);
        return { output: [{ type: "text", text: "Progress recorded." }] };
      },
    })],
  });

  return { Progress, ProgressTools };
}
