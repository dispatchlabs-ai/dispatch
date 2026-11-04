import {
  defineDoc, defineExtension, defineTask, InboxDoc, type JsonObject, type ToolExecutionApi, type TaskId, type Tx, type ConversationId,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { createReplies, type ReplyDestination, type ReplySink } from "./replies.js";

export type WorkflowWatch = {
  run: string; author: string; origin: JsonObject; destination?: ReplyDestination;
};
export type WorkflowObservation = {
  /** A stable milestone identity, not a timestamp or partial model text. */
  cursor: string;
  summary: string;
  /** Latest committed public update per source. IDs survive retries and restart. */
  updates?: { source: string; id: string; text: string; at?: number }[];
  /** Current factual activity, independent of the last narrative milestone. */
  activity?: string;
  /** Complete returned evidence for the supervising agent, not a public verdict. */
  result?: string;
  /** Settled means this assignment returned; it does not assert acceptance. */
  settled: boolean;
};

/** Observe separately hosted work without taking ownership of its execution. */
export function createWorkflowProgress(options: {
  namespace: string;
  observe(watch: WorkflowWatch, signal: AbortSignal): Promise<WorkflowObservation>;
  authorize(watch: WorkflowWatch): void | Promise<void>;
  sink?: ReplySink;
  /** Replace one status message identified by key; never append a heartbeat. */
  statusSink?: ReplySink;
  /** Keep routine narration in one editable status instead of new replies. */
  narration?: "replies" | "status";
  /** Atomically queue a trusted native continuation when the assignment returns. */
  onSettled?(tx: Tx, conversationId: ConversationId, watch: WorkflowWatch,
    observation: WorkflowObservation, key: string): Promise<void>;
  observeEveryMs: number;
  progressEveryMs: number;
}) {
  if (!(options.observeEveryMs > 0 && options.progressEveryMs >= options.observeEveryMs))
    throw new Error("Workflow observation and progress intervals must be positive and ordered.");
  if (options.narration === "status" && !options.statusSink)
    throw new Error("Status narration requires an editable status sink.");
  const Watches = defineDoc<{ runs: Record<string, { task: number; request: string }>; requests: Record<string, number> }>({
    kind: `${options.namespace}.workflow-watches`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ runs: {}, requests: {} }), checkpointWhen: () => false,
  });
  type State = { phase: "observe"; at: number; lastAt: number; cursor: string; sequence: number;
    seen?: Record<string, string>; texts?: Record<string, string>; lastChangeAt?: number; request?: string; statusAt?: number };
  const { publishReply } = createReplies(options.namespace);
  const monitor = defineTask<WorkflowWatch, State, null>({
    name: `${options.namespace}.workflow-progress`, version: 1,
    initial: () => ({ phase: "observe", at: 0, lastAt: 0, cursor: "", sequence: 0 }),
    phases: {
      async observe(task, runtime, context) {
        const state = task.state.checkpoint;
        if (state.at > runtime.now()) return runtime.sleepUntil(state.at, state, context);
        await options.authorize(task.input);
        let request = "";
        await runtime.commit(async tx => { request = (await tx.doc(Watches, runtime.conversationId)).runs[task.input.run].request; }, context);
        let observation: WorkflowObservation;
        try { observation = await options.observe(task.input, runtime.signal); }
        catch (error) {
          runtime.signal.throwIfAborted();
          runtime.report(error instanceof Error ? error : new Error("Workflow observation failed."));
          observation = { cursor: "unavailable", summary: "Workflow status is unavailable. Waiting to reconnect; completion has not been verified.",
            activity: "Workflow status is unavailable. Waiting to reconnect; completion has not been verified.", settled: false };
        }
        await options.authorize(task.input);
        const now = runtime.now();
        const due = now - state.lastAt >= options.progressEveryMs;
        await runtime.commit(async tx => {
          // A follow-up admitted during observation invalidates that snapshot,
          // especially a previously quiet state. Observe the new assignment.
          if ((await tx.doc(Watches, runtime.conversationId)).runs[task.input.run].request !== request)
            return { status: "running", checkpoint: { ...state, at: now } };
          const inputPending = (await tx.doc(InboxDoc, runtime.conversationId)).items.some(item => item.mode !== "write");
          const updates = observation.updates ?? [{ source: "workflow", id: observation.summary, text: observation.summary }];
          // An older monitor already published its saved milestone. Seed its
          // cursors on upgrade rather than replaying it as new progress.
          const baseline = !state.seen && state.sequence > 0;
          const seen = { ...state.seen };
          const texts = { ...state.texts };
          const fresh = updates.filter(update => update.id !== seen[update.source] && update.text.trim() && update.text !== texts[update.source]);
          const reset = baseline || inputPending || (!!state.request && state.request !== request);
          const publish = !inputPending && (observation.settled || (!reset && fresh.length > 0 && (due || state.sequence === 0)));
          if (publish && options.narration !== "status" && !(observation.settled && options.onSettled)) {
            const text = observation.settled ? observation.summary : [...new Set(fresh.map(update => update.text))].join("\n\n");
            await publishReply(tx, runtime.conversationId, task.input.author, text,
              `workflow:${task.id}:${state.sequence}`, options.sink, task.input.destination);
          }
          if (publish || reset) for (const update of updates) { seen[update.source] = update.id; texts[update.source] = update.text; }
          const lastChangeAt = publish && fresh.length ? now : state.lastChangeAt ?? now;
          const statusDue = now - (state.statusAt ?? 0) >= options.progressEveryMs;
          if (options.statusSink && task.input.destination && (statusDue || publish || inputPending)) {
            const age = Math.max(0, Math.floor((now - lastChangeAt) / 60_000));
            const text = inputPending ? "Your update was received; waiting for the assistant to process it."
              : observation.settled || options.narration === "status" ? observation.summary
              : `${observation.activity ?? "The workflow is active."}${age ? ` No new progress report for ${age} minute${age === 1 ? "" : "s"}.` : ""}`;
            await options.statusSink(tx, runtime.conversationId, task.input.destination, text, `workflow-status:${task.input.run}`);
          }
          if (observation.settled && !inputPending) {
            await options.onSettled?.(tx, runtime.conversationId, task.input, observation,
              `workflow-result:${task.input.run}:${request}`);
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          return { status: "running", checkpoint: {
            phase: "observe", at: now + options.observeEveryMs,
            lastAt: publish ? now : state.lastAt, cursor: observation.cursor,
            sequence: state.sequence + (publish ? 1 : 0), seen, texts, lastChangeAt, request,
            statusAt: statusDue || publish || inputPending ? now : state.statusAt ?? 0,
          } };
        }, context);
      },
    },
    async abort(_task, runtime, context) {
      // Canceling observation does not imply that an external deployment stopped.
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  return {
    extension: defineExtension({ name: `${options.namespace}.workflow-progress`, tasks: [monitor] }),
    async watch(api: ToolExecutionApi, context: Context, request: string, input: WorkflowWatch) {
      await options.authorize(input);
      return api.commit(async tx => {
        const { runs, requests } = await tx.doc(Watches, api.conversationId);
        if (requests[request]) return requests[request];
        const previous = runs[input.run];
        if (previous) {
          const task = await tx.task(previous.task as TaskId);
          if (task && task.state.status !== "terminal") {
            previous.request = request;
            requests[request] = previous.task;
            return previous.task;
          }
        }
        const task = await tx.createTask(monitor, input, { ownership: { kind: "conversation" }, background: true });
        runs[input.run] = { task, request };
        requests[request] = task;
        return task;
      }, context);
    },
  };
}
