export type OpenOptions = {
  agent: LoadedAgent;
  directory: string;
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

import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry, configure, createRegistry, defineDoc, defineExtension, defineTask, Harness,
  type Conversation, type ConversationId, type Cursor, type Extension, type HarnessOptions, type Storage, type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
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
  loopId: number | null;
  completed: number;
  phase: "idle" | "waiting" | "running" | "done" | "failed" | "aborted";
  nextAt: number | null;
  last: { at: number; submissionId: number; answer: string } | null;
  error: string | null;
};

export function createRuntime(namespace: string, agentConfiguration: ReturnType<typeof createConfiguration>["agentConfiguration"], Handoffs: ReturnType<typeof createHandoffs>["Handoffs"], codingEnvironment: ReturnType<typeof createCoding>["codingEnvironment"]) {
  const RunnerDoc = defineDoc<RunnerState>({
    kind: `${namespace}.runner`, version: 1, scope: "session",
    initial: () => ({
      fingerprint: "", execution: "", loopId: null, completed: 0,
      phase: "idle", nextAt: null, last: null, error: null,
    }),
  });

  type LoopInput = { trigger: Trigger; input: string; once: boolean; firstAt: number };
  type Checkpoint =
    | { phase: "sleep"; iteration: number; at: number }
    | { phase: "run"; iteration: number; at: number };

  // Use the published 1.3.0 API: sleep() itself is an in-memory wait, so its
  // absolute deadline is in the committed checkpoint before the wait begins.
  const AgentLoop = defineTask<LoopInput, Checkpoint, null>({
    name: `${namespace}.agent-loop`, version: 1,
    initial: (input) => ({ phase: "sleep", iteration: 0, at: input.firstAt }),
    phases: {
      async sleep(task, runtime, ctx) {
        const checkpoint = task.state.checkpoint;
        await runtime.sleep(checkpoint.at, ctx);
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
          type: "input", content: task.input.input,
          requestId: `loop:${task.id}:${checkpoint.iteration}`,
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
        const nextAt = task.input.once ? null : nextDeadline(task.input.trigger, checkpoint.at, now);
        await runtime.commit(async (tx) => {
          const state = await tx.doc(RunnerDoc);
          state.completed++;
          state.last = { at: now, submissionId: submission.id, answer: text };
          state.phase = task.input.once ? "done" : "waiting";
          state.nextAt = nextAt;
          state.error = null;
          return task.input.once
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
        updatedAt: new Date().toISOString(), conversationId: root.id, state: copy(state),
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
      const loopExtension = defineExtension({ name: `${namespace}.runner`, tasks: [AgentLoop] });
      const setup = await agentConfiguration(
        agent, directory, execution === "demo", [loopExtension, ...(options.extensions ?? [])], options.replySink,
      );
      const { configuration, installed } = setup;
      for (const extension of new Map([...installed, ...(options.registryExtensions ?? [])].map(extension => [extension.name, extension])).values()) registry.install(extension);
      storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
      harness = await Harness.open(storage, {
        models, registry, now, settings: options.settings, env: codingEnvironment,
        onReport: (error) => reportError(`[${agent.id}] Pi Durable:`, error),
      }, context);
      root = await harness.root(context, {
        agent: configuration,
      });
      const existing = await harness.snapshot(RunnerDoc, context);
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
        async start(once = false): Promise<TaskId<null>> {
          if (compromised) throw compromised;
          if (!once && agent.trigger.mode === "manual") throw new Error(`${agent.id} is manual. Use run instead of start.`);
          const saved = await state();
          const prior = saved.loopId ? await activeHarness.getTask(saved.loopId as TaskId<null>, context) : undefined;
          if (prior && prior.state.status !== "terminal") {
            if ((prior.input as LoopInput).once !== once) {
              throw new Error(`${agent.id} has unfinished ${((prior.input as LoopInput).once) ? "one-shot" : "continuous/scheduled"} work. Resume with the same command.`);
            }
            activeHarness.resume();
            return prior.id;
          }
          // A terminal failure needs an explicit new start/run. Reset the active
          // model context so a prior provider-error entry cannot poison the retry.
          if (prior?.state.status === "terminal" && prior.state.outcome.status !== "completed") {
            await root.reset(`Previous iteration failed. Last completed result:\n${saved.last?.answer ?? "(none)"}`, context);
          }
          const firstAt = now() + (!once && agent.trigger.mode === "interval" && agent.trigger.runImmediately === false ? agent.trigger.everyMs : 0);
          const id = await root.commit(async (tx) => {
            const id = await tx.createTask(AgentLoop, {
              trigger: agent.trigger, input: agent.input, once, firstAt,
            }, { ownership: { kind: "conversation" }, background: true });
            const state = await tx.doc(RunnerDoc);
            state.loopId = id;
            state.phase = "waiting";
            state.nextAt = firstAt;
            state.error = null;
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
  start(once?: boolean): Promise<TaskId<null>>;
  wait(id: TaskId<null>): Promise<RunnerState>;
};
