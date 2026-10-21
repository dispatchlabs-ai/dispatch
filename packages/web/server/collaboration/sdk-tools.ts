import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { AssistantEntry, defineDoc, ToolTask, type TaskId, type ToolTaskResult, type JsonObject, type TaskRuntime } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Context } from "@earendil-works/chord";
import type { Api } from "@earendil-works/pi-ai";
import type { ClaudeRunScope } from "../claude-sdk/task.js";

/** A native tool child can post only as its committed SDK parent, never a fabricated Pi run. */
export const SdkToolBinding = defineDoc<{ reviewer?: TaskId }>({
  kind: "dispatch.sdk-tool-binding", version: 1, scope: "task", initial: () => ({}),
});
const SdkToolReceipts = defineDoc<{ calls: Record<string, { taskId: TaskId<ToolTaskResult>; fingerprint: string }> }>({
  kind: "dispatch.sdk-tool-receipts", version: 1, scope: "task", initial: () => ({ calls: {} }),
});

export async function sdkToolServer(scope: ClaudeRunScope, authorize: () => Promise<void>, beforeTool: (name: string) => Promise<void>) {
  const bridge = await nativeToolBridge(scope, authorize, beforeTool);
  return createSdkMcpServer({ name: "dispatch", tools: bridge.tools.map(selected => {
    const schema = z.fromJSONSchema(selected.parameters as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject;
    return tool(selected.name, selected.description, schema.shape, (args, extra) => {
      const requestId = extra && typeof extra === "object" && "requestId" in extra ? String(extra.requestId) : undefined;
      return bridge.call(selected.name, args, requestId);
    });
  }) });
}

/** Shared native child execution; transports never execute assigned tools outside Pi. */
export async function nativeToolBridge<I, S extends { phase: string }, R>(
  scope: { runtime: TaskRuntime<I, S, R, object>; context: Context; operationId: string },
  authorize: () => Promise<void>, beforeTool: (name: string) => Promise<void>,
  identity: { api: Api; provider: string } = { api: "anthropic-messages", provider: "anthropic" },
) {
  const { runtime, context } = scope;
  const agent = await runtime.agent(context);
  let sequence = 0;
  return {
    tools: agent.tools,
    async call(name: string, args: Record<string, unknown>, requestId?: string) {
      await authorize();
      const selected = agent.tools.find(candidate => candidate.name === name);
      if (!selected) throw new Error("Tool is not assigned to this agent.");
      await beforeTool(selected.name);
      const key = `${scope.operationId}:${requestId ?? String(++sequence)}`;
      const fingerprint = JSON.stringify([selected.name, args]);
      let taskId!: TaskId<ToolTaskResult>;
      await runtime.commit(async tx => {
        const receipts = await tx.doc(SdkToolReceipts, runtime.taskId);
        const prior = receipts.calls[key];
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Error("SDK tool request changed after admission.");
          taskId = prior.taskId; return;
        }
        const callId = `sdk:${key}`;
        const assistant = await tx.appendEntry(AssistantEntry, runtime.conversationId, { model: [{
          role: "assistant", ...identity, model: agent.model!.modelId,
          content: [{ type: "toolCall", id: callId, name: selected.name, arguments: args as JsonObject }],
          stopReason: "toolUse", timestamp: runtime.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }] });
        taskId = await tx.createTask(ToolTask, { assistant: assistant.id, callId }, { ownership: { kind: "task", taskId: runtime.taskId } });
        (await tx.doc(SdkToolBinding, taskId)).reviewer = runtime.taskId;
        receipts.calls[key] = { taskId, fingerprint };
      }, context);
      const settled = await runtime.waitForTask(taskId, context);
      if (settled.state.outcome.status !== "completed") return { content: [{ type: "text" as const, text: "Tool execution did not complete; its effects may be uncertain." }], isError: true };
      const entry = await runtime.entry(settled.state.outcome.result.entryId, context);
      const result = entry?.model?.find(message => message.role === "toolResult");
      if (!result || result.role !== "toolResult") throw new Error("Committed tool result is unavailable.");
      return { content: result.content, isError: result.isError };
    },
  };
}
