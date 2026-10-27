import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTask, type TaskId } from "@earendil-works/pi-durable";
import type { LoadedAgent } from "./definition.js";
import type { AgentHost } from "./runtime.js";
import type { ChatService } from "./chat.js";

export type AgentSchedule = {
  id: string;
  cron: string;
  timezone: string;
  instance: { mode: "new" } | { mode: "existing"; id: string };
  input: string;
  /** Offline occurrences: discard old minutes, or admit only the latest one. */
  missed: "skip" | "latest";
  /** Optional exclusive, absolute expiry, including Z or an explicit offset. */
  endAt?: string;
};

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
    if (typeof schedule.input !== "string" || !schedule.input.trim()) throw new Error(`${schedule.id}: input is required.`);
    if (!schedule.instance || !["new", "existing"].includes(schedule.instance.mode)
      || (schedule.instance.mode === "existing" && !/^[a-z][a-z0-9-]*:[1-9]\d*$/.test(schedule.instance.id))) {
      throw new Error(`${schedule.id}: choose a new or exact existing instance.`);
    }
    if (schedule.endAt !== undefined && (typeof schedule.endAt !== "string"
      || !/(Z|[+-]\d\d:\d\d)$/.test(schedule.endAt) || !Number.isFinite(Date.parse(schedule.endAt)))) {
      throw new Error(`${schedule.id}: endAt must be an absolute date with a timezone.`);
    }
    // Validate even expired definitions. No timer, store or model is opened here.
    parse(schedule, Date.UTC(2024, 0, 1)).next();
  }
}

type Admission = { at: number; id: string; chat: string; submissionId: number };
type SavedSchedule = {
  signature: string; definition: AgentSchedule; enabled: boolean; taskId: number | null;
  nextAt: number | null; last: Admission | null;
};

/** Calendar admission only. The native task never waits for the agent's answer. */
export function createSchedules(namespace: string, agent: LoadedAgent, service: ChatService, active: boolean) {
  const kind = scheduleTaskKind(namespace);
  const Schedules = defineDoc<{ entries: Record<string, SavedSchedule> }>({
    kind: `${namespace}.schedules`, version: 1, scope: "session",
    checkpointWhen: () => false, initial: () => ({ entries: {} }),
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
        const chat = schedule.instance.mode === "new"
          ? await service.create(agent.id, "schedule", id, `${schedule.id} · ${new Date(at).toISOString()}`,
            { schedule: schedule.id, scheduledAt: at })
          : (await service.resolve(schedule.instance.id)).chat;
        if (chat.agent !== agent.id) throw new Error("An existing schedule instance must belong to its owning agent.");
        runtime.signal.throwIfAborted();
        const { submissionId } = await service.submit(chat.id, schedule.input, id, "followUp", "schedule");
        const nextAt = nextScheduleAt(schedule, Math.max(at, runtime.now()));
        await runtime.commit(async tx => {
          const saved = (await tx.doc(Schedules)).entries[schedule.id];
          const last = { at, id, chat: chat.id, submissionId };
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
      if (schedule.instance.mode === "existing") {
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
      return { agent: agent.id, id, ...saved, state: task?.state ?? null };
    }));
  }
  return { extension: defineExtension({ name: `${namespace}.schedules`, tasks: [calendar] }), reconcile, inspect };
}
