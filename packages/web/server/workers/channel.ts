import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { HistoryCursorError } from "../chat-pages.js";
import { RuntimeError } from "../runtime.js";

const paths = ["/ready", "/rpc", "/sync", "/idle-retire"] as const;
export type WorkerCommandPath = typeof paths[number];
const commandSchema = z.object({ id: z.string().uuid(), path: z.enum(paths), body: z.json().optional() }).strict();
const resultSchema = z.object({ id: z.string().uuid(), status: z.number().int().min(200).max(599), body: z.json() }).strict();
const pollSchema = z.object({ sessionId: z.string().uuid(), running: z.array(z.string().uuid()), results: z.array(resultSchema) }).strict();
type Command = z.infer<typeof commandSchema>;
type Result = z.infer<typeof resultSchema>;
type Poll = z.infer<typeof pollSchema>;
type Pending = { command: Command; finish(result?: Result): void };

/** A reconnecting outbound transport, not a durable execution queue. Commands are
 * deduplicated in the SAME worker process. Backend loss never replays an RPC. */
export class WorkerChannel {
  private readonly pending = new Map<string, Map<string, Pending>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private closed = false;

  request<T>(attemptId: string, path: WorkerCommandPath, body?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new RuntimeError(503, "Worker channel is closing."));
    // Match the existing HTTP transport's treatment of optional object fields.
    const command = commandSchema.parse(JSON.parse(JSON.stringify({ id: randomUUID(), path, body })));
    const commands = this.pending.get(attemptId) ?? new Map<string, Pending>();
    this.pending.set(attemptId, commands);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => finish(), timeoutMs);
      timer.unref();
      const finish = (result?: Result) => {
        clearTimeout(timer);
        commands.delete(command.id);
        if (!commands.size) this.pending.delete(attemptId);
        if (!result) reject(new RuntimeError(503, "Worker reply unavailable; inspect persisted state before retrying."));
        else if (result.status >= 200 && result.status < 300) resolve(result.body as T);
        else if (result.status === 409 && path === "/rpc" && (result.body as { error?: { code?: unknown } })?.error?.code === "HISTORY_CHANGED")
          reject(new HistoryCursorError("History changed. Reload to continue."));
        else reject(new RuntimeError(result.status < 500 ? result.status : 503, "Worker request failed; inspect persisted state before retrying."));
      };
      commands.set(command.id, { command, finish });
      this.wake(attemptId);
    });
  }

  async poll(attemptId: string, input: unknown, signal: AbortSignal): Promise<{ commands: Command[] }> {
    const request = pollSchema.parse(input);
    for (const result of request.results) this.pending.get(attemptId)?.get(result.id)?.finish(result);
    const running = new Set(request.running);
    const available = () => [...this.pending.get(attemptId)?.values() ?? []].map(item => item.command).filter(command => !running.has(command.id));
    if (!this.closed && !available().length && !signal.aborted) await new Promise<void>(resolve => {
      const listeners = this.listeners.get(attemptId) ?? new Set<() => void>();
      this.listeners.set(attemptId, listeners);
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        listeners.delete(done);
        if (!listeners.size) this.listeners.delete(attemptId);
        resolve();
      };
      const timer = setTimeout(done, 20_000);
      listeners.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
    if (this.closed) throw new RuntimeError(503, "Worker channel is closing.");
    return { commands: available() };
  }

  private wake(attemptId: string): void { for (const notify of this.listeners.get(attemptId) ?? []) notify(); }

  close(): void {
    this.closed = true;
    for (const commands of this.pending.values()) for (const pending of commands.values()) pending.finish();
    for (const attempt of this.listeners.keys()) this.wake(attempt);
  }
}

export function startWorkerChannel(options: {
  sessionId: string; token: string;
  poll(input: Poll, signal: AbortSignal): Promise<{ commands: Command[] }>;
  fetch(request: Request): Response | Promise<Response>;
}) {
  const stopped = new AbortController();
  const executing = new Map<string, Promise<void>>();
  const completed = new Map<string, Result>();
  let poll: AbortController | undefined;
  const run = async (command: Command) => {
    try {
      const response = await options.fetch(new Request(`http://worker.local${command.path}`, {
        method: command.body === undefined ? "GET" : "POST", signal: stopped.signal,
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
        body: command.body === undefined ? undefined : JSON.stringify(command.body),
      }));
      completed.set(command.id, { id: command.id, status: response.status, body: await response.json() });
    } catch { completed.set(command.id, { id: command.id, status: 503, body: { error: "Worker operation interrupted" } }); }
    finally { executing.delete(command.id); poll?.abort(); }
  };
  const loop = (async () => {
    while (!stopped.signal.aborted) {
      poll = new AbortController();
      const results = [...completed.values()];
      try {
        const reply = await options.poll({ sessionId: options.sessionId, running: [...executing.keys(), ...completed.keys()], results },
          AbortSignal.any([stopped.signal, poll.signal]));
        for (const result of results) completed.delete(result.id);
        for (const command of z.array(commandSchema).parse(reply.commands)) {
          if (!executing.has(command.id) && !completed.has(command.id)) executing.set(command.id, run(command));
        }
      } catch {
        if (!stopped.signal.aborted && !poll.signal.aborted) await delay(1000, undefined, { signal: stopped.signal }).catch(() => {});
      }
    }
  })();
  return { async close() { stopped.abort(); await loop; await Promise.allSettled(executing.values()); } };
}
