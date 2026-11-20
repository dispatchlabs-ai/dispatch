import { Type } from "typebox";
import type { Context } from "@earendil-works/chord/context";
import { LiveDoc, defineDoc, defineExtension, defineTool, wrapSection, type ToolExecutionApi, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import type { LoadedAgent } from "./definition.js";

type BatchNote = { completed: number; summary: string; at: number };

/** Report a long tool's verified receipts in its own conversation. Counts increase within each named phase. */
export async function batchProgress(api: ToolExecutionApi, context: Context, phase: string) {
  if (!(await api.agent(context)).callable.some(tool => tool.name === "report_progress")) return async () => {};
  let slot = 0;
  const key = () => `progress:${encodeURIComponent(phase)}:${slot}`;
  let saved = await api.memo<BatchNote>(key(), context);
  let last: BatchNote | undefined;
  let pending = Promise.resolve();
  return (completed: number, summary: string, milestone = false): Promise<void> => {
    const at = api.now();
    // Parallel receipts arrive while the preceding note is being committed.
    pending = pending.then(async () => {
      if (last && completed <= last.completed) return;
      if (saved ? completed < saved.completed : last && !milestone && at - last.at < 45_000) return;
      // Reuse the original count and wording if recovery collects receipts in a different order.
      const note = saved ?? await api.memo(key(), { completed, summary, at }, context);
      const result = await api.executeTool("report_progress", { summary: note.summary }, context, { key: key(), progress: false });
      if (result.isError) api.diagnostic({ severity: "warn", message: result.diagnostics[0]?.message ?? "Could not post the progress note." });
      last = note;
      slot++;
      saved = await api.memo<BatchNote>(key(), context);
    });
    return pending;
  };
}

export function createProgress(namespace: string, hostEnabled = true) {
  if (typeof hostEnabled !== "boolean") throw new Error("progressNotes must be a boolean.");
  const enabled = (agent: LoadedAgent) => hostEnabled && agent.progressNotes !== false;
  const muted: Wrap[] = [
    wrapSection("public-progress", section => ({ ...section, render: () => undefined })),
    { tool: "report_progress", wrap: (tool: ToolRegistration): ToolRegistration => ({
      ...tool, callers: [], execute: async () => ({ output: [{ type: "text", text: "Progress notes are off." }] }),
    }) },
  ];
  const Progress = defineDoc<{ summary: string; sequence: number; at?: number; input?: number }>({
    kind: `${namespace}.progress`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    checkpointWhen: () => false,
    initial: () => ({ summary: "", sequence: 0 }),
  });

  const ProgressTools = defineExtension({
    name: `${namespace}.progress`,
    wraps: hostEnabled ? [] : muted,
    sections: [{
      key: "public-progress",
      async render({ conversationId, read }, context) {
        const progress = await read.snapshot(Progress, conversationId, context);
        return "During sustained work, post one or two sentences in this chat with report_progress. Say what you found or decided and what you are checking next. Aim for an update every 30–60 seconds when there is new evidence, and surface a blocker promptly. Before a long tool call, share what you are about to check if that would help the reader. Group delegated results into a single update. Skip repeated commentary and routine heartbeats. Quick requests can go straight to the answer."
          + (progress?.at ? ` Your last recorded progress update was ${Math.max(0, Math.floor((Date.now() - progress.at) / 1000))} seconds ago.` : "");
      },
    }],
    tools: [defineTool({
      name: "report_progress",
      description: "Post a short progress note in the current chat about a new finding, decision, next step or blocker. Use facts appropriate for everyone in this conversation.",
      parameters: Type.Object({ summary: Type.String({ minLength: 1 }) }),
      replay: "safe",
      async execute({ summary }, api, context) {
        const text = summary.trim();
        if (!text) throw new Error("A progress note needs text.");
        const conversation = await api.conversation(api.conversationId, context);
        if (!conversation) throw new Error("Progress conversation is unavailable.");
        const requestId = `${namespace}.progress:${api.taskId}`;
        await api.commit(async tx => {
          const state = await tx.doc(Progress, api.conversationId);
          const input = (await tx.doc(LiveDoc, api.conversationId)).run?.inputs.at(-1);
          if ((state.input === input && state.summary === text) || await tx.submissionByRequest(api.conversationId, requestId)) return;
          const at = api.now();
          await conversation.submit(tx, { type: "write", requestId,
            entry: { kind: `${namespace}.background-reply`, data: { text, at, key: requestId } },
          });
          if (input === undefined) delete state.input;
          else state.input = input;
          state.summary = text;
          state.sequence++;
          state.at = at;
        }, context);
        return { output: [{ type: "text", text: "Progress recorded." }] };
      },
    })],
  });

  // A saved worker keeps its role's selection when host settings or its definition change.
  const forAgent = (agent: LoadedAgent) => defineExtension({
    ...ProgressTools, name: `${ProgressTools.name}.${agent.id}`, wraps: enabled(agent) ? [] : muted,
  });
  return { Progress, ProgressTools, forAgent, enabled };
}
