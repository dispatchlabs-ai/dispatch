import { Type } from "typebox";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";

export function createProgress(namespace: string) {
  const Progress = defineDoc<{ summary: string; sequence: number; at?: number }>({
    kind: `${namespace}.progress`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    checkpointWhen: () => false,
    initial: () => ({ summary: "", sequence: 0 }),
  });

  const ProgressTools = defineExtension({
    name: `${namespace}.progress`,
    sections: [{
      key: "public-progress",
      async render({ conversationId, read }, context) {
        const progress = await read.snapshot(Progress, conversationId, context);
        return "Keep the user informed during sustained work with report_progress. At meaningful transitions, give one or two complete sentences: what you established, and what you are checking next. Aim for a useful update roughly every 30–60 seconds when new evidence is available. Include discoveries, failed checks and changes of direction; do not repeat the assignment, old authorization limits or a heartbeat. Public assistant commentary is also visible to the user. Long tools may keep running without a new report; never invent progress to fill the gap."
          + (progress?.at ? ` Your last recorded progress update was ${Math.max(0, Math.floor((Date.now() - progress.at) / 1000))} seconds ago.` : "");
      },
    }],
    tools: [defineTool({
      name: "report_progress",
      description: "Record one or two public sentences about a new finding, completed step, next action or blocker for the supervising agent and user. Report meaningful transitions during longer work. Do not repeat the assignment, old permissions, private reasoning or raw command output.",
      parameters: Type.Object({ summary: Type.String({ minLength: 1 }) }),
      replay: "safe",
      async execute({ summary }, api, context) {
        await api.commit(async tx => {
          const state = await tx.doc(Progress, api.conversationId);
          if (state.summary !== summary) { state.summary = summary; state.sequence++; state.at = api.now(); }
        }, context);
        return { output: [{ type: "text", text: "Progress recorded." }] };
      },
    })],
  });

  return { Progress, ProgressTools };
}
