import {
  defineDoc, defineExtension, defineTask, type JsonObject, type ToolExecutionApi, type TaskId,
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
  /** Settled means this assignment returned; it does not assert acceptance. */
  settled: boolean;
};

/** Observe separately hosted work without taking ownership of its execution. */
export function createWorkflowProgress(options: {
  namespace: string;
  observe(watch: WorkflowWatch, signal: AbortSignal): Promise<WorkflowObservation>;
  authorize(watch: WorkflowWatch): void | Promise<void>;
  sink?: ReplySink;
  observeEveryMs: number;
  progressEveryMs: number;
}) {
  if (!(options.observeEveryMs > 0 && options.progressEveryMs >= options.observeEveryMs))
    throw new Error("Workflow observation and progress intervals must be positive and ordered.");
  const Watches = defineDoc<{ runs: Record<string, { task: number; request: string }>; requests: Record<string, number> }>({
    kind: `${options.namespace}.workflow-watches`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ runs: {}, requests: {} }), checkpointWhen: () => false,
  });
  type State = { phase: "observe"; at: number; lastAt: number; cursor: string; sequence: number };
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
          observation = { cursor: "unavailable", summary: "Workflow status is unavailable. Waiting to reconnect; completion has not been verified.", settled: false };
        }
        await options.authorize(task.input);
        const now = runtime.now();
        const changed = observation.cursor !== state.cursor;
        const due = now - state.lastAt >= options.progressEveryMs;
        await runtime.commit(async tx => {
          // A follow-up admitted during observation invalidates that snapshot,
          // especially a previously quiet state. Observe the new assignment.
          if ((await tx.doc(Watches, runtime.conversationId)).runs[task.input.run].request !== request)
            return { status: "running", checkpoint: { ...state, at: now } };
          if (changed || due || observation.settled) {
            const text = !changed && !observation.settled
              ? `Still working. Latest recorded progress: ${observation.summary}` : observation.summary;
            await publishReply(tx, runtime.conversationId, task.input.author, text,
              `workflow:${task.id}:${state.sequence}`, options.sink, task.input.destination);
          }
          if (observation.settled) return { status: "terminal", outcome: { status: "completed", result: null } };
          return { status: "running", checkpoint: {
            phase: "observe", at: now + options.observeEveryMs,
            lastAt: changed || due ? now : state.lastAt, cursor: observation.cursor,
            sequence: state.sequence + (changed || due ? 1 : 0),
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
