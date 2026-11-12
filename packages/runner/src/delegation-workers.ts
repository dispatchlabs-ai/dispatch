import { Type } from "typebox";
import { withCancel, type Context } from "@earendil-works/chord/context";
import {
  InboxDoc, configure, defineDoc, defineTask, defineTool,
  type AgentChange, type ConversationId, type ModelRef,
  type SubmissionId, type TaskId, type ToolExecutionApi, type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { delegationResult } from "./delegation-receipts.js";
import { recordRequestCancellation } from "./request-completion.js";

const WorkerCall = defineDoc<{ worker: number | null }>({
  kind: "dispatch.delegation-call", version: 1, scope: "task",
  checkpointWhen: () => false,
  initial: () => ({ worker: null }),
});
const WorkerState = defineDoc<{
  child: number; submission: SubmissionId | null; cancelled: boolean;
  correction: { requestId: string; content: string } | null;
}>({
  kind: "dispatch.delegation-worker", version: 1, scope: "task",
  checkpointWhen: () => false,
  initial: () => ({ child: 0, submission: null, cancelled: false, correction: null }),
});
type WorkerInput = {
  agent: string; task: string; sourceTool: number; startedAt: number;
  fingerprint?: string; model?: ModelRef; thinking: string;
};

export function createDelegationWorkers(owner: string) {
  /** A background ownership boundary lets the foreground tool yield without abandoning its child. */
  const DelegationWorker = defineTask<WorkerInput, { phase: "answer" }, ToolExecutionResult>({
    name: `dispatch.delegation.${owner}.worker`, version: 1, initial: () => ({ phase: "answer" }),
    phases: {
      async answer(task, runtime, context) {
        const state = await runtime.snapshot(WorkerState, task.id, context);
        const child = state && await runtime.conversation(state.child as ConversationId, context);
        if (!child) throw new Error("Delegated conversation is missing.");
        const initial = await child.submit({ type: "input", content: task.input.task,
          requestId: `delegate:${task.input.sourceTool}` }, context);
        await runtime.commit(async tx => {
          const current = await tx.doc(WorkerState, task.id);
          current.submission ??= initial.id;
          return undefined;
        }, context);
        while (true) {
          const correction = (await runtime.snapshot(WorkerState, task.id, context))?.correction;
          const pending = correction ? await child.submit({ type: "input", whenBusy: "steer", ...correction }, context) : initial;
          const submission = await pending.wait(context);
          await child.waitForIdle(context);
          const cancelled = (await runtime.snapshot(WorkerState, task.id, context))!.cancelled;
          const result = await delegationResult(runtime, child.id, submission, task.input, context, cancelled);
          let settled = false;
          await runtime.commit(async tx => {
            const current = await tx.doc(WorkerState, task.id);
            if (current.submission !== submission.id || current.cancelled !== cancelled) return undefined;
            settled = true;
            return { status: "terminal", outcome: { status: "completed", result } };
          }, context);
          if (settled) return;
        }
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  function settledResult(task: Awaited<ReturnType<ToolExecutionApi["getTask"]>>): ToolExecutionResult | undefined {
    if (!task || task.state.status !== "terminal") return undefined;
    const outcome = task.state.outcome;
    return outcome.status === "completed" ? outcome.result as ToolExecutionResult : {
      isError: true, output: [{ type: "text", text: `Delegated work ended ${outcome.status}; it was not completed.` }],
    };
  }

  async function waitForWorker(worker: TaskId, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
    const ready = settledResult(await api.getTask(worker, context));
    if (ready) return ready;
    const local = withCancel(context);
    const inbox = await api.watchDoc(InboxDoc, api.conversationId, local.context);
    if (!inbox) throw new Error("Parent inbox is missing.");
    let inputReady!: () => void;
    let inputFailed!: (error: unknown) => void;
    const input = new Promise<void>((resolve, reject) => { inputReady = resolve; inputFailed = reject; });
    const check = () => {
      if (inbox.value.items.some(item => item.mode !== "write")) inputReady();
    };
    inbox.start(async call => {
      if (call.kind === "failed") inputFailed(call.error);
      else check();
    });
    check();
    try {
      await Promise.race([
        api.waitForTask(worker, local.context), input,
        inbox.closed.then(end => { throw new Error(`Parent inbox watch ended: ${end.kind}`); }),
      ]);
      return await api.commit(async tx => {
        const result = settledResult(await tx.task(worker));
        if (result) return result;
        const state = await tx.doc(WorkerState, worker);
        return {
          output: [{ type: "text" as const, text: `New input is waiting. Child ${state.child} continues working; process the user's message now. Use steer_child for a correction or cancel_child when the user stops it. Keep the original request active and resume wait_for_child until its report is collected or its work is cancelled. A status question does not cancel the assignment; answer it briefly in commentary, then resume waiting. There is no automatic result notification.` }],
          details: { conversationId: state.child, workerTaskId: worker, state: "input_pending" },
        };
      }, context);
    } finally {
      local.cancel();
      await inbox.stop();
    }
  }

  async function runDelegationWorker(agent: string, task: string, configuration: AgentChange | undefined,
    api: ToolExecutionApi, context: Context, fingerprint?: string): Promise<ToolExecutionResult> {
    const parent = await api.agent(context);
    const cwd = configuration ? api.env?.cwd ?? parent.cwd : undefined;
    const worker = await api.commit(async tx => {
      const call = await tx.doc(WorkerCall, api.taskId);
      if (call.worker !== null) return call.worker as TaskId;
      const id = await tx.createTask(DelegationWorker, {
        agent, task, sourceTool: api.taskId, startedAt: api.now(), thinking: configuration?.thinkingLevel ?? parent.thinkingLevel,
        ...(configuration?.model ?? parent.model ? { model: configuration?.model ?? parent.model } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      }, { ownership: { kind: "conversation" }, background: true });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: id } });
      if (configuration) await configure(tx, child.id, { ...configuration, cwd });
      (await tx.doc(WorkerState, id)).child = child.id;
      call.worker = id;
      return id;
    }, context);
    const ready = settledResult(await api.getTask(worker, context));
    if (ready) return ready;
    const childId = await api.commit(async tx =>
      (await tx.scanConversations({ ownerTaskId: worker }, 1)).items[0]?.id, context);
    const child = childId && await api.conversation(childId, context);
    if (!child) throw new Error("Delegated conversation is missing.");
    // Admit the assignment before a queued parent correction can release this tool.
    const submission = await child.submit({ type: "input", content: task, requestId: `delegate:${api.taskId}` }, context);
    await api.commit(async tx => {
      if ((await tx.task(worker))?.state.status !== "terminal")
        (await tx.doc(WorkerState, worker)).submission ??= submission.id;
    }, context);
    await api.details({ agent, conversationId: child.id, workerTaskId: worker }, context);
    return waitForWorker(worker, api, context);
  }

  async function ownedWorker(childId: number, api: ToolExecutionApi, context: Context) {
    const worker = await api.commit(async tx => {
      const child = await tx.conversation(childId as ConversationId);
      const owner = child?.owner;
      const task = owner && await tx.task(owner.taskId);
      if (owner?.conversationId !== api.conversationId || task?.kind !== DelegationWorker.definition.name)
        throw new Error("This is not a child delegated by this conversation.");
      return task.id;
    }, context);
    const child = await api.conversation(childId as ConversationId, context);
    if (!child) throw new Error("Delegated conversation is missing.");
    return { worker, child };
  }

  const childParameter = Type.Integer({ minimum: 1, description: "Native child conversationId returned by delegate or clone_agent." });
  const delegationWorkerTools = [
    defineTool({
      name: "wait_for_child",
      description: "Resume waiting for your delegated child without polling or starting another assignment. New user input releases the wait; it does not stop the child. Completion is a worker report, not acceptance of its work.",
      parameters: Type.Object({ conversationId: childParameter }), replay: "safe",
      async execute({ conversationId }, api, context) {
        const { worker } = await ownedWorker(conversationId, api, context);
        return waitForWorker(worker, api, context);
      },
    }),
    defineTool({
      name: "steer_child",
      description: "Send a correction or additional context to your still-running delegated child. It reaches the child at its next native boundary. Admission does not prove the correction was applied. Wait for its final report; do not poll.",
      parameters: Type.Object({ conversationId: childParameter, message: Type.String({ minLength: 1 }) }), replay: "safe",
      async execute({ conversationId, message }, api, context) {
        const { worker, child } = await ownedWorker(conversationId, api, context);
        const submissionId = await api.commit(async tx => {
          const existing = await tx.submissionByRequest(child.id, `delegate-steer:${api.taskId}`);
          if (existing) return existing.id;
          const task = await tx.task(worker);
          if (task?.state.status === "terminal") throw new Error("This child has ended; delegate a new assignment.");
          const state = await tx.doc(WorkerState, worker);
          if (state.cancelled) throw new Error("This child has been cancelled; delegate a new assignment.");
          const id = await child.submit(tx, { type: "input", content: message, whenBusy: "steer", requestId: `delegate-steer:${api.taskId}` });
          state.submission = id;
          state.correction = { requestId: `delegate-steer:${api.taskId}`, content: message };
          return id;
        }, context);
        return { output: [{ type: "text", text: `Correction admitted to child ${conversationId} as submission ${submissionId}.` }] };
      },
    }),
    defineTool({
      name: "cancel_child",
      description: "Cancel your delegated child's work and its owned descendants when the user stops or replaces the assignment. Waits for native cancellation to drain; returns only after its work has stopped. Does not cancel sibling children.",
      parameters: Type.Object({ conversationId: childParameter }), replay: "safe",
      async execute({ conversationId }, api, context) {
        const { worker, child } = await ownedWorker(conversationId, api, context);
        await api.commit(async tx => {
          if ((await tx.task(worker))?.state.status !== "terminal")
            (await tx.doc(WorkerState, worker)).cancelled = true;
        }, context);
        await recordRequestCancellation(api, child.id, context);
        await child.abort(context, { background: true });
        await recordRequestCancellation(api, child.id, context);
        await api.waitForTask(worker, context);
        return { output: [{ type: "text", text: `Child ${conversationId} and its owned work have stopped. Remaining work was not completed.` }] };
      },
    }),
  ];
  return { task: DelegationWorker, tools: delegationWorkerTools, run: runDelegationWorker };
}
