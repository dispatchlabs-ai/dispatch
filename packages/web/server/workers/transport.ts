import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import { RuntimeError } from "../runtime.js";

/** Internal JSON transport: no automatic retry of potentially committed mutations. */
export async function workerRequest<T>(origin: string, token: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 60_000, ca?: string): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (ca !== undefined) return verifiedBackendRequest<T>(origin, token, path, body, signal ? AbortSignal.any([signal, timeout]) : timeout, ca);
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
    method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  } catch {
    throw new RuntimeError(503, "Worker transport failed; reconnect to inspect persisted state before retrying.");
  }
  if (!response.ok) {
    // Do not expose internal endpoint URLs, tokens or raw upstream bodies to clients.
    throw new RuntimeError(response.status >= 400 && response.status < 500 ? response.status : 503, "Worker request failed; reconnect to inspect persisted state before retrying.");
  }
  try { return await response.json() as T; }
  catch { throw new RuntimeError(503, "Worker response interrupted or invalid; inspect persisted state before retrying."); }
}

/** Launcher-supplied trust, available before the first authenticated bootstrap. */
export function validateBackendCa(ca: string): void {
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const certificates = ca.match(pattern);
  if (!certificates?.length || ca.replace(pattern, "").trim() || certificates.some(pem => !new X509Certificate(pem).ca))
    throw new Error("Backend trust requires a PEM CA bundle.");
}

function verifiedBackendRequest<T>(origin: string, token: string, path: string, body: unknown, signal: AbortSignal, ca: string): Promise<T> {
  const base = new URL(origin);
  const url = new URL(path, base);
  if (url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password)
    throw new Error("Backend trust requires a same-origin HTTPS request.");
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    // Node HTTPS verifies the requested DNS/IP identity. Trust is request-local,
    // never added to model/MCP connections or the process-global CA set.
    const req = request(url, {
      method: payload === undefined ? "GET" : "POST", agent: false,
      ca, rejectUnauthorized: true, minVersion: "TLSv1.2", signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        ...(payload ? { "Content-Length": payload.length } : {}) },
    }, response => {
      response.on("error", () => reject(new RuntimeError(503, "Worker response interrupted.")));
      const status = response.statusCode ?? 503;
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new RuntimeError(status >= 400 && status < 500 ? status : 503, "Worker request failed; reconnect to inspect persisted state before retrying."));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) req.destroy(new Error("Backend response too large."));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); }
        catch { reject(new RuntimeError(503, "Worker response was not valid JSON.")); }
      });
    });
    req.on("error", () => reject(new RuntimeError(503, "Worker transport failed; reconnect to inspect persisted state before retrying.")));
    req.end(payload);
  });
}
