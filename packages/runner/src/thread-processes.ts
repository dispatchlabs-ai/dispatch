import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessScope } from "./process-scope.js";
import type { ForkOptions } from "node:child_process";
export type ThreadInput = { key: string; agent: string; timestamp: string };

type ThreadRecord<Input extends ThreadInput> = {
  key: string; input: Input; active: boolean; needsCancel: boolean;
  cancelledThrough: string; streams: Record<string, string>;
};
export type ThreadLaunch = { module: string; args: string[]; options: ForkOptions };
export type ThreadExecution = {
  readonly exited: Promise<void>;
  readonly child?: { readonly pid?: number };
  request(operation: string, value?: unknown, signal?: AbortSignal): Promise<any>;
  close(operation?: "cancel" | "close"): Promise<void>;
};
export type ThreadExecutor<Input extends ThreadInput> = (
  request: { key: string; directory: string; input: Input; cancelPending: boolean; launch: ThreadLaunch },
  /** Resolve only after the coordinator has durably retained the event. */
  onEvent: (event: any) => Promise<void>,
) => ThreadExecution | Promise<ThreadExecution>;

/** Transport routing only; each worker's native Pi store owns admitted work and recovery. */
export class ThreadProcesses<Input extends ThreadInput> {
  private workers = new Map<string, ThreadExecution>();
  private starts = new Map<string, Promise<ThreadExecution>>();
  private stops = new Map<string, Promise<void>>();
  private writes = new Map<string, Promise<unknown>>();
  private closing = false;
  constructor(
    readonly directory: string,
    readonly launch: (directory: string, input: Input, cancelPending: boolean) => Promise<ThreadLaunch>,
    readonly stopped: (input: Input, streams: string[]) => Promise<void>,
    readonly route: (input: Input) => string,
    readonly retain: (previous: Input, input: Input) => Input,
    readonly execute: ThreadExecutor<Input> = ({ launch }, onEvent) =>
      new ProcessScope(launch.module, launch.args, launch.options, onEvent),
  ) {}
  private key(input: Input) { return this.route(input); }
  private path(key: string) { return join(this.directory, createHash("sha256").update(key).digest("hex")); }
  private async record(key: string): Promise<ThreadRecord<Input> | undefined> {
    try { return JSON.parse(await readFile(join(this.path(key), "thread.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  private change(key: string, update: (state?: ThreadRecord<Input>) => ThreadRecord<Input>) {
    const next = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const state = update(await this.record(key));
      const directory = this.path(key);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.thread-${randomUUID()}`);
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(directory, "thread.json"));
      const folder = await open(directory, "r");
      try { await folder.sync(); } finally { await folder.close(); }
      return state;
    });
    this.writes.set(key, next);
    return next;
  }
  private async worker(key: string, state: ThreadRecord<Input>): Promise<ThreadExecution | undefined> {
    await this.stops.get(key);
    state = (await this.record(key))!;
    if (!state.active || state.input.timestamp <= state.cancelledThrough) return;
    const existing = this.workers.get(key);
    if (existing) return existing;
    let pending = this.starts.get(key);
    if (!pending) {
      pending = (async () => {
        if (this.closing) throw new Error("Thread supervisor is closing.");
        const configuration = await this.launch(this.path(key), state.input, state.needsCancel);
        let worker: ThreadExecution | undefined;
        worker = await this.execute({ key, directory: this.path(key), input: state.input,
          cancelPending: state.needsCancel, launch: configuration }, async event => {
          if (event?.type === "ready") await this.change(key, current => {
            if (!current) throw new Error("Missing thread record.");
            if (current.cancelledThrough === state.cancelledThrough) current.needsCancel = false;
            return current;
          });
          if (event?.type === "stream" && typeof event.key === "string" && typeof event.ts === "string") {
            await this.change(key, current => {
              if (!current) throw new Error("Missing thread record.");
              if (event.done) delete current.streams[event.key]; else current.streams[event.key] = event.ts;
              return current;
            });
          }
          if (event?.type === "idle") await this.change(key, current => {
            if (!current) throw new Error("Missing thread record.");
            if (worker && this.workers.get(key) === worker && current.input.key === event.key) current.active = false;
            return current;
          });
        });
        this.workers.set(key, worker);
        void worker.exited.then(async () => {
          if (this.workers.get(key) !== worker) return;
          this.workers.delete(key);
          await delay(1_000);
          if (this.closing || this.stops.has(key)) return;
          await this.writes.get(key);
          const retained = await this.record(key);
          if (retained?.active && retained.input.timestamp > retained.cancelledThrough)
            await this.receive(retained.input);
        }).catch(console.error);
        return worker;
      })();
      this.starts.set(key, pending);
      void pending.finally(() => this.starts.delete(key)).catch(() => {});
    }
    return pending;
  }
  async receive(input: Input) {
    const key = this.key(input);
    const state = await this.change(key, current => {
      current ??= { key, input, active: false, needsCancel: false, cancelledThrough: "", streams: {} };
      // A changed route applies to new threads. Retained native stores and their
      // release pins still belong to the definition admitted on the first input.
      if (input.timestamp > current.cancelledThrough) {
        current.input = this.retain(current.input, input); current.active = true;
      }
      return current;
    });
    if (input.timestamp <= state.cancelledThrough) return;
    const worker = await this.worker(key, state);
    if (!worker) return;
    // A Stop may have arrived while the worker was opening its native stores.
    if (input.timestamp <= (await this.record(key))!.cancelledThrough) return;
    await worker.request("receive", this.retain(state.input, input));
  }
  async stop(input: Input) {
    const key = this.key(input);
    const previous = this.stops.get(key);
    const stopping = (async () => {
      await previous;
      let superseded = false;
      const state = await this.change(key, current => {
        if (current && input.timestamp < current.cancelledThrough) { superseded = true; return current; }
        return { ...(current ?? { key, input, streams: {} }), active: false, needsCancel: true,
          cancelledThrough: input.timestamp };
      });
      if (superseded) return;
      const worker = this.workers.get(key) ?? await this.starts.get(key);
      if (worker) await worker.close("cancel");
      // Read after exit so the last committed stream receipt is included.
      await this.writes.get(key);
      const latest = await this.record(key);
      await this.stopped(this.retain(state.input, input), Object.values(latest?.streams ?? state.streams));
      await this.change(key, current => ({ ...current!, streams: {} }));
    })();
    this.stops.set(key, stopping);
    try { await stopping; } finally { if (this.stops.get(key) === stopping) this.stops.delete(key); }
  }
  async recover() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await Promise.all((await readdir(this.directory)).filter(name => /^[a-f0-9]{64}$/.test(name)).map(async name => {
      const state: ThreadRecord<Input> = JSON.parse(await readFile(join(this.directory, name, "thread.json"), "utf8"));
      // A supervisor can die after persisting Stop but before external cleanup.
      // Repeat the idempotent host cleanup before any new primary may recover.
      if (state.needsCancel) {
        await this.stopped(state.input, Object.values(state.streams));
        await this.change(state.key, current => ({ ...current!, streams: {} }));
      }
      if (state.active && state.input.timestamp > state.cancelledThrough) await this.receive(state.input);
    }));
  }
  async status() {
    return Promise.all([...this.workers].map(async ([key, worker]) => ({
      key, pid: worker.child?.pid, directory: this.path(key), state: await this.record(key),
    })));
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.starts.values()]);
    await Promise.all([...this.workers.values()].map(worker => worker.close()));
    await Promise.allSettled([...this.writes.values()]);
  }
}
