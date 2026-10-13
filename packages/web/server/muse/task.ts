import { createHash, randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { assertNativeEvaluation, EvaluationBindingDoc, nativeEvaluationPreparation, prepareNativeEvaluation, type NativeEvaluationPreparation } from "../evaluation-bindings.js";
import {
  defineDoc, defineExtension, defineTask,
  type ConversationId, type TaskId, type TaskRuntime, type Tx,
} from "@earendil-works/pi-durable";

export type MusePrompt = Array<
  { type: "text"; text: string } | { type: "image"; mediaType: string; base64Data: string }
>;
export type MuseReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type MuseRunInput = {
  roomId: ConversationId;
  participantId: string;
  messageId: string;
  epoch: number;
  prompt: MusePrompt;
  previous?: TaskId<MuseRunResult>;
};
/** Execution content only. Native authentication and transient MCP credentials are never checkpointed. */
export type MusePreparedRun = {
  prompt: MusePrompt;
  systemPrompt: string;
  cwd: string;
  /** Eval-only: native Muse must run rooted here so its shell resolves relative paths like the bridged tools do. Absent keeps the isolated session workspace. */
  nativeWorkspace?: string;
  /** Present only for a committed eval binding; checked again before every native invocation. */
  evaluation?: NativeEvaluationPreparation;
  model: string;
  reasoningEffort: MuseReasoningEffort;
  /** Native authorization configuration; absent on checkpoints saved before policy versioning. */
  transportPolicyRevision?: number;
  /** Trusted runner owner resolved by Dispatch, not a model-supplied identity. */
  userId: string;
};
export type MuseRunResult = {
  sessionId: string;
  text: string;
  success: boolean;
  /** Fixed, public-safe diagnostic from the transport; never raw native stderr. */
  error?: string;
};
export type MuseInvocation = {
  sessionId: string;
  resume: boolean;
  /** Separate handles: session/start or session/resume must not reuse turn/start's command identity. */
  sessionCommandId: string;
  commandId: string;
};
export type MuseCheckpoint =
  | { phase: "prepare"; round: number }
  | { phase: "execute"; round: number; prepared: MusePreparedRun; invocation: MuseInvocation }
  | { phase: "recover"; round: number; prepared: MusePreparedRun; invocation: MuseInvocation }
  | { phase: "settle"; round: number; prepared: MusePreparedRun; result: MuseRunResult };
export type MuseTaskRuntime = TaskRuntime<MuseRunInput, MuseCheckpoint, MuseRunResult, object>;
export type MuseRunScope = {
  input: MuseRunInput;
  runtime: MuseTaskRuntime;
  context: Context;
  /** Stable across repeated settlement; a committed review continuation gets a new round. */
  operationId: string;
  round: number;
};
export type MuseTaskHost = {
  /** Reauthorize and resolve the adopted configuration, without starting native execution. */
  prepare(scope: MuseRunScope): Promise<MusePreparedRun>;
  /**
   * Reauthorize the saved owner, reconstruct invocation-bound tools, and run Muse under runtime.signal.
   * Reject absent/stale transportPolicyRevision before external execution, including saved review continuations.
   * MUST join subprocess/bridge cleanup before returning or throwing, including on cancellation.
   * Only selected activity is persisted; native prose/thinking is not automatically public history.
   */
  execute(scope: MuseRunScope, prepared: MusePreparedRun, invocation: MuseInvocation): Promise<MuseRunResult | undefined>;
  /** Replay-safe under operationId; applies Dispatch contribution review and publication authorization. */
  settle(scope: MuseRunScope, result: MuseRunResult): Promise<{ prompt: MusePrompt } | void>;
};
type SessionState = {
  sessionId?: string;
  configuration?: string;
  lastTask?: TaskId<MuseRunResult>;
  requests: Record<string, { fingerprint: string; taskId: TaskId<MuseRunResult> }>;
};
export const MuseSessionDoc = defineDoc<SessionState>({
  kind: "dispatch.muse-session", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ requests: {} }),
});
const uncertainty = "Muse Code execution was interrupted before its result was saved. Its external effects are uncertain; inspect the workspace and native session before retrying.";

/** Pi owns durable scheduling/recovery; Muse owns inference and its internal agent loop. */
export function createMuseTask(host: MuseTaskHost) {
  const task = defineTask<MuseRunInput, MuseCheckpoint, MuseRunResult>({
    name: "dispatch.muse-run", version: 1,
    initial: () => ({ phase: "prepare", round: 0 }),
    phases: {
      prepare: async (record, runtime, context) => {
        if (record.input.previous) await runtime.waitForTask(record.input.previous, context);
        const scope = scopeFor(record.input, runtime, context, record.state.checkpoint.round);
        const prepared = await host.prepare(scope);
        const binding = await runtime.snapshot(EvaluationBindingDoc, runtime.conversationId, context);
        const agent = binding?.binding ? await runtime.agent(context) : undefined;
        await runtime.commit(async tx => {
          const binding = await prepareNativeEvaluation(tx, runtime.conversationId, scope.input, "muse-code", prepared, agent);
          if (binding) {
            prepared.evaluation = nativeEvaluationPreparation(binding, prepared.systemPrompt);
            prepared.nativeWorkspace = binding.fixture.effectivePath;
          } else if (prepared.nativeWorkspace !== undefined) {
            throw new Error("Native eval workspace requires a committed evaluation binding.");
          }
          const session = await tx.doc(MuseSessionDoc, runtime.conversationId);
          // A native transcript cannot silently carry another owner's or an obsolete instruction snapshot.
          const resume = Boolean(session.sessionId && session.configuration === configurationKey(prepared));
          const sessionId = resume ? session.sessionId! : museCommandId(runtime.now());
          return { status: "running", checkpoint: { phase: "execute", round: scope.round, prepared,
            invocation: invocationFor(sessionId, resume, runtime.now()) } };
        }, context);
      },
      execute: async (record, runtime, context) => {
        const { prepared, invocation, round } = record.state.checkpoint;
        const scope = scopeFor(record.input, runtime, context, round);
        const agent = prepared.evaluation ? await runtime.agent(context) : undefined;
        // Commit intent before external work. A reopened invocation stops at recover, never resends.
        await runtime.commit(async tx => {
          await assertNativeEvaluation(tx, runtime.conversationId, scope.input, "muse-code", prepared, agent);
          if (prepared.evaluation ? prepared.nativeWorkspace !== prepared.cwd : prepared.nativeWorkspace !== undefined)
            throw new Error("Native evaluation workspace does not match the admitted preparation.");
          delete (await tx.doc(MuseSessionDoc, runtime.conversationId)).sessionId;
          return { status: "running", checkpoint: { phase: "recover", round, prepared, invocation } };
        }, context);
        let result: MuseRunResult | undefined;
        try {
          runtime.signal.throwIfAborted();
          result = await host.execute(scope, prepared, invocation);
        } catch {
          // Unknown transport errors can contain private native content; expose uncertainty instead.
          runtime.signal.throwIfAborted();
        }
        runtime.signal.throwIfAborted();
        if (!result || result.sessionId !== invocation.sessionId) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: uncertainty } } }), context);
          return;
        }
        // execute has joined its native process before we advertise a recoverable completed result.
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "settle", round, prepared, result } }), context);
      },
      recover: async (_record, runtime, context) => {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: uncertainty } } }), context);
      },
      settle: async (record, runtime, context) => {
        const { result, prepared, round } = record.state.checkpoint;
        if (!result.success) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: result.error ?? "Muse Code failed." } } }), context);
          return;
        }
        const continuation = await host.settle(scopeFor(record.input, runtime, context, round), result);
        await runtime.commit(async tx => {
          const session = await tx.doc(MuseSessionDoc, runtime.conversationId);
          if (continuation) {
            // Do not expose a resumable session until the entire reviewed contribution has settled.
            return { status: "running", checkpoint: { phase: "execute", round: round + 1,
              prepared: { ...prepared, prompt: continuation.prompt },
              invocation: invocationFor(result.sessionId, true, runtime.now()) } };
          }
          session.sessionId = result.sessionId;
          session.configuration = configurationKey(prepared);
          return { status: "terminal", outcome: { status: "completed", result } };
        }, context);
      },
    },
    // Pi joins the signalled invocation and its owned work before invoking this abort handler.
    abort: (_record, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  return {
    task,
    extension: defineExtension({ name: "dispatch-muse", tasks: [task] }),
    /** Admit atomically with delivery; join the returned durable receipt before message coalescing. */
    async admit(tx: Tx, conversationId: ConversationId, requestId: string, input: Omit<MuseRunInput, "previous">) {
      const session = await tx.doc(MuseSessionDoc, conversationId);
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const prior = session.requests[requestId];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("Muse execution request ID already identifies different work.");
        return prior.taskId;
      }
      const taskId = await tx.createTask(task, { ...input, ...(session.lastTask ? { previous: session.lastTask } : {}) },
        { conversationId, ownership: { kind: "conversation" } });
      session.requests[requestId] = { fingerprint, taskId };
      session.lastTask = taskId;
      return taskId;
    },
  };
}
function scopeFor(input: MuseRunInput, runtime: MuseTaskRuntime, context: Context, round: number): MuseRunScope {
  return { input, runtime, context, operationId: `${runtime.taskId}:${round}`, round };
}
function configurationKey(prepared: MusePreparedRun) {
  // Absent nativeWorkspace must hash exactly as before it existed, or ordinary sessions stop resuming.
  const identity = [
    prepared.userId, prepared.cwd, prepared.systemPrompt, prepared.model, prepared.reasoningEffort,
    prepared.transportPolicyRevision ?? 0,
  ];
  if (prepared.nativeWorkspace !== undefined) identity.push(prepared.nativeWorkspace);
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
function invocationFor(sessionId: string, resume: boolean, now: number): MuseInvocation {
  return { sessionId, resume, sessionCommandId: museCommandId(now), commandId: museCommandId(now) };
}
/** MSP command handles require UUIDv7, not Node's UUIDv4 randomUUID(). No monotonic ordering is assumed. */
export function museCommandId(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
