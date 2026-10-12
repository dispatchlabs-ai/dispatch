import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type Frame = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number } };
export class MuseInteractionRequiredError extends Error {}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** MSP uses newline-delimited JSON-RPC. Raw native diagnostics never enter public activity. */
export class MuseClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private sequence = 0;
  private closed = false;
  readonly exited: Promise<void>;
  readonly failed: Promise<never>;
  private rejectFailure!: (error: Error) => void;
  private failure?: Error;
  private shutdown?: Promise<void>;
  private readonly requests = new Set<Promise<void>>();

  constructor(executable: string, args: string[], env: NodeJS.ProcessEnv, handleRequest?: (method: string, params: Record<string, unknown>) => Promise<void>) {
    this.failed = new Promise((_, reject) => { this.rejectFailure = reject; });
    void this.failed.catch(() => {});
    this.process = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.process.stderr.resume();
    this.process.stdin.on("error", () => this.fail(new Error("Muse Code input connection closed.")));
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", line => {
      try {
        const frame = JSON.parse(line) as Frame;
        if (frame.method && frame.id !== undefined) {
          if (frame.method === "approval/request" && handleRequest) {
            // A presentation receipt changes no permission. Decisions are separate MSP commands.
            this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }) + "\n");
            const work = handleRequest(frame.method, frame.params ?? {}).catch(() => {
              this.fail(new MuseInteractionRequiredError("Muse Code approval could not be resolved safely."));
            }).finally(() => this.requests.delete(work));
            this.requests.add(work);
          } else {
            this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Dispatch does not support native interactive requests." } }) + "\n");
            this.fail(new MuseInteractionRequiredError("Muse Code requested unsupported native interaction."));
          }
        } else if (typeof frame.id === "number") {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          this.pending.delete(frame.id); clearTimeout(pending.timer);
          if (frame.error) pending.reject(new Error(`Muse Code rejected a protocol request (${frame.error.code}). Check native login, model access, and runner configuration.`));
          else pending.resolve(frame.result);
        } else if (frame.method) {
          for (const listener of this.listeners) listener(frame.method, frame.params ?? {});
        }
      } catch { this.fail(new Error("Muse Code returned an invalid protocol frame.")); this.process.kill("SIGTERM"); }
    });
    this.exited = new Promise(resolve => {
      this.process.once("error", () => this.fail(new Error("Muse Code could not start. Install Muse on the configured runner and check DISPATCH_MUSE_EXECUTABLE.")));
      this.process.once("close", () => {
        this.closed = true; lines.close(); this.fail(new Error("Muse Code exited before the request completed.")); resolve();
      });
    });
  }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  request<T>(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("Muse Code is no longer running."));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Muse Code ${method} timed out. Inspect the native session before retrying uncertain work.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method: string) {
    if (!this.closed) this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }
  interrupt() { this.fail(new Error("Muse Code was interrupted.")); }
  close(): Promise<void> {
    return this.shutdown ??= this.closeProcess();
  }
  private async closeProcess() {
    if (this.closed) return this.exited;
    this.process.stdin.end();
    const terminate = setTimeout(() => this.process.kill("SIGTERM"), 5_000);
    const kill = setTimeout(() => this.process.kill("SIGKILL"), 10_000);
    try { await this.exited; await Promise.allSettled([...this.requests]); } finally { clearTimeout(terminate); clearTimeout(kill); }
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.rejectFailure(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    void this.close();
  }
}
