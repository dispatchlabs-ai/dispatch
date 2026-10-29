import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessScope } from "@dispatch/runner";
import type { ForkOptions } from "node:child_process";
import type { SlackThreadInput } from "./index.js";

type RecordState = {
  key: string; input: SlackThreadInput; active: boolean; needsCancel: boolean;
  cancelledThrough: string; streams: Record<string, string>;
};
export type ThreadLaunch = { module: string; args: string[]; options: ForkOptions };

/** Transport routing only; each worker's native Pi store owns admitted work and recovery. */
export class SlackThreadProcesses {
  private workers = new Map<string, ProcessScope>();
  private starts = new Map<string, Promise<ProcessScope>>();
  private stops = new Map<string, Promise<void>>();
  private writes = new Map<string, Promise<unknown>>();
  private closing = false;
  constructor(
    readonly directory: string,
    readonly launch: (directory: string, input: SlackThreadInput, cancelPending: boolean) => Promise<ThreadLaunch>,
    readonly stopped: (input: SlackThreadInput, streams: string[]) => Promise<void>,
  ) {}
  private key(input: SlackThreadInput) { return `${input.team}:${input.channel}:${input.thread}`; }
  private path(key: string) { return join(this.directory, createHash("sha256").update(key).digest("hex")); }
  private async record(key: string): Promise<RecordState | undefined> {
    try { return JSON.parse(await readFile(join(this.path(key), "thread.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  private change(key: string, update: (state?: RecordState) => RecordState) {
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
  private async worker(key: string, state: RecordState): Promise<ProcessScope | undefined> {
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
        const worker = new ProcessScope(configuration.module, configuration.args, configuration.options, async event => {
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
            if (this.workers.get(key) === worker && current.input.key === event.key) current.active = false;
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
  async receive(input: SlackThreadInput) {
    const key = this.key(input);
    const state = await this.change(key, current => {
      current ??= { key, input, active: false, needsCancel: false, cancelledThrough: "", streams: {} };
      if (input.timestamp > current.cancelledThrough) { current.input = input; current.active = true; }
      return current;
    });
    if (input.timestamp <= state.cancelledThrough) return;
    const worker = await this.worker(key, state);
    if (!worker) return;
    // A Stop may have arrived while the worker was opening its native stores.
    if (input.timestamp <= (await this.record(key))!.cancelledThrough) return;
    await worker.request("receive", input);
  }
  async stop(input: SlackThreadInput) {
    const key = this.key(input);
    const previous = this.stops.get(key);
    const stopping = (async () => {
      await previous;
      const state = await this.change(key, current => ({
        ...(current ?? { key, input, streams: {} }), active: false, needsCancel: true,
        cancelledThrough: [current?.cancelledThrough ?? "", input.timestamp].sort().at(-1)!,
      }));
      const worker = this.workers.get(key) ?? await this.starts.get(key);
      if (worker) await worker.close("cancel");
      // Read after exit so the last committed stream receipt is included.
      await this.writes.get(key);
      const latest = await this.record(key);
      await this.stopped(input, Object.values(latest?.streams ?? state.streams));
      await this.change(key, current => ({ ...current!, streams: {} }));
    })();
    this.stops.set(key, stopping);
    try { await stopping; } finally { if (this.stops.get(key) === stopping) this.stops.delete(key); }
  }
  async recover() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await Promise.all((await readdir(this.directory)).filter(name => /^[a-f0-9]{64}$/.test(name)).map(async name => {
      const state: RecordState = JSON.parse(await readFile(join(this.directory, name, "thread.json"), "utf8"));
      if (state.active && state.input.timestamp > state.cancelledThrough) await this.receive(state.input);
    }));
  }
  async status() {
    return Promise.all([...this.workers].map(async ([key, worker]) => ({
      key, pid: worker.child.pid, directory: this.path(key), state: await this.record(key),
    })));
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.starts.values()]);
    await Promise.all([...this.workers.values()].map(worker => worker.close()));
    await Promise.allSettled([...this.writes.values()]);
  }
}
