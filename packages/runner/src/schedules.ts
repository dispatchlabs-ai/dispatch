import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTask, type TaskId } from "@earendil-works/pi-durable";
import type { LoadedAgent } from "./definition.js";
import type { AgentHost } from "./runtime.js";
import type { ChatService } from "./chat.js";

type ScheduleTiming = {
  id: string;
  cron: string;
  timezone: string;
  /** Offline occurrences: discard old minutes, or admit only the latest one. */
  missed: "skip" | "latest";
  /** Optional exclusive, absolute expiry, including Z or an explicit offset. */
  endAt?: string;
};

export type PromptSchedule = ScheduleTiming & {
  instance: { mode: "new" } | { mode: "existing"; id: string };
  input: string;
};
export type ProgramSchedule = ScheduleTiming & {
  /** Executable and literal arguments, run in the agent's execution environment. */
  command: string[];
};
export type AgentSchedule = PromptSchedule | ProgramSchedule;

const context = BACKGROUND_CONTEXT;
export const scheduleTaskKind = (namespace: string) => `${namespace}.calendar-schedule`;
const parse = (schedule: AgentSchedule, at: number) =>
  CronExpressionParser.parse(schedule.cron, { currentDate: at, tz: schedule.timezone, hashSeed: schedule.id });

export function nextScheduleAt(schedule: AgentSchedule, after: number): number | null {
  if (schedule.endAt && after >= Date.parse(schedule.endAt)) return null;
  const next = parse(schedule, after).next().getTime();
  return schedule.endAt && next >= Date.parse(schedule.endAt) ? null : next;
}

export function validateSchedules(schedules: AgentSchedule[] | undefined): void {
  if (schedules === undefined) return;
  if (!Array.isArray(schedules)) throw new Error("schedules must be a list.");
  const ids = new Set<string>();
  for (const schedule of schedules) {
    if (!schedule || typeof schedule.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(schedule.id) || ids.has(schedule.id)) {
      throw new Error("Schedule IDs must be unique agent-local names.");
    }
    ids.add(schedule.id);
    if (typeof schedule.cron !== "string" || schedule.cron.trim().split(/\s+/).length !== 5) {
      throw new Error(`${schedule.id}: cron must have five fields.`);
    }
    if (typeof schedule.timezone !== "string" || !schedule.timezone.trim()) throw new Error(`${schedule.id}: a timezone is required.`);
    new Intl.DateTimeFormat("en", { timeZone: schedule.timezone });
    if (!["skip", "latest"].includes(schedule.missed)) throw new Error(`${schedule.id}: choose missed: skip or latest.`);
    if (("input" in schedule) === ("command" in schedule)) {
      throw new Error(`${schedule.id}: choose exactly one of input or command.`);
    }
    if ("command" in schedule) {
      if (!Array.isArray(schedule.command) || !schedule.command.length
        || schedule.command.some(arg => typeof arg !== "string" || arg.includes("\0")) || !schedule.command[0].trim()) {
        throw new Error(`${schedule.id}: command must contain an executable and optional string arguments.`);
      }
      if ("instance" in schedule) throw new Error(`${schedule.id}: instance applies only to prompt schedules.`);
    } else {
      if (typeof schedule.input !== "string" || !schedule.input.trim()) throw new Error(`${schedule.id}: input is required.`);
      if (!schedule.instance || !["new", "existing"].includes(schedule.instance.mode)
        || (schedule.instance.mode === "existing" && !/^[a-z][a-z0-9-]*:[1-9]\d*$/.test(schedule.instance.id))) {
        throw new Error(`${schedule.id}: choose a new or exact existing instance.`);
      }
    }
    if (schedule.endAt !== undefined && (typeof schedule.endAt !== "string"
      || !/(Z|[+-]\d\d:\d\d)$/.test(schedule.endAt) || !Number.isFinite(Date.parse(schedule.endAt)))) {
      throw new Error(`${schedule.id}: endAt must be an absolute date with a timezone.`);
    }
    // Validate even expired definitions. No timer, store or model is opened here.
    parse(schedule, Date.UTC(2024, 0, 1)).next();
  }
}

type Admission = { at: number; id: string } & ({ chat: string; submissionId: number } | { taskId: number });
type SavedSchedule = {
  signature: string; definition: AgentSchedule; enabled: boolean; taskId: number | null;
  nextAt: number | null; last: Admission | null;
};

/** Calendar admission only. Each prompt or program runs independently of the timer. */
export function createSchedules(namespace: string, agent: LoadedAgent, service: ChatService, active: boolean) {
  const kind = scheduleTaskKind(namespace);
  const Schedules = defineDoc<{ entries: Record<string, SavedSchedule> }>({
    kind: `${namespace}.schedules`, version: 1, scope: "session",
    checkpointWhen: () => false, initial: () => ({ entries: {} }),
  });
  type ProgramResult = { startedAt: number; finishedAt: number; exitCode: number | null; stdout: string; stderr: string };
  const program = defineTask<{ id: string; at: number; command: string[] }, { phase: "run" }, ProgramResult>({
    name: kind + ".program", version: 1, initial: () => ({ phase: "run" }),
    phases: { async run(task, runtime, context) {
      const ctx = withAbortSignal(runtime.signal, context);
      const env = await runtime.env(ctx);
      if (!env) throw new Error("Scheduled programs require the agent's execution environment or a host working directory.");
      const startedAt = runtime.now();
      const stdout: string[] = [], stderr: string[] = [];
      const execution = await env.exec(task.input.command, {
        env: { DISPATCH_SCHEDULE_OCCURRENCE: task.input.id, DISPATCH_SCHEDULED_AT: new Date(task.input.at).toISOString() },
        onOutput: (text, _ctx, info) => (info.stream === "stdout" ? stdout : stderr).push(text),
      }, ctx);
      // Closing the host suspends this native task; recovery repeats the same occurrence.
      runtime.signal.throwIfAborted();
      const result = { startedAt, finishedAt: runtime.now(), exitCode: execution.ok ? execution.value.exitCode : null,
        stdout: stdout.join(""), stderr: stderr.join("") };
      await runtime.commit(() => ({ status: "terminal", outcome: execution.ok && execution.value.exitCode === 0
        ? { status: "completed", result }
        : { status: "failed", result, error: { message: execution.ok
          ? `Scheduled program exited with code ${execution.value.exitCode}.` : execution.error.message } } }), ctx);
    } },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  type Input = { schedule: AgentSchedule; firstAt: number };
  type Checkpoint = { phase: "wait"; at: number } | { phase: "admit"; at: number };
  const calendar = defineTask<Input, Checkpoint, null>({
    name: kind, version: 1,
    initial: input => ({ phase: "wait", at: input.firstAt }),
    phases: {
      async wait(task, runtime, ctx) {
        // History/terminal clients can resume ordinary work, but never calendars.
        if (!active) return runtime.sleepUntil(runtime.now() + 60_000, task.state.checkpoint, ctx);
        const now = runtime.now();
        let at = task.state.checkpoint.at;
        if (at > now) return runtime.sleepUntil(at, task.state.checkpoint, ctx);
        const schedule = task.input.schedule;
        if (schedule.endAt && now >= Date.parse(schedule.endAt)) {
          await runtime.commit(async tx => {
            (await tx.doc(Schedules)).entries[schedule.id].nextAt = null;
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, ctx);
          return;
        }
        // Sub-minute event-loop delay is still the current occurrence.
        if (at < Math.floor(now / 60_000) * 60_000) {
          at = schedule.missed === "latest"
            ? parse(schedule, now + 1).prev().getTime()
            : nextScheduleAt(schedule, now) ?? -1;
        }
        await runtime.commit(async tx => {
          const saved = (await tx.doc(Schedules)).entries[schedule.id];
          if (at < task.state.checkpoint.at || at < 0) {
            saved.nextAt = null;
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          saved.nextAt = at;
          return { status: "running", checkpoint: { phase: at > now ? "wait" : "admit", at } };
        }, ctx);
      },
      async admit(task, runtime, context) {
        if (!active) return runtime.sleepUntil(runtime.now() + 60_000, task.state.checkpoint, context);
        const ctx = withAbortSignal(runtime.signal, context);
        const schedule = task.input.schedule;
        const at = task.state.checkpoint.at;
        const id = `schedule:${agent.id}:${schedule.id}:${at}`;
        let prompt: Admission | undefined;
        if (!("command" in schedule)) {
          const chat = schedule.instance.mode === "new"
            ? await service.create(agent.id, "schedule", id, `${schedule.id} · ${new Date(at).toISOString()}`,
              { schedule: schedule.id, scheduledAt: at })
            : (await service.resolve(schedule.instance.id)).chat;
          if (chat.agent !== agent.id) throw new Error("An existing schedule instance must belong to its owning agent.");
          runtime.signal.throwIfAborted();
          const { submissionId } = await service.submit(chat.id, schedule.input, id, "followUp", "schedule");
          prompt = { at, id, chat: chat.id, submissionId };
        }
        const nextAt = nextScheduleAt(schedule, Math.max(at, runtime.now()));
        await runtime.commit(async tx => {
          const saved = (await tx.doc(Schedules)).entries[schedule.id];
          const last: Admission = "command" in schedule
            ? { at, id, taskId: await tx.createTask(program, { id, at, command: schedule.command },
              { ownership: { kind: "conversation" }, background: true }) }
            : prompt!;
          saved.last = last;
          saved.nextAt = nextAt;
          await tx.appendEntry(runtime.conversationId, { kind: `${namespace}.schedule-admission`, data: last });
          return nextAt === null
            ? { status: "terminal", outcome: { status: "completed", result: null } }
            : { status: "running", checkpoint: { phase: "wait", at: nextAt } };
        }, ctx);
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });

  const signature = (schedule: AgentSchedule) => createHash("sha256").update(JSON.stringify(schedule)).digest("hex");
  async function reconcile(host: AgentHost, enabled: boolean) {
    const definitions = new Map((agent.schedules ?? []).map(schedule => [schedule.id, schedule]));
    if (enabled) for (const schedule of definitions.values()) {
      if ("instance" in schedule && schedule.instance.mode === "existing") {
        const { chat } = await service.resolve(schedule.instance.id);
        if (chat.agent !== agent.id) throw new Error("An existing schedule instance must belong to its owning agent.");
      }
    }
    const previous = (await host.harness.snapshot(Schedules, context))?.entries ?? {};
    for (const [id, saved] of Object.entries(previous)) {
      const definition = definitions.get(id);
      if (saved.taskId && (!enabled || !definition || signature(definition) !== saved.signature)) {
        await host.harness.abortTask(saved.taskId as TaskId, context);
      }
    }
    await host.conversation.commit(async tx => {
      const entries = (await tx.doc(Schedules)).entries;
      for (const [id, saved] of Object.entries(entries)) {
        if (!enabled || !definitions.has(id)) {
          saved.enabled = false;
          saved.taskId = null;
          saved.nextAt = null;
        }
      }
      for (const schedule of definitions.values()) {
        const saved = entries[schedule.id];
        const hash = signature(schedule);
        // Keep a terminal failure visible; restarting is not an automatic retry.
        if (saved?.signature === hash && saved.enabled === enabled) continue;
        const nextAt = enabled ? nextScheduleAt(schedule, Date.now()) : null;
        const taskId = nextAt === null ? null : await tx.createTask(calendar, { schedule, firstAt: nextAt },
          { ownership: { kind: "conversation" }, background: true });
        entries[schedule.id] = {
          signature: hash, definition: schedule, enabled, taskId, nextAt, last: saved?.last ?? null,
        };
      }
    }, context);
  }

  async function inspect(host: AgentHost) {
    const entries = (await host.harness.snapshot(Schedules, context))?.entries ?? {};
    return Promise.all(Object.entries(entries).map(async ([id, saved]) => {
      const task = saved.taskId ? await host.harness.getTask(saved.taskId as TaskId, context) : undefined;
      const run = saved.last && "taskId" in saved.last
        ? await host.harness.getTask(saved.last.taskId as TaskId<ProgramResult>, context) : undefined;
      return { agent: agent.id, id, ...saved, state: task?.state ?? null,
        last: run ? { ...saved.last!, state: run.state } : saved.last };
    }));
  }
  return { extension: defineExtension({ name: `${namespace}.schedules`, tasks: [calendar, program] }), reconcile, inspect };
}
