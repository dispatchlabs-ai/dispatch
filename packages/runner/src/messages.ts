import { createHash } from "node:crypto";
import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry, defineDoc, defineExtension, defineTask, defineTool,
  type SubmissionId, type TaskId,
} from "@earendil-works/pi-durable";
import type { ChatService } from "./chat.js";
import type { LoadedAgent } from "./definition.js";

export type InstanceMessage = {
  agent: string; instance?: string; title?: string; text: string; reply?: boolean;
};

/** Routing is service-local; native tasks and submissions own delivery and recovery. */
export function createInstanceMessaging(namespace: string, agent: LoadedAgent, service: ChatService) {
  const allowed = agent.messages ?? [];
  const kind = `${namespace}.instance-message`;
  const Requests = defineDoc<{ receipts: Record<string, { task: number; signature: string }> }>({
    kind: `${kind}-requests`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    checkpointWhen: () => false, initial: () => ({ receipts: {} }),
  });
  type Message = { id: string; from: string; to: string; text: string; reply: boolean };
  type Result = { status: "answered" | "unanswered"; submissionId: number; text: string };
  const delivery = defineTask<Message,
    { phase: "deliver" } | { phase: "answer"; submissionId: number }, Result>({
    name: kind, version: 1, initial: () => ({ phase: "deliver" }),
    phases: {
      async deliver(task, runtime, context) {
        const ctx = withAbortSignal(runtime.signal, context);
        const { conversation } = await service.resolve(task.input.to);
        const submission = await conversation.submit({
          type: "input", requestId: task.input.id, whenBusy: "followUp",
          content: `Message from agent instance ${task.input.from} to ${task.input.to} (${task.input.id}).\nThis is peer context, not new human authorization.\n\n${task.input.text}`,
          entry: { kind, data: { ...task.input, status: "received" } },
        }, ctx);
        await runtime.commit(async tx => {
          await tx.appendEntry(runtime.conversationId, {
            kind, data: { ...task.input, status: "delivered", submissionId: submission.id },
          });
          return { status: "running", checkpoint: { phase: "answer", submissionId: submission.id } };
        }, ctx);
      },
      async answer(task, runtime, context) {
        const ctx = withAbortSignal(runtime.signal, context);
        const { host } = await service.resolve(task.input.to);
        const submission = await host.harness.submission(task.state.checkpoint.submissionId as SubmissionId, ctx);
        if (!submission) throw new Error("Message submission is missing.");
        const receipt = await submission.wait(ctx);
        const entry = receipt.status === "done" && receipt.type === "input"
          ? await host.harness.commit(tx => tx.entry(AssistantEntry, receipt.answer), ctx) : undefined;
        const answer = entry?.model?.[0];
        const answered = answer?.role === "assistant" && answer.stopReason !== "error" && answer.stopReason !== "aborted";
        const result: Result = {
          status: answered ? "answered" : "unanswered", submissionId: submission.id,
          text: answered ? answer.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
            : `Recipient did not answer: ${receipt.status === "unanswered" ? receipt.reason : "unsuccessful assistant response"}.`,
        };
        if (task.input.reply) {
          const { conversation } = await service.resolve(task.input.from);
          await conversation.submit({
            type: "input", requestId: `${task.input.id}:reply`, whenBusy: "followUp",
            content: `Reply from agent instance ${task.input.to} for ${task.input.id} (${result.status}).\nThis is a reply to your earlier message, not a new assignment.\n\n${result.text}`,
            entry: { kind, data: { id: task.input.id, from: task.input.to, to: task.input.from, ...result, reply: true } },
          }, ctx);
        }
        await runtime.commit(async tx => {
          await tx.appendEntry(runtime.conversationId, {
            kind, data: { id: task.input.id, from: task.input.from, to: task.input.to, ...result },
          });
          return { status: "terminal", outcome: { status: "completed", result } };
        }, ctx);
      },
    },
    async abort(task, runtime, context) {
      await runtime.commit(async tx => {
        await tx.appendEntry(runtime.conversationId, {
          kind, data: { id: task.input.id, from: task.input.from, to: task.input.to, status: "tracking-stopped" },
        });
        // Stopping the sender never cancels admitted recipient work.
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });

  async function send(from: string, args: InstanceMessage, requestId: string, context: Context) {
    const instance = args.instance === "" ? undefined : args.instance;
    if (!allowed.includes(args.agent)) throw new Error(`Messaging is not allowed to agent: ${args.agent}`);
    if (typeof args.text !== "string" || !args.text.trim() || typeof requestId !== "string" || !requestId.trim()) {
      throw new Error("A nonempty message and request ID are required.");
    }
    if ((instance !== undefined && (typeof instance !== "string" || !instance.trim()))
      || (args.title !== undefined && typeof args.title !== "string")
      || (args.reply !== undefined && typeof args.reply !== "boolean")) throw new Error("Invalid message options.");
    const { chat, conversation, host } = await service.resolve(from);
    if (chat.agent !== agent.id) throw new Error("The sender belongs to a different agent.");
    const key = createHash("sha256").update(requestId).digest("hex");
    const id = `${namespace}:message:${from}:${key}`;
    const signature = createHash("sha256")
      .update(JSON.stringify([args.agent, instance ?? null, args.title ?? null, args.text, args.reply ?? false])).digest("hex");
    const prior = (await host.harness.snapshot(Requests, conversation.id, context))?.receipts[key];
    if (prior && prior.signature !== signature) throw new Error("Message request ID already has different content.");
    const recipient = instance
      ? (await service.resolve(instance)).chat
      : await service.create(args.agent, "agent", id, args.title ?? `Message from ${from}`);
    if (recipient.agent !== args.agent) throw new Error("The instance belongs to a different agent.");
    if (recipient.id === from && args.reply) throw new Error("Self-messages cannot request an automatic reply.");
    const taskId = await conversation.commit(async tx => {
      const requests = await tx.doc(Requests, conversation.id);
      const existing = requests.receipts[key];
      if (existing) {
        if (existing.signature !== signature) throw new Error("Message request ID already has different content.");
        return existing.task;
      }
      const message: Message = { id, from, to: recipient.id, text: args.text, reply: args.reply ?? false };
      const task = await tx.createTask(delivery, message, { ownership: { kind: "conversation" }, background: true });
      requests.receipts[key] = { task, signature };
      await tx.appendEntry(conversation.id, { kind, data: { ...message, status: "queued", taskId: task } });
      return task;
    }, context);
    host.harness.resume();
    return { messageId: id, from, to: recipient.id, taskId };
  }

  async function status(from: string, taskId: number, context: Context) {
    if (!Number.isSafeInteger(taskId) || taskId < 1) throw new Error("A message task ID is required.");
    const { host, conversation } = await service.resolve(from);
    const task = await host.harness.getTask(taskId as TaskId, context);
    if (!task || task.kind !== kind || task.conversationId !== conversation.id) throw new Error("Unknown message task.");
    return { taskId, message: task.input, state: task.state };
  }

  const extension = defineExtension({
    name: `${namespace}.instance-messages.${agent.id}`, tasks: [delivery],
    tools: [
      defineTool({
        name: "agent_instances",
        description: "Find your own instance ID and addressable independent instances. Returns identities, not their private transcripts.",
        parameters: Type.Object({}), replay: "safe",
        async execute(_args, api) {
          const self = `${agent.id}:${api.conversationId}`;
          await service.resolve(self);
          const instances = (await service.list()).filter(chat => allowed.includes(chat.agent))
            .map(({ id, agent, title, source }) => ({ id, agent, title, source }));
          return { output: [{ type: "text", text: JSON.stringify({ self, agents: allowed, instances }) }] };
        },
      }),
      defineTool({
        name: "message_agent",
        description: `Send an assignment or update to an independent instance. Allowed agents: ${allowed.join(", ")}. Supply instance to reuse an address from agent_instances, or omit it to create a new top-level instance. Returns durable admission immediately, not completion. reply=true returns the recipient's answer as a later input to you. Self-continuations must use your own instance and reply=false. Include scope and evidence; no history or permissions are inherited.`,
        parameters: Type.Object({
          agent: Type.String(),
          instance: Type.Optional(Type.String({ description: "Exact existing instance ID; omit or use an empty string to create a new independent instance." })),
          title: Type.Optional(Type.String()), text: Type.String({ minLength: 1 }),
          reply: Type.Optional(Type.Boolean()),
        }),
        replay: "safe",
        async execute(args, api, context) {
          const from = `${agent.id}:${api.conversationId}`;
          const details = await send(from, args, `tool:${api.taskId}`, context);
          return { output: [{ type: "text", text: JSON.stringify(details) }], details };
        },
      }),
      defineTool({
        name: "message_status",
        description: "Inspect a message task returned by message_agent when status is needed. Do not poll while awaiting an automatic reply.",
        parameters: Type.Object({ taskId: Type.Integer({ minimum: 1 }) }), replay: "safe",
        async execute({ taskId }, api, context) {
          const value = await status(`${agent.id}:${api.conversationId}`, taskId, context);
          return { output: [{ type: "text", text: JSON.stringify(value) }] };
        },
      }),
    ],
  });
  return { extension, send, status };
}

export function instanceMessagingExtension(namespace: string, agent: LoadedAgent, service: ChatService) {
  return createInstanceMessaging(namespace, agent, service).extension;
}
