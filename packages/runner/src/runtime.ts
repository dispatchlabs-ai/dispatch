export type OpenOptions = {
  agent: LoadedAgent;
  directory: string;
  /** Trusted local checkout. Tools run with the host user's filesystem access. */
  cwd?: string;
  models: Models;
  execution?: "live" | "demo";
  settings?: HarnessOptions["settings"];
  now?: () => number;
  onStatus?: (state: RunnerState) => void;
  /** Host adapters, shared by every conversation of this agent. */
  extensions?: Extension[];
  /** Available to domain-created conversations without granting root-agent tools. */
  registryExtensions?: Extension[];
  replySink?: ReplySink;
  updateDefinitions?: boolean;
  /** Return true after preserving or migrating an application-owned configuration. */
  updateConversation?: (tx: import("@earendil-works/pi-durable").Tx, id: ConversationId, setup: AgentSetup) => Promise<boolean>;
};

export type StatusFile = {
  agent: string; pid: number; hostRunning: boolean; updatedAt: string;
  conversationId: number; state: RunnerState;
};

import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry, configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness,
  type Conversation, type ConversationId, type Cursor, type Extension, type HarnessOptions, type Storage, type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import lockfile from "proper-lockfile";
import { nextDeadline, type LoadedAgent, type Trigger } from "./definition.js";
import { createConfiguration, type AgentSetup } from "./configuration.js";
import { createHandoffs } from "./handoff.js";
import { createCoding } from "./coding.js";
import type { ReplySink } from "./replies.js";
import { privateStateDirectory, privateStateFiles } from "./private-state.js";
import { reportError } from "./terminal-output.js";

const context = BACKGROUND_CONTEXT;
export type RunnerState = {
  fingerprint: string;
  execution: string;
  hostExtensions?: string[];
  cwd?: string | null;
  loopId: number | null;
  conversationId?: number;
  completed: number;
  phase: "idle" | "waiting" | "running" | "paused" | "done" | "failed" | "aborted";
  nextAt: number | null;
  last: { at: number; submissionId: number; answer: string } | null;
  error: string | null;
  pauseReason?: string | null;
};

export type StartOptions = { conversationId?: ConversationId; input?: string };

export function createRuntime(namespace: string, agentConfiguration: ReturnType<typeof createConfiguration>["agentConfiguration"], Handoffs: ReturnType<typeof createHandoffs>["Handoffs"], codingEnvironment: ReturnType<typeof createCoding>["codingEnvironment"]) {
  const RunnerDoc = defineDoc<RunnerState>({
    kind: `${namespace}.runner`, version: 1, scope: "session",
    checkpointWhen: () => false,
    initial: () => ({
      fingerprint: "", execution: "", loopId: null, completed: 0,
      phase: "idle", nextAt: null, last: null, error: null,
    }),
  });

  const LoopControl = defineDoc<{ reason: string | null }>({
    kind: `${namespace}.loop-control`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    checkpointWhen: () => false,
    initial: () => ({ reason: null }),
  });
  const pauseLoop = defineTool({
    name: "pause_loop",
    description: "Pause continuous work after your final response only when a missing decision or access prevents all useful progress, or the user asks you to stop. Explain the concrete blocker and needed input. A completed work pass is not a reason to pause.",
    parameters: Type.Object({ reason: Type.String({ minLength: 1 }) }),
    replay: "safe",
    async execute({ reason }, api, ctx) {
      const paused = await api.commit(async tx => {
        const state = await tx.doc(RunnerDoc);
        const task = state.loopId ? await tx.task(state.loopId as TaskId) : undefined;
        if (!task || task.state.status === "terminal" || task.conversationId !== api.conversationId) return false;
        (await tx.doc(LoopControl, api.conversationId)).reason = reason;
        return true;
      }, ctx);
      return { output: [{ type: "text", text: paused ? "The loop will pause after your final response. State what input is needed." : "This conversation has no active loop." }] };
    },
  });

  type LoopInput = { trigger: Trigger; input: string; initialInput?: string; once: boolean; firstAt: number };
  type Checkpoint =
    | { phase: "sleep"; iteration: number; at: number }
    | { phase: "run"; iteration: number; at: number };

  // Keep the existing checkpoint shape so suspended 1.3 work can resume.
  // A future deadline ends this phase asleep; re-entry continues when it is due.
  const AgentLoop = defineTask<LoopInput, Checkpoint, null>({
    name: `${namespace}.agent-loop`, version: 1,
    initial: (input) => ({ phase: "sleep", iteration: 0, at: input.firstAt }),
    phases: {
      async sleep(task, runtime, ctx) {
        const checkpoint = task.state.checkpoint;
        if (checkpoint.at > runtime.now()) {
          return runtime.sleepUntil(checkpoint.at, checkpoint, ctx);
        }
        await runtime.commit(async (tx) => {
          const state = await tx.doc(RunnerDoc);
          state.phase = "running";
          state.nextAt = null;
          return { status: "running", checkpoint: { ...checkpoint, phase: "run" } };
        }, ctx);
      },
      async run(task, runtime, ctx) {
        const checkpoint = task.state.checkpoint;
        const conversation = await runtime.conversation(runtime.conversationId, ctx);
        if (!conversation) throw new Error("Agent conversation disappeared.");
        // Replaying this phase after a crash retrieves the already-admitted input.
        const submission = await conversation.submit({
          type: "input", content: checkpoint.iteration === 0 ? task.input.initialInput ?? task.input.input : task.input.input,
          requestId: `loop:${task.id}:${checkpoint.iteration}`,
          whenBusy: "followUp",
        }, ctx);
        const settled = await submission.wait(ctx);
        if (settled.status !== "done" || settled.type !== "input") {
          const message = `Agent input did not complete: ${JSON.stringify(settled)}`;
          await runtime.commit(async (tx) => {
            const state = await tx.doc(RunnerDoc);
            state.phase = "failed";
            state.error = message;
            state.nextAt = null;
            return { status: "terminal", outcome: { status: "failed", error: { message } } };
          }, ctx);
          return;
        }
        const entry = await runtime.entry(AssistantEntry, settled.answer, ctx);
        const answer = entry?.model?.[0];
        if (!answer || answer.role !== "assistant") throw new Error("Completed input has no assistant answer.");
        const text = answer.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        const now = runtime.now();
        await runtime.commit(async (tx) => {
          const pauseReason = (await tx.doc(LoopControl, runtime.conversationId)).reason;
          const finished = task.input.once || !!pauseReason;
          const nextAt = finished ? null : nextDeadline(task.input.trigger, checkpoint.at, now);
          const state = await tx.doc(RunnerDoc);
          state.completed++;
          state.last = { at: now, submissionId: submission.id, answer: text };
          state.phase = pauseReason ? "paused" : task.input.once ? "done" : "waiting";
          state.pauseReason = pauseReason;
          state.nextAt = nextAt;
          state.error = null;
          return finished
            ? { status: "terminal", outcome: { status: "completed", result: null } }
            : { status: "running", checkpoint: { phase: "sleep", iteration: checkpoint.iteration + 1, at: nextAt! } };
        }, ctx);
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(async (tx) => {
        const state = await tx.doc(RunnerDoc);
        state.phase = "aborted";
        state.nextAt = null;
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx);
    },
  });

  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

  async function readStatus(directory: string): Promise<StatusFile | null> {
    try {
      return JSON.parse(await readFile(join(directory, "status.json"), "utf8")) as StatusFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function openAgent(options: OpenOptions): Promise<AgentHost> {
    const { agent, models } = options;
    const directory = resolve(options.directory);
    const cwd = options.cwd ? await realpath(resolve(options.cwd)) : undefined;
    const execution = options.execution ?? "live";
    const now = options.now ?? Date.now;
    await privateStateDirectory(directory);
    let compromised: Error | undefined;
    let harness: Harness | undefined;
    let storage: Storage | undefined;
    // Pi's SQLite storage is single-owner. This lock protects that contract,
    // and does not limit independent agents or their native task concurrency.
    const release = await lockfile.lock(directory, {
      lockfilePath: join(directory, ".owner.lock"),
      onCompromised(error) {
        compromised = error;
        void harness?.close(context);
      },
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ELOCKED") throw new Error(`${agent.id} already has a runner owning ${directory}.`);
      throw error;
    });
    let stopWatch: (() => Promise<void>) | undefined;
    let projection = Promise.resolve();
    let projectionError: unknown;
    let closing: Promise<void> | undefined;
    let root: Conversation;
    const project = (state: RunnerState, hostRunning: boolean) => {
      const snapshot: StatusFile = {
        agent: agent.id, pid: process.pid, hostRunning,
        updatedAt: new Date().toISOString(), conversationId: state.conversationId ?? root.id, state: copy(state),
      };
      projection = projection.then(async () => {
        const temp = join(directory, "status.json.tmp");
        await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
        await rename(temp, join(directory, "status.json"));
        options.onStatus?.(snapshot.state);
      }).catch((error: unknown) => {
        if (!projectionError) reportError(`[${agent.id}] Could not publish a status snapshot:`, error);
        projectionError = error;
      });
    };
    try {
      await privateStateFiles(directory);
      const registry = createRegistry();
      const loopExtension = defineExtension({ name: `${namespace}.runner`, tasks: [AgentLoop],
        tools: agent.trigger.mode === "continuous" ? [pauseLoop] : [], });
      const setup = await agentConfiguration(
        agent, directory, execution === "demo", [loopExtension, ...(options.extensions ?? [])], options.replySink, cwd,
      );
      const { configuration, installed } = setup;
      for (const extension of new Map([...installed, ...(options.registryExtensions ?? [])].map(extension => [extension.name, extension])).values()) registry.install(extension);
      storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
      harness = await Harness.open(storage, {
        models, registry, now, settings: options.settings,
        env: async (target, ctx) => await codingEnvironment(target, ctx) ??
          (cwd ? new NodeExecutionEnv({ cwd: target.cwd ?? cwd }) : undefined),
        onReport: (error) => reportError(`[${agent.id}] Pi Durable:`, error),
      }, context);
      root = await harness.root(context, {
        agent: configuration,
      });
      const existing = await harness.snapshot(RunnerDoc, context);
      if (existing?.fingerprint && (existing.cwd ?? null) !== (cwd ?? null)) {
        throw new Error("The saved agent belongs to a different working directory. Use the original --cwd or a separate --state-dir.");
      }
      const hostExtensions = [...(options.extensions ?? []), ...(options.registryExtensions ?? [])].map(extension => extension.name);
      const missing = existing?.hostExtensions?.filter(name => !hostExtensions.includes(name)) ?? [];
      if (missing.length) {
        throw new Error(`${agent.id}'s saved state requires ${missing.join(", ")}. Restart its chat server with the same adapters (serve --slack for Slack), then attach the CLI. Pending work has been preserved.`);
      }
      if (existing?.fingerprint && existing.execution !== execution) {
        throw new Error(`${agent.id}'s demo/live mode changed. Preserve this state and choose a new --state-dir.`);
      }
      if (existing?.fingerprint && existing.fingerprint !== agent.fingerprint) {
        if (!options.updateDefinitions) {
          throw new Error(`${agent.id}'s definition changed. Use --update-definitions when its saved work is idle, or choose a new --state-dir.`);
        }
        const inspection = await harness.inspect(context);
        if (inspection.tasks.length || inspection.submissions.length) {
          throw new Error(`${agent.id} has pending work. Finish or stop that work with its previous definition before updating.`);
        }
        await harness.commit(async tx => {
          let cursor: Cursor | undefined;
          const conversations = [];
          do {
            const page = await tx.scanConversations({}, 250, cursor);
            conversations.push(...page.items);
            cursor = page.next;
          } while (cursor);
          const update = async (id: ConversationId, next: AgentSetup) => {
            if (await options.updateConversation?.(tx, id, next)) return;
            await configure(tx, id, next.configuration);
            if (next.delegate) {
              const state = await tx.doc(Handoffs, id);
              if (state.child) await update(state.child as ConversationId, next.delegate);
            }
          };
          // Keep each private child's configured agent and complete history.
          for (const conversation of conversations) {
            if (!conversation.owner) await update(conversation.id, setup);
          }
        }, context);
      }
      await root.commit(async (tx) => {
        const state = await tx.doc(RunnerDoc);
        state.fingerprint = agent.fingerprint;
        state.execution = execution;
        state.cwd = cwd ?? null;
        state.hostExtensions = hostExtensions;
      }, context);
      const watch = await harness.watchDoc(RunnerDoc, context);
      if (!watch) throw new Error("Missing runner state.");
      stopWatch = async () => { await watch.stop(); };
      project(copy(watch.value!), true);
      watch.start(async (state) => { if (state) project(copy(state), true); });
      const activeHarness = harness;
      const state = async () => copy((await activeHarness.snapshot(RunnerDoc, context))!);
      const close = () => {
        closing ??= (async () => {
          let snapshot: RunnerState | undefined;
          try {
            try {
              await stopWatch?.();
              snapshot = await state();
            } finally {
              // close() suspends unfinished native work; it does not abort it.
              await activeHarness.close(context);
            }
            project(snapshot!, false);
            await projection;
            if (projectionError) throw projectionError;
          } finally {
            await release();
          }
        })();
        return closing;
      };
      return {
        harness: activeHarness, conversation: root, configuration, state, close,
        async start(once = false, options: StartOptions = {}): Promise<TaskId<null>> {
          if (compromised) throw compromised;
          if (!once && agent.trigger.mode === "manual") throw new Error(`${agent.id} is manual. Use run instead of start.`);
          const saved = await state();
          const conversation = options.conversationId
            ? await activeHarness.conversation(options.conversationId, context) : root;
          if (!conversation) throw new Error("The selected loop conversation is missing.");
          if (options.input !== undefined && !options.input.trim()) throw new Error("A loop goal must be nonempty.");
          const prior = saved.loopId ? await activeHarness.getTask(saved.loopId as TaskId<null>, context) : undefined;
          if (prior && prior.state.status !== "terminal") {
            if (prior.conversationId !== conversation.id) throw new Error(`${agent.id} already has a loop in another conversation.`);
            if (options.input !== undefined && options.input !== (prior.input as LoopInput).initialInput) {
              throw new Error("This loop already has a saved goal. Resume without a new prompt.");
            }
            if ((prior.input as LoopInput).once !== once) {
              throw new Error(`${agent.id} has unfinished ${((prior.input as LoopInput).once) ? "one-shot" : "continuous/scheduled"} work. Resume with the same command.`);
            }
            activeHarness.resume();
            return prior.id;
          }
          if (saved.phase === "paused" && !options.input) throw new Error(`Work is paused: ${saved.pauseReason}. Supply the missing input to resume.`);
          const initialInput = options.input ?? (prior?.conversationId === conversation.id
            ? (prior.input as LoopInput).initialInput : undefined);
          // A terminal failure needs an explicit new start/run. Reset the active
          // model context so a prior provider-error entry cannot poison the retry.
          if (prior?.state.status === "terminal" && prior.state.outcome.status !== "completed") {
            await conversation.reset(`Previous iteration failed. Assigned goal:\n${initialInput ?? agent.input}\n\nLast completed result:\n${saved.last?.answer ?? "(none)"}`, context);
          }
          const firstAt = now() + (!once && agent.trigger.mode === "interval" && agent.trigger.runImmediately === false ? agent.trigger.everyMs : 0);
          const id = await conversation.commit(async (tx) => {
            (await tx.doc(LoopControl, conversation.id)).reason = null;
            const id = await tx.createTask(AgentLoop, {
              trigger: agent.trigger, input: agent.input, ...(initialInput ? { initialInput } : {}), once, firstAt,
            }, { ownership: { kind: "conversation" }, background: true });
            const state = await tx.doc(RunnerDoc);
            state.loopId = id;
            state.conversationId = conversation.id;
            state.phase = "waiting";
            state.nextAt = firstAt;
            state.error = null;
            state.pauseReason = null;
            return id;
          }, context);
          activeHarness.resume();
          return id;
        },
        async wait(id: TaskId<null>) {
          const result = await activeHarness.waitForTask(id, context);
          if (compromised) throw compromised;
          if (result.state.outcome.status !== "completed") {
            throw new Error(`${agent.id} stopped: ${JSON.stringify(result.state.outcome)}`);
          }
          return state();
        },
      };
    } catch (error) {
      await stopWatch?.();
      try {
        if (harness) await harness.close(context);
        else await storage?.close(context);
      } finally { await release(); }
      throw error;
    }
  }



  return { RunnerDoc, openAgent, readStatus };
}

export type AgentHost = {
  harness: Awaited<ReturnType<typeof Harness.open>>;
  conversation: Conversation;
  configuration: AgentSetup["configuration"];
  state(): Promise<RunnerState>;
  close(): Promise<void>;
  start(once?: boolean, options?: StartOptions): Promise<TaskId<null>>;
  wait(id: TaskId<null>): Promise<RunnerState>;
};
