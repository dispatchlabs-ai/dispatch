import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  defineDoc, defineExtension, defineTask,
  type ConversationId, type TaskId, type TaskRuntime, type Tx,
} from "@earendil-works/pi-durable";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { runClaudeQuery } from "./transport.js";
import type { ClaudeThinkingOptions } from "./thinking.js";

export type ClaudePrompt = SDKUserMessage["message"]["content"];
export type ClaudeRunInput = {
  roomId: ConversationId;
  participantId: string;
  messageId: string;
  epoch: number;
  prompt: ClaudePrompt;
  previous?: TaskId<ClaudeRunResult>;
};
/** Only execution content belongs in durable state. Authentication stays with the official binary. */
export type ClaudePreparedRun = ClaudeThinkingOptions & {
  prompt: ClaudePrompt;
  systemPrompt: string;
  cwd: string;
  model: string;
  /** Trusted host binding, not a user ID supplied by the model. */
  userId: string;
};
export type ClaudeRunResult = {
  sessionId: string;
  text: string;
  success: boolean;
  error?: string;
};
export type ClaudeCheckpoint =
  | { phase: "prepare"; round: number }
  | { phase: "execute"; round: number; prepared: ClaudePreparedRun; sessionId: string; resume: boolean }
  | { phase: "recover"; round: number; prepared: ClaudePreparedRun; sessionId: string }
  | { phase: "settle"; round: number; prepared: ClaudePreparedRun; result: ClaudeRunResult };
export type ClaudeTaskRuntime = TaskRuntime<ClaudeRunInput, ClaudeCheckpoint, ClaudeRunResult, object>;
export type ClaudeRunScope = {
  input: ClaudeRunInput;
  runtime: ClaudeTaskRuntime;
  context: Context;
  /** Stable across restart/repeated settlement; changes only for a committed continuation. */
  operationId: string;
  round: number;
};
export type ClaudeRuntimeOptions = Pick<Options,
  "mcpServers" | "hooks" | "canUseTool" | "tools" | "allowedTools" | "disallowedTools" |
  "env" | "pathToClaudeCodeExecutable"
>;
export type ClaudeTaskHost = {
  /** Reauthorize and resolve the adopted configuration before the initial intent commit. */
  prepare(scope: ClaudeRunScope): Promise<ClaudePreparedRun>;
  /** Reconstruct invocation-bound tools/permissions. Never return credentials for Pi's model provider. */
  options(scope: ClaudeRunScope, prepared: ClaudePreparedRun): Promise<ClaudeRuntimeOptions>;
  /** Persist only explicitly selected activity; raw SDK events are not a public transcript. */
  observe?(scope: ClaudeRunScope, message: SDKMessage): Promise<void>;
  /**
   * Admit a completed final through Dispatch's contribution machinery. Must be replay-safe under operationId.
   * Return a prompt only when contribution review requires another round. Failed results are never published here.
   */
  settle(scope: ClaudeRunScope, result: ClaudeRunResult): Promise<{ prompt: ClaudePrompt } | void>;
};
type SessionState = {
  sessionId?: string;
  cwd?: string;
  userId?: string;
  lastTask?: TaskId<ClaudeRunResult>;
  requests: Record<string, { fingerprint: string; taskId: TaskId<ClaudeRunResult> }>;
};
export const ClaudeSessionDoc = defineDoc<SessionState>({
  kind: "dispatch.claude-sdk-session", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ requests: {} }),
});
const uncertainty = "Claude Code execution was interrupted before its result was saved. Its external effects are uncertain; inspect the workspace and the native session before retrying.";

/** Stock Pi owns scheduling, checkpoints and cancellation; the official SDK owns its internal agent loop. */
export function createClaudeSdkTask(host: ClaudeTaskHost) {
  const task = defineTask<ClaudeRunInput, ClaudeCheckpoint, ClaudeRunResult>({
    name: "dispatch.claude-sdk-run", version: 1,
    initial: () => ({ phase: "prepare", round: 0 }),
    phases: {
      prepare: async (record, runtime, context) => {
        if (record.input.previous) await runtime.waitForTask(record.input.previous, context);
        const scope = scopeFor(record.input, runtime, context, record.state.checkpoint.round);
        const prepared = await host.prepare(scope);
        await runtime.commit(async tx => {
          const session = await tx.doc(ClaudeSessionDoc, runtime.conversationId);
          // A different authenticated owner or working directory never inherits another execution's session.
          const resume = Boolean(session.sessionId && session.userId === prepared.userId && session.cwd === prepared.cwd);
          const sessionId = resume ? session.sessionId! : randomUUID();
          return { status: "running", checkpoint: { phase: "execute", round: scope.round, prepared, sessionId, resume } };
        }, context);
      },
      execute: async (record, runtime, context) => {
        const { prepared, sessionId, resume, round } = record.state.checkpoint;
        const scope = scopeFor(record.input, runtime, context, round);
        const options = await host.options(scope, prepared);
        // Save intent BEFORE external execution. Only this invocation continues below; after restart the
        // recover handler refuses to resend an uncertain prompt, just like a non-replay-safe Pi tool.
        await runtime.commit(async tx => {
          // A failed/aborted execution must not silently resume a transcript that may contain unfinished
          // external actions on the next delivery. The task checkpoint retains its session for inspection.
          delete (await tx.doc(ClaudeSessionDoc, runtime.conversationId)).sessionId;
          return { status: "running", checkpoint: { phase: "recover", round, prepared, sessionId } };
        }, context);
        const result = await runClaudeQuery({ prepared, sessionId, resume, options, signal: runtime.signal,
          observe: message => host.observe?.(scope, message) ?? Promise.resolve(),
          result: async result => {
            await runtime.commit(() => ({ status: "running", checkpoint: { phase: "settle", round, prepared, result } }), context);
          },
        });
        if (!result) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: uncertainty } } }), context);
        }
      },
      recover: async (_record, runtime, context) => {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: uncertainty } } }), context);
      },
      settle: async (record, runtime, context) => {
        const { result, prepared, round } = record.state.checkpoint;
        if (!result.success) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: result.error ?? "Claude Code failed." } } }), context);
          return;
        }
        const continuation = await host.settle(scopeFor(record.input, runtime, context, round), result);
        await runtime.commit(async tx => {
          const session = await tx.doc(ClaudeSessionDoc, runtime.conversationId);
          session.sessionId = result.sessionId; session.cwd = prepared.cwd; session.userId = prepared.userId;
          if (continuation) {
            return { status: "running", checkpoint: { phase: "execute", round: round + 1,
              prepared: { ...prepared, prompt: continuation.prompt }, sessionId: result.sessionId, resume: true } };
          }
          return { status: "terminal", outcome: { status: "completed", result } };
        }, context);
      },
    },
    // Pi joins the signalled invocation (including its subprocess finally cleanup) before invoking abort.
    abort: (_record, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  return {
    task,
    extension: defineExtension({ name: "dispatch-claude-sdk", tasks: [task] }),
    /** Call in the same native commit that admits the delivery; join this receipt before message coalescing. */
    async admit(tx: Tx, conversationId: ConversationId, requestId: string, input: Omit<ClaudeRunInput, "previous">) {
      const session = await tx.doc(ClaudeSessionDoc, conversationId);
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const prior = session.requests[requestId];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("Claude execution request ID already identifies different work.");
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
function scopeFor(input: ClaudeRunInput, runtime: ClaudeTaskRuntime, context: Context, round: number): ClaudeRunScope {
  return { input, runtime, context, operationId: `${runtime.taskId}:${round}`, round };
}
