import { createHash } from "node:crypto";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  LiveDoc, configure, defineDoc, defineExtension, defineTask, defineTool,
  type AgentChange, type ConversationId,
} from "@earendil-works/pi-durable";
import { createProgress } from "./progress.js";
import { createReplies, type ReplyDestination, type ReplySink } from "./replies.js";

type Job = {
  taskId: number; question: string; status: "working" | "done" | "failed" | "stopped";
  submissionId?: number; destination?: ReplyDestination;
};
export function createHandoffs(namespace: string, Progress: ReturnType<typeof createProgress>["Progress"], publishReply: ReturnType<typeof createReplies>["publishReply"]) {
  const Handoffs = defineDoc<{
    child: number | null; monitor: number | null; jobs: Record<string, Job>;
    reported: number[]; summary: string; result: string;
  }>({
    kind: `${namespace}.handoffs`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ child: null, monitor: null, jobs: {}, reported: [], summary: "", result: "" }),
  });
  const textOf = (message?: AssistantMessage) =>
    message?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? "";

  function handoffExtension(options: {
    target: string; supervisorName: string; configuration: AgentChange; supervisor: AgentChange;
    progressEveryMs: number; sink?: ReplySink;
  }) {
    const { target, sink } = options;
    const anchor = defineTask<null, { phase: "done" }, null>({
      name: `${namespace}.handoff-anchor`, version: 1, initial: () => ({ phase: "done" }),
      phases: { done: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context) },
      abort: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
    const worker = defineTask<
      { child: number; call: string; question: string; mode: "followUp" | "steer" },
      { phase: "answer" }, null
    >({
      name: `${namespace}.handoff-worker`, version: 1, initial: () => ({ phase: "answer" }),
      phases: {
        async answer(task, runtime, context) {
          const child = await runtime.conversation(task.input.child as ConversationId, context);
          if (!child) throw new Error("Delegated conversation is missing.");
          const submission = await child.submit({
            type: "input", content: task.input.question, requestId: `handoff:${task.id}`,
            whenBusy: task.input.mode,
          }, context);
          await runtime.commit(async tx => {
            (await tx.doc(Handoffs, runtime.conversationId)).jobs[task.input.call].submissionId = submission.id;
            return undefined;
          }, context);
          const receipt = await submission.wait(context);
          const answer = receipt.status === "done" && receipt.type === "input"
            ? (await runtime.context(child.id, context, { at: receipt.answer }))
              .entries.find(entry => entry.id === receipt.answer)?.model?.[0] as AssistantMessage | undefined : undefined;
          await runtime.commit(async tx => {
            const state = await tx.doc(Handoffs, runtime.conversationId);
            const job = state.jobs[task.input.call];
            job.status = answer && textOf(answer) ? "done" :
              receipt.status === "unanswered" && receipt.reason === "aborted" ? "stopped" : "failed";
            const message = answer && textOf(answer) ? answer :
              job.status === "stopped" ? `${target}'s work was stopped.` :
                `${target} could not finish this request. ${receipt.status === "unanswered" ? receipt.reason : "No answer was returned."}`;
            // Steering can combine several inputs into one answer.
            const answerId = receipt.status === "done" && receipt.type === "input" ? receipt.answer : undefined;
            if (answerId === undefined || !state.reported.includes(answerId)) {
              await publishReply(tx, runtime.conversationId, target, message, `handoff-result:${task.id}`, sink, job.destination);
              if (answerId !== undefined) state.reported.push(answerId);
              state.result = typeof message === "string" ? message : textOf(message);
            }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
        },
      },
      async abort(task, runtime, context) {
        await runtime.commit(async tx => {
          (await tx.doc(Handoffs, runtime.conversationId)).jobs[task.input.call].status = "stopped";
          return { status: "terminal", outcome: { status: "aborted" } };
        }, context);
      },
    });

    type MonitorState = {
      phase: "check"; at: number; cycle: number; digest: string; narrator: number | null;
    } | {
      phase: "summarize"; cycle: number; digest: string; narrator: number; facts: string;
    };
    const monitor = defineTask<{ firstAt: number }, MonitorState, null>({
      name: `${namespace}.handoff-monitor`, version: 1,
      initial: input => ({ phase: "check", at: input.firstAt, cycle: 0, digest: "", narrator: null }),
      phases: {
        async check(task, runtime, context) {
          const checkpoint = task.state.checkpoint;
          await runtime.sleep(checkpoint.at, context);
          const state = await runtime.snapshot(Handoffs, runtime.conversationId, context);
          const jobs = Object.values(state?.jobs ?? {}).filter(job => job.status === "working");
          if (!jobs.length || !state?.child) {
            await runtime.commit(async tx => {
              (await tx.doc(Handoffs, runtime.conversationId)).monitor = null;
              return { status: "terminal", outcome: { status: "completed", result: null } };
            }, context);
            return;
          }
          const progress = await runtime.snapshot(Progress, state.child as ConversationId, context);
          const live = await runtime.snapshot(LiveDoc, state.child as ConversationId, context);
          // Only public progress and tool status; never model reasoning.
          const facts = JSON.stringify({
            requests: jobs.map(job => job.question),
            milestone: progress?.summary || null,
            tools: live?.tools?.filter(tool => tool.status !== "done").map(tool => tool.name) ?? [],
            working: !!live?.run,
            retry: live?.generation?.retry ? "The model request is retrying." : null,
          });
          const digest = createHash("sha256").update(facts).digest("hex");
          if (digest === checkpoint.digest || (!progress?.summary && !live?.tools?.length)) {
            await runtime.commit(() => ({
              status: "running", checkpoint: { ...checkpoint, at: runtime.now() + options.progressEveryMs },
            }), context);
            return;
          }
          await runtime.commit(async tx => {
            let narrator = checkpoint.narrator;
            if (narrator === null) {
              const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
              await configure(tx, conversation.id, options.supervisor);
              narrator = conversation.id;
            }
            return {
              status: "running", checkpoint: {
                phase: "summarize", cycle: checkpoint.cycle, digest, narrator,
                facts: `Previous update: ${state.summary || "(none)"}\nCurrent observed facts: ${facts}`,
              },
            };
          }, context);
        },
        async summarize(task, runtime, context) {
          const checkpoint = task.state.checkpoint;
          const narrator = await runtime.conversation(checkpoint.narrator as ConversationId, context);
          if (!narrator) throw new Error("Progress narrator is missing.");
          const receipt = await (await narrator.submit({
            type: "input", content: checkpoint.facts, requestId: `progress:${task.id}:${checkpoint.cycle}`,
          }, context)).wait(context);
          const answer = receipt.status === "done" && receipt.type === "input"
            ? (await runtime.context(narrator.id, context, { at: receipt.answer }))
              .entries.find(entry => entry.id === receipt.answer)?.model?.[0] as AssistantMessage | undefined : undefined;
          const text = textOf(answer).trim();
          await runtime.commit(async tx => {
            const state = await tx.doc(Handoffs, runtime.conversationId);
            const jobs = Object.values(state.jobs).filter(job => job.status === "working");
            if (jobs.length && answer && text && text !== "NO_UPDATE" && text !== state.summary) {
              await publishReply(tx, runtime.conversationId, options.supervisorName, answer, `progress:${task.id}:${checkpoint.cycle}`, sink, jobs.at(-1)?.destination);
              state.summary = text;
            }
            return {
              status: "running", checkpoint: {
                phase: "check", at: runtime.now() + options.progressEveryMs, cycle: checkpoint.cycle + 1,
                digest: checkpoint.digest, narrator: checkpoint.narrator,
              },
            };
          }, context);
        },
      },
      async abort(_task, runtime, context) {
        await runtime.commit(async tx => {
          (await tx.doc(Handoffs, runtime.conversationId)).monitor = null;
          return { status: "terminal", outcome: { status: "aborted" } };
        }, context);
      },
    });

    const ask = defineTool({
      name: `ask_${target}`,
      description: `Hand technical work to your private ${target} in this conversation. Say one brief acknowledgement before calling, then the handoff ends your turn immediately. Results and plain-English progress updates arrive automatically. Include the full question and relevant context. Use steer for a correction to work already underway, followUp for a new request.`,
      parameters: Type.Object({
        question: Type.String({ minLength: 1 }),
        mode: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")])),
      }),
      replay: "safe",
      async execute({ question, mode }, api, context) {
        const result = await api.commit(async tx => {
          const entries = await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 30);
          const latest = entries.items.find(entry => entry.kind === `${namespace}.message`);
          const data = latest?.data as { slack?: ReplyDestination } | undefined;
          const acknowledged = entries.items.some(entry => entry.model?.some(message =>
            message.role === "assistant"
            && message.content.some(part => part.type === "toolCall" && part.id === api.callId)
            && message.content.some(part => part.type === "text" && part.text.trim())));
          const state = await tx.doc(Handoffs, api.conversationId);
          const existing = state.jobs[String(api.taskId)];
          if (existing) return { child: state.child, taskId: existing.taskId, acknowledged };
          const background = { ownership: { kind: "conversation" }, background: true } as const;
          if (state.child === null) {
            const owner = await tx.createTask(anchor, null, background);
            const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
            await configure(tx, child.id, options.configuration);
            state.child = child.id;
          }
          const taskId = await tx.createTask(worker, {
            child: state.child, call: String(api.taskId), question, mode: mode ?? "followUp",
          }, background);
          state.jobs[String(api.taskId)] = {
            taskId, question, status: "working", ...(data?.slack ? { destination: data.slack } : {}),
          };
          if (state.monitor === null) {
            state.monitor = await tx.createTask(monitor, { firstAt: Date.now() + options.progressEveryMs }, background);
          }
          return { child: state.child, taskId, acknowledged };
        }, context);
        return {
          output: [{ type: "text", text: `${target} has the request and is working in the background. Respond to the user now with one brief acknowledgement. Do not wait, poll, or answer the technical question yourself.` }],
          details: { agent: target, conversationId: result.child, taskId: result.taskId },
          // Pi settles the input with the assistant entry that called this tool.
          // Skip a second model round when that entry already acknowledged it.
          ...(result.acknowledged ? { control: { terminate: true as const } } : {}),
        };
      },
    });
    const status = defineTool({
      name: `${target}_status`, description: `Check your conversation's private ${target} when the user asks about status.`,
      parameters: Type.Object({}), replay: "safe",
      async execute(_args, api, context) {
        const state = await api.snapshot(Handoffs, api.conversationId, context);
        const progress = state?.child ? await api.snapshot(Progress, state.child as ConversationId, context) : undefined;
        return { output: [{ type: "text", text: JSON.stringify({
          jobs: Object.values(state?.jobs ?? {}).map(job => ({ question: job.question, status: job.status })),
          progress: progress?.summary ?? null, lastResult: state?.result ?? null,
        }) }] };
      },
    });
    const stop = defineTool({
      name: `stop_${target}`, description: `Stop this conversation's private ${target} when the user asks to cancel.`,
      parameters: Type.Object({}), replay: "unsafe",
      async execute(_args, api, context) {
        const state = await api.snapshot(Handoffs, api.conversationId, context);
        if (state?.child) await (await api.conversation(state.child as ConversationId, context))?.abort(context, { background: true });
        return { output: [{ type: "text", text: `${target}'s current work is stopped.` }] };
      },
    });
    return defineExtension({ name: `${namespace}.handoff`, tasks: [anchor, worker, monitor], tools: [ask, status, stop] });
  }

  return { Handoffs, handoffExtension };
}
