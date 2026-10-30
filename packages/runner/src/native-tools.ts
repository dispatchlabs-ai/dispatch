/** Native Pi tools behind a host-owned OS boundary; no model or transport credentials. */
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness, NestedCallDoc, ToolTask,
  type JsonObject, type TaskId, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { privateStateDirectory } from "./private-state.js";

export type NativeToolCommand = { name: string; arguments: JsonObject; requestId: string };
const tools = CodingTools.tools as readonly ToolRegistration[];
const Requests = defineDoc<{ calls: Record<string, { digest: string; task: number }> }>({
  kind: "dispatch.native-tool-requests", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ calls: {} }), checkpointWhen: () => false,
});
const Execute = defineTask<NativeToolCommand, { phase: "execute"; child?: number }, ToolExecutionResult>({
  name: "dispatch.native-tool", version: 1, initial: () => ({ phase: "execute" }),
  phases: { async execute(task, runtime, ctx) {
    let child = task.state.checkpoint.child;
    if (!child) await runtime.commit(async tx => {
      const native = await tx.createTask(ToolTask, {
        kind: "nested", parent: task.id, parentCallId: task.input.requestId, key: "native",
        call: { type: "toolCall", id: task.input.requestId, name: task.input.name, arguments: task.input.arguments },
      }, { ownership: { kind: "task", taskId: task.id }, conversationId: runtime.conversationId });
      child = native;
      (await tx.doc(NestedCallDoc, task.id, "native", null)).taskId = native;
      return { status: "running", checkpoint: { phase: "execute", child } };
    }, ctx);
    await runtime.waitForTask(child as TaskId, ctx);
    const nested = (await runtime.snapshot(NestedCallDoc, task.id, "native", ctx))?.result;
    if (!nested) throw new Error("Native result unavailable; inspect the retained task before retrying.");
    const value = nested.structuredOutput;
    const content = typeof value === "string" ? [{ type: "text" as const, text: value }]
      : Array.isArray(value) ? value
      : value && typeof value === "object" && "type" in value ? [value]
      : value && typeof value === "object" && "output" in value
        ? [{ type: "text" as const, text: String(value.output) }] : [];
    const tool = tools.find(tool => tool.name === task.input.name)!;
    const result = JSON.parse(JSON.stringify({
      output: content, ...(tool.structuredOutputSchema ? { structuredOutput: value } : {}),
      isError: nested.isError, diagnostics: nested.diagnostics, details: nested.details,
    })) as ToolExecutionResult;
    await runtime.commit(async tx => {
      await tx.appendEntry(runtime.conversationId, { kind: "dispatch.native-tool-result",
        data: { requestId: task.input.requestId, name: task.input.name, result } as unknown as JsonObject });
      return { status: "terminal", outcome: { status: "completed", result } };
    }, ctx);
  } },
  async abort(_task, runtime, ctx) {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
  },
});

export function nativeToolProxies(
  invoke: (command: NativeToolCommand, api: ToolExecutionApi, context: Context) => Promise<ToolExecutionResult>,
  names: readonly string[] = tools.map(tool => tool.name),
) {
  if (names.some(name => !tools.some(tool => tool.name === name))) throw new Error("Unknown native tool.");
  return defineExtension({
    name: "dispatch.native-tool-proxies",
    tools: tools.filter(tool => names.includes(tool.name)).map(tool => defineTool({
      ...tool, replay: "safe" as const,
      description: `${tool.description} Executes in this conversation's host-isolated workspace.`,
      async execute(args, api, ctx) {
        const requestId = await api.memo("dispatch.native-tool-request", randomUUID(), ctx);
        return invoke({ name: tool.name, arguments: args as JsonObject, requestId }, api, ctx);
      },
    })),
  });
}

/** The host must supply isolation. A different cwd or scrubbed environment is not an OS boundary. */
export async function openNativeTools(directory: string, workspace: string) {
  await privateStateDirectory(directory);
  const release = await lockfile.lock(directory, { realpath: false });
  const env = new NodeExecutionEnv({ cwd: resolve(workspace) });
  let harness: Harness;
  try {
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install({ name: "dispatch.native-tool-executor", tasks: [Execute] });
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
      registry, models: createModels({ authContext: { env: async () => undefined, fileExists: async () => false } }),
      env: async () => env,
    }, context);
  } catch (error) { await release(); throw error; }
  const conversation = await harness.root(context);
  return {
    async execute(command: NativeToolCommand) {
      if (!command.requestId || !tools.some(tool => tool.name === command.name)) throw new Error("Invalid native tool request.");
      const digest = createHash("sha256").update(JSON.stringify([command.name, command.arguments])).digest("hex");
      const id = await conversation.commit(async tx => {
        const requests = await tx.doc(Requests, conversation.id);
        const previous = requests.calls[command.requestId];
        if (previous) {
          if (previous.digest !== digest) throw new Error("Conflicting native tool retry.");
          return previous.task;
        }
        await tx.appendEntry(conversation.id, { kind: "dispatch.native-tool-request", data: command });
        const task = await tx.createTask(Execute, command, { ownership: { kind: "conversation" } });
        requests.calls[command.requestId] = { digest, task };
        return task;
      }, context);
      harness.resume();
      const settled = await harness.waitForTask(id as TaskId<ToolExecutionResult>, context);
      if (settled.state.outcome.status !== "completed") return {
        isError: true, output: [{ type: "text" as const, text: "Native tool interrupted or cancelled; inspect the workspace before a new attempt." }],
      };
      return settled.state.outcome.result;
    },
    async stop() {
      for (const task of (await harness.inspect(context)).tasks) await harness.abortTask(task.record.id, context);
      harness.resume();
      await harness.waitForIdle(context);
    },
    async status() {
      return { pid: process.pid, workspace, tasks: (await harness.inspect(context)).tasks.map(task => ({ id: task.record.id, kind: task.record.kind })) };
    },
    async close() {
      try { await harness.close(context); await env.cleanup(context); } finally { await release(); }
    },
  };
}
