import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cancelService, run, serveProcess, type ChatService, type RunOptions } from "@dispatch/runner";
import { prepareSlack, type SlackOptions, type SlackThreadInput } from "./index.js";
import { SlackThreadProcesses } from "./threads.js";

type Open = NonNullable<RunOptions["open"]>;
export type SlackHostOptions = {
  root: string;
  stateRoot: string;
  entrypoint: string;
  runner: NonNullable<RunOptions["runner"]>;
  slack: Omit<SlackOptions, "threads" | "onStream" | "allowProgressText">;
  /** Open suspended native stores; the host attaches adapters before recovery. */
  open(options: Parameters<Open>[0] & { stateRoot: string; thread?: SlackThreadInput }): Promise<ChatService>;
  allowProgressText?(service: ChatService, conversation: number, inputs: readonly number[]): Promise<boolean>;
  /** External work must enforce ownership independently of model arguments. */
  stopThread(input: SlackThreadInput): Promise<void>;
  threadBusy(): Promise<boolean>;
  close?(): Promise<void>;
  ready?(service: ChatService): Promise<void>;
};

/** One transport supervisor and one native owner per thread. Never starts calendars. */
export async function runSlackHost(options: SlackHostOptions) {
  const argument = process.argv.indexOf("--thread");
  const directory = argument < 0 ? undefined : process.argv[argument + 1];
  if (argument >= 0 && (!directory || !process.send)) throw new Error("Use the thread supervisor.");
  const thread: SlackThreadInput | undefined = directory
    ? JSON.parse(await readFile(join(directory, "thread.json"), "utf8")).input : undefined;
  let service!: ChatService;
  let transport!: Awaited<ReturnType<typeof prepareSlack>>;
  const threads = directory ? undefined : new SlackThreadProcesses(join(options.stateRoot, "slack-threads"),
    async (path, _input, cancelPending) => ({
      module: resolve(options.entrypoint),
      args: ["--thread", path, ...(cancelPending ? ["--cancel-pending"] : [])],
      options: { cwd: options.root, env: process.env },
    }),
    async (input, streams) => {
      await Promise.all([transport.stopStreams(input, streams), options.stopThread(input)]);
    });
  const events = new Map<string, () => void>();
  const saved = (event: any) => {
    if (event?.type === "eventSaved") { events.get(event.eventId)?.(); events.delete(event.eventId); }
  };
  if (directory) process.on("message", saved);
  transport = await prepareSlack(options.root, options.runner, {
    ...options.slack, threads,
    allowProgressText: options.allowProgressText
      ? (id, inputs) => options.allowProgressText!(service, id, inputs) : undefined,
    ...(directory ? { onStream: (event: object) => new Promise<void>(done => {
      const eventId = randomUUID(); events.set(eventId, done);
      process.send?.({ type: "stream", ...event, eventId });
    }) } : {}),
  });
  let app: Awaited<ReturnType<typeof run>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    clearInterval(timer);
    await threads?.close();
    try { await app?.close(); } finally { await options.close?.(); }
    process.off("message", saved);
  })();
  try {
    app = await run({
      root: options.root, runner: options.runner, resume: false,
      adapters: [{ async prepare() {
        return { ...transport, start: (value: ChatService) => transport.start(value, !directory) };
      } }],
      async open(bindings) {
        service = await options.open({ ...bindings,
          stateRoot: directory ? join(directory, "native") : join(options.stateRoot, "transport"), thread });
        if (directory && process.argv.includes("--cancel-pending")) await cancelService(service);
        return service;
      },
    });
    for (const host of service.hosts.values()) host.harness.resume();
    if (thread) {
      let latest = thread.key, admitting = 0, received = false, checking = false;
      timer = setInterval(() => {
        if (checking || admitting || !received) return;
        checking = true;
        const key = latest;
        void Promise.all([service.busy(), options.threadBusy()]).then(states => {
          if (!states.some(Boolean) && !admitting && key === latest) process.send?.({ type: "idle", key });
        }).catch(console.error).finally(() => { checking = false; });
      }, 1_000);
      serveProcess(async (operation, input) => {
        if (operation !== "receive" || input.team !== thread.team || input.channel !== thread.channel || input.thread !== thread.thread)
          throw new Error("Input does not belong to this thread.");
        latest = input.key; admitting++;
        try { await transport.receive(input); received = true; } finally { admitting--; }
        return { admitted: true, pid: process.pid };
      }, async cancel => { if (cancel) await cancelService(service); await close(); });
    } else {
      await threads!.recover();
      await options.ready?.(service);
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void close().then(() => process.exit(0)); });
    }
    return { service, threads, close };
  } catch (error) { await close(); throw error; }
}
