import { setTimeout as delay } from "node:timers/promises";
import { RuntimeError } from "../runtime.js";
import type { LaunchAttempt, LaunchRequest } from "./launcher.js";

/** One ensure, then only reconciliation of the same durable attempt. Sleep outside
 * the launcher's serialized queue so Stop/drain and other conversations can progress.
 * The observation deadline never authorizes retirement, replacement or a second launch.
 */
export async function awaitWorkerLaunch(
  ensure: (timeoutMs: number) => Promise<LaunchAttempt>,
  reconcile: (timeoutMs: number) => Promise<LaunchAttempt>,
  request: LaunchRequest,
  timeoutMs: number,
  pollMs = 1000,
): Promise<LaunchAttempt> {
  const deadline = performance.now() + timeoutMs;
  let observe = ensure;
  while (performance.now() < deadline) {
    let attempt: LaunchAttempt | undefined;
    try { attempt = await observe(Math.max(1, Math.ceil(deadline - performance.now()))); }
    catch (error) {
      // A lost response or not-yet-visible attempt is ambiguous. Reconcile only;
      // permission/conflict failures must not be hidden behind startup polling.
      if (!(error instanceof RuntimeError) || ![404, 503].includes(error.status)) throw error;
    }
    if (attempt) {
      if (attempt.attemptId !== request.attemptId || attempt.conversationId !== request.conversationId
        || attempt.storeId !== request.storeId || attempt.configurationRevision !== request.configurationRevision)
        throw new RuntimeError(503, "Worker startup identity mismatch.");
      if (attempt.phase === "running") return attempt;
      if (attempt.phase === "stopping" || attempt.phase === "stopped")
        throw new RuntimeError(409, "Worker startup was stopped.");
    }
    observe = reconcile;
    const remaining = deadline - performance.now();
    if (remaining > 0) await delay(Math.min(pollMs, remaining));
  }
  throw new RuntimeError(503, "Worker startup is still unresolved; reconnect to observe the same attempt.");
}
