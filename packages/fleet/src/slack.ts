import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cancelService, run, type ChatService, type RunOptions } from "@dispatch/runner";
import {
  createSlackWebApi, prepareSlack, slackThreadConfig,
  type SlackConfig, type SlackOptions, type SlackThreadExecution, type SlackThreadExecutor, type SlackThreadInput,
} from "@dispatch/slack";
import { FleetClient } from "./client.js";
import type { FleetRelease, FleetRun, FleetRunContext } from "./types.js";

type ExecuteRequest = Parameters<SlackThreadExecutor>[0];
type EventHandler = Parameters<SlackThreadExecutor>[1];
type OwnedThread = { input: SlackThreadInput; admitted?: string; onEvent: EventHandler; closing: boolean; cancelling: boolean };

function sameThread(left: SlackThreadInput, right: SlackThreadInput) {
  return left.team === right.team && left.channel === right.channel && left.thread === right.thread
    && left.agent === right.agent && isDeepStrictEqual(left.profile, right.profile);
}

/** Coordinator routing only. Native Pi owns execution; Fleet owns worker placement. */
export class FleetSlackThreads {
  private readonly owned = new Map<string, OwnedThread>();
  constructor(readonly options: {
    client: FleetClient;
    /** Resolve the exact retained launch, never replace it with today's release. */
    release(request: ExecuteRequest): FleetRelease | Promise<FleetRelease>;
  }) {}

  /** Call only after the root relay has authenticated this run and worker epoch. */
  start(run: string): { thread: SlackThreadInput; admitted: boolean; closing: boolean; cancelling: boolean } {
    const owned = this.owned.get(run);
    if (!owned) throw new Error("Slack thread routing has not recovered.");
    return { thread: structuredClone(owned.input), admitted: owned.admitted === owned.input.key,
      closing: owned.closing, cancelling: owned.cancelling };
  }

  /** Await before acknowledging /events; the supervisor fsyncs stream receipts. */
  async event(run: string, event: unknown) {
    const owned = this.owned.get(run);
    if (!owned) throw new Error("Slack thread has no active coordinator owner.");
    await owned.onEvent(event);
  }

  readonly execute: SlackThreadExecutor = async (request, onEvent) => {
    const run = createHash("sha256").update(request.key).digest("hex");
    if (this.owned.has(run)) throw new Error("Slack thread already has a coordinator owner.");
    const owned: OwnedThread = { input: structuredClone(request.input), onEvent, closing: false, cancelling: false };
    this.owned.set(run, owned);
    let exited!: () => void;
    let closing: Promise<void> | undefined;
    const execution: SlackThreadExecution = {
      exited: new Promise<void>(resolve => { exited = resolve; }),
      request: async (operation, value, signal) => {
        signal?.throwIfAborted();
        if (owned.closing || operation !== "receive") throw new Error("Invalid or closing Slack thread operation.");
        const input = value as SlackThreadInput;
        if (!input || !sameThread(owned.input, input)) throw new Error("Input does not belong to the pinned Slack thread.");
        owned.input = structuredClone(input);
        const result = this.options.client.command(run, { tool: "slack.receive", input }).then(result => {
          owned.admitted = input.key;
          return result;
        });
        if (!signal) return result;
        return new Promise((resolve, reject) => {
          const aborted = () => reject(signal.reason ?? new Error("Worker observation cancelled."));
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
          void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
        });
      },
      close: (operation = "close") => closing ??= (async () => {
        owned.closing = true;
        owned.cancelling ||= operation === "cancel";
        try {
          if (operation === "cancel") await this.options.client.cancel(run);
          else await this.options.client.suspend(run);
          if (this.owned.get(run) === owned) this.owned.delete(run);
          exited();
        } catch (error) { closing = undefined; throw error; }
      })(),
    };
    try {
      const release = await this.options.release(request);
      const retained = await this.options.client.statusOrUndefined(run);
      if (retained && (!isDeepStrictEqual(retained.assignment.release, release)
        || !sameThread(retained.assignment.input as SlackThreadInput, request.input))) {
        throw new Error("Fleet assignment does not match the retained Slack thread and release.");
      }
      // A supervisor may die after saving Stop but before reaching Fleet.
      if (retained && request.cancelPending) await this.options.client.cancel(run);
      await this.options.client.ensure(run, release, retained?.assignment.input ?? request.input);
      return execution;
    } catch (error) {
      if (this.owned.get(run) === owned) this.owned.delete(run);
      throw error;
    }
  };
}

type Open = NonNullable<RunOptions["open"]>;
export type FleetSlackRunOptions = {
  runner: NonNullable<RunOptions["runner"]>;
  slack: Omit<SlackOptions, "config" | "credentials" | "threads" | "webApi" | "onStream" | "allowProgressText"> & { config: SlackConfig };
  /** Open suspended native stores with context.storage and the pinned thread policy. */
  open(options: Parameters<Open>[0] & { thread: SlackThreadInput; context: FleetRunContext }): Promise<ChatService>;
  allowProgressText?(service: ChatService, conversation: number, inputs: readonly number[]): Promise<boolean>;
  threadBusy?(): Promise<boolean>;
  close?(): Promise<void>;
};

/** Native module helper: no Socket Mode connection, token, or placement scheduler. */
export async function createFleetSlackRun(context: FleetRunContext, options: FleetSlackRunOptions): Promise<FleetRun> {
  const bootstrap = await context.relay<ReturnType<FleetSlackThreads["start"]>>("/company/slack/start", {});
  const { thread } = bootstrap;
  if (!sameThread(context.assignment.input as SlackThreadInput, thread))
    throw new Error("Coordinator recovery changed the pinned Slack thread.");
  let service!: ChatService;
  const transport = await prepareSlack(context.root, options.runner, {
    ...options.slack, config: slackThreadConfig(options.slack.config, thread),
    webApi: createSlackWebApi((method, args) => context.relay("/company/slack/api", { method, args })),
    onStream: event => context.emit({ type: "stream", ...event }),
    allowProgressText: options.allowProgressText
      ? (conversation, inputs) => options.allowProgressText!(service, conversation, inputs) : undefined,
  });
  let app: Awaited<ReturnType<typeof run>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  let latest = thread.key, admitting = 0, checking = false, received = bootstrap.admitted;
  let accepting = !bootstrap.closing;
  const close = () => closing ??= (async () => {
    clearInterval(timer);
    try { await app?.close(); } finally { await options.close?.(); }
  })();
  const receive = async (input: SlackThreadInput) => {
    if (!accepting || closing || !sameThread(thread, input)) throw new Error("Input does not belong to this open Slack thread.");
    latest = input.key; admitting++;
    try { await transport.receive(input); received = true; } finally { admitting--; }
    return { admitted: true };
  };
  const status = async () => ({ busy: admitting > 0 || (await Promise.all([
    service.busy(), options.threadBusy?.() ?? false,
  ])).some(Boolean), key: latest });
  try {
    app = await run({ root: context.root, runner: options.runner, resume: false,
      adapters: [{ async prepare() { return { ...transport, start: (value: ChatService) => transport.start(value, false) }; } }],
      async open(bindings) {
        service = await options.open({ ...bindings, thread, context });
        if (context.assignment.cancelPending || bootstrap.cancelling) await cancelService(service);
        return service;
      },
    });
    await context.emit({ type: "ready" });
    if (!bootstrap.closing || bootstrap.cancelling || context.assignment.cancelPending)
      for (const host of service.hosts.values()) host.harness.resume();
    timer = setInterval(() => {
      if (checking || admitting || closing || !received || !accepting) return;
      checking = true;
      const key = latest;
      void status().then(async value => {
        if (!value.busy && !admitting && !closing && key === latest) await context.emit({ type: "idle", key });
      }).catch(console.error).finally(() => { checking = false; });
    }, 1_000);
    return {
      async command(value, signal) {
        signal.throwIfAborted();
        const command = value as { tool?: string; input?: SlackThreadInput };
        if (command.tool === "cancel") { accepting = false; await cancelService(service); return { cancelled: true }; }
        if (command.tool !== "slack.receive" || !command.input) throw new Error("Unknown Slack thread command.");
        return receive(command.input);
      },
      status, close,
    };
  } catch (error) { await close(); throw error; }
}
