import { setTimeout as delay } from "node:timers/promises";

/** In-memory HTTP barrier only. Never stores/replays a dispatched request. Ownership
 * and recovery remain with the rendezvous and the underlying application stores. */
export class ControllerDispatch {
  private retiring = false;
  private failed = false;
  private requests = 0;
  private waiting = 0;
  private idle: Array<() => void> = [];
  private streams = new Set<AbortController>();

  constructor(private readonly waitMs = 30_000, private readonly maxWaiting = 256) {}
  get holding() { return this.retiring && !this.failed; }
  get available() { return !this.failed; }
  get waitingAvailable() { return !this.failed && this.waiting < this.maxWaiting; }
  fail() { this.failed = true; }

  /** Wait for a natural request-idle boundary BEFORE sealing local dispatch.
   * A long committed mutation is allowed to finish; no shutdown deadline or abort
   * is interpreted as proof its effects stopped. SSE is closed for reconnect. */
  async retire(): Promise<void> {
    if (this.requests) await new Promise<void>(resolve => this.idle.push(resolve));
    this.retiring = true;
    for (const stream of this.streams) stream.abort();
  }

  tryRun(request: Request, dispatch: (request: Request) => Promise<Response>): Promise<Response> | undefined {
    if (this.retiring || this.failed) return undefined;
    return this.run(request, dispatch);
  }

  async run(request: Request, dispatch: (request: Request) => Promise<Response>): Promise<Response> {
    if (this.retiring || this.failed) throw new Error("Local controller is retiring.");
    const streamAbort = new AbortController();
    const forwarded = new Request(request, { signal: AbortSignal.any([request.signal, streamAbort.signal]) });
    this.requests++;
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      this.requests--;
      if (!this.requests) {
        if (this.idle.length) this.retiring = true;
        for (const resolve of this.idle.splice(0)) resolve();
      }
    };
    let response: Response;
    try { response = await dispatch(forwarded); }
    catch (error) { release(); throw error; }
    const streaming = response.headers.get("Content-Type")?.startsWith("text/event-stream");
    if (streaming) {
      this.streams.add(streamAbort);
      release();
      if (this.retiring) streamAbort.abort();
    }
    if (response.body) {
      const reader = response.body.getReader();
      const remove = () => { this.streams.delete(streamAbort); release(); };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { remove(); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) { remove(); controller.error(error); }
        },
        async cancel(reason) {
          streamAbort.abort();
          try { await reader.cancel(reason); } finally { remove(); }
        },
      });
      return new Response(body, response);
    }
    this.streams.delete(streamAbort);
    release();
    return response;
  }

  /** Only a request whose body has not been dispatched can wait for activation.
   * The predicate must return the currently verified owner, never a timeout guess. */
  async wait<T>(signal: AbortSignal, target: (signal: AbortSignal) => Promise<T | undefined>): Promise<T> {
    if (this.failed || this.waiting >= this.maxWaiting) throw new Error("Controller waiting capacity unavailable.");
    this.waiting++;
    const timeout = AbortSignal.timeout(this.waitMs);
    const cancellation = AbortSignal.any([signal, timeout]);
    try {
      while (!cancellation.aborted && !this.failed) {
        cancellation.throwIfAborted();
        let abort!: () => void;
        const interrupted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("Controller activation wait cancelled."));
          cancellation.addEventListener("abort", abort, { once: true });
          if (cancellation.aborted) abort();
        });
        let owner: T | undefined;
        try { owner = await Promise.race([target(cancellation), interrupted]); }
        finally { cancellation.removeEventListener("abort", abort); }
        if (cancellation.aborted || this.failed) break;
        if (owner !== undefined) return owner;
        await delay(100, undefined, { signal: cancellation });
      }
      throw new Error("Controller activation wait expired.");
    } catch {
      // An unavailable wait path is not rollout readiness.
      if (timeout.aborted) this.failed = true;
      throw new Error("Controller activation wait unavailable.");
    } finally { this.waiting--; }
  }
}
