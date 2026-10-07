import { RuntimeError } from "../runtime.js";

/** Internal JSON transport: no automatic retry of potentially committed mutations. */
export async function workerRequest<T>(origin: string, token: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(60_000);
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    // Do not expose internal endpoint URLs, tokens or raw upstream bodies to clients.
    throw new RuntimeError(response.status >= 400 && response.status < 500 ? response.status : 503, "Worker request failed; reconnect to inspect persisted state before retrying.");
  }
  return await response.json() as T;
}
