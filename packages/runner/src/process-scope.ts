import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { context, type ChatService } from "./chat.js";

/** A trusted worker and all of its local descendants share one cancellation boundary. */
export class ProcessScope {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; dispose(): void }>();
  private closed = false;
  private ready: Promise<void>;

  constructor(module: string, args: string[], options: ForkOptions, onEvent?: (event: any) => void | Promise<void>) {
    if (process.platform === "win32") throw new Error("Process scopes require POSIX process groups.");
    this.child = fork(module, args, { ...options, detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const child = this.child;
    this.exited = new Promise(resolve => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    this.ready = new Promise((resolve, reject) => {
      const failed = () => reject(new Error("Worker exited before becoming ready."));
      child.once("exit", failed);
      child.on("message", (message: any) => {
        if (message?.type === "ready") { child.off("exit", failed); resolve(); }
        if (message?.type !== "result") {
          void Promise.resolve(onEvent?.(message)).then(() => {
            if (message?.eventId && child.connected) child.send({ type: "eventSaved", eventId: message.eventId }, () => {});
          }).catch(error => { console.error(error); this.killTree(); });
          return;
        }
        const call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id); call.dispose();
        if (message.ok) call.resolve(message.result);
        else call.reject(new Error(message.error ?? "Worker request failed."));
      });
      child.once("error", reject);
    });
    // A dead leader must not leave an inherited subprocess running.
    void this.exited.then(() => {
      this.killTree();
      for (const call of this.pending.values()) {
        call.dispose(); call.reject(new Error("Worker exited; inspect its retained native state."));
      }
      this.pending.clear();
    });
    void this.ready.catch(() => {});
  }

  async request(operation: string, value: unknown = null, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    if ((this.closed && operation !== "cancel" && operation !== "close") || !this.child.connected)
      throw new Error("Worker is closing.");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const aborted = () => {
        this.pending.get(id)?.dispose(); this.pending.delete(id);
        if (this.child.connected) this.child.send({ type: "abort", id }, () => {});
        reject(new Error("Worker observation cancelled."));
      };
      this.pending.set(id, { resolve, reject, dispose: () => signal?.removeEventListener("abort", aborted) });
      signal?.addEventListener("abort", aborted, { once: true });
      this.child.send({ type: "request", id, operation, value }, error => {
        if (!error) return;
        this.pending.get(id)?.dispose(); this.pending.delete(id); reject(error);
      });
    });
  }

  killTree() {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }

  /** Bounded cooperative cleanup, then enforced termination of the entire group. */
  async close(operation: "cancel" | "close" = "close") {
    if (this.closed) return this.exited;
    const cleanup = this.request(operation).catch(() => {});
    this.closed = true;
    await Promise.race([this.exited, delay(1_000)]);
    this.killTree();
    await this.exited;
    void cleanup;
  }
}

/** Mark every task before enabling native abort cleanup: no pending tool gets replayed. */
export async function cancelService(service: ChatService) {
  for (const host of service.hosts.values()) {
    const state = await host.harness.inspect(context);
    for (const task of state.tasks) await host.harness.abortTask(task.record.id, context);
  }
  await Promise.all((await service.list()).map(async chat => {
    const { conversation } = await service.resolve(chat.id);
    await conversation.abort(context, { background: true });
  }));
}

/** Trusted IPC endpoint. Concurrent requests allow steering/stop during an observation. */
export function serveProcess(
  dispatch: (operation: string, value: any, signal: AbortSignal) => Promise<unknown>,
  close: (cancel: boolean) => Promise<void>,
) {
  if (!process.send) throw new Error("This worker needs its owning process.");
  const requests = new Map<string, AbortController>();
  let closing: Promise<void> | undefined;
  const finish = (cancel: boolean) => closing ??= (async () => {
    // Also enforce the group boundary if the supervisor itself disappears.
    const deadline = setTimeout(() => process.kill(-process.pid, "SIGKILL"), 1_000);
    deadline.unref();
    for (const controller of requests.values()) controller.abort();
    await close(cancel);
    process.exit(0);
  })();
  process.on("message", (message: any) => {
    if (message?.type === "abort") { requests.get(message.id)?.abort(); return; }
    if (message?.type !== "request") return;
    if (message.operation === "cancel" || message.operation === "close") {
      void finish(message.operation === "cancel"); return;
    }
    if (closing) return;
    const controller = new AbortController();
    requests.set(message.id, controller);
    void dispatch(message.operation, message.value, controller.signal).then(
      result => { if (process.connected) process.send?.({ type: "result", id: message.id, ok: true, result }); },
      error => { if (process.connected) process.send?.({ type: "result", id: message.id, ok: false,
        error: error instanceof Error ? error.message : "Worker request failed." }); },
    ).finally(() => requests.delete(message.id));
  });
  process.once("disconnect", () => { void finish(false); });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void finish(false); });
  process.send({ type: "ready" });
}
