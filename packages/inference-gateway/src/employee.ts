import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { gatewayOrigin } from "./config.js";
import type { GatewayAuthorization } from "./client.js";

const sessionSchema = z.object({
  accessToken: z.string().min(1), expiresAt: z.number(), refreshToken: z.string().min(1), refreshExpiresAt: z.number(),
  credential: z.object({ id: z.string(), principalId: z.string(), clientName: z.string() }).passthrough(),
});
type Session = z.infer<typeof sessionSchema>;
const savedSchema = sessionSchema.extend({ origin: z.string() });
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");

export function employeeCredentialPath(url: string) {
  return join(homedir(), ".config", "dispatch-inference-gateway", `${digest(gatewayOrigin(url))}.json`);
}

async function save(path: string, origin: string, session: Session) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ origin, ...session }), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function locked<T>(path: string, operation: (assertLock: () => void) => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, { realpath: false, stale: 60_000, update: 10_000, retries: { retries: 200, factor: 1, minTimeout: 100, maxTimeout: 100 }, onCompromised: (error) => { compromised = error; } });
  try { return await operation(() => { if (compromised) throw new Error("Credential refresh lock was lost; sign in again"); }); }
  finally { if (!compromised) await release(); }
}

async function authenticationRequest(origin: string, path: string, body: object, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Gateway sign-in failed (${response.status}); sign in again if the credential expired or was revoked`);
  return response.json();
}

/** Renewable employee authentication for native Pi clients and token-helper processes. */
export function employeeGatewayAuthorization(url: string, path = employeeCredentialPath(url)): GatewayAuthorization {
  const origin = gatewayOrigin(url);
  return async ({ forceRefresh = false, signal } = {}) => locked(path, async (assertLock) => {
    signal?.throwIfAborted();
    const current = savedSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (current.origin !== origin) throw new Error("Credential origin mismatch");
    if (!forceRefresh && current.expiresAt > Date.now() + 60_000) return current.accessToken;
    if (current.refreshExpiresAt <= Date.now()) throw new Error("Employee session expired; sign in again");
    const session = sessionSchema.parse(await authenticationRequest(origin, "/v1/auth/refresh", { refreshToken: current.refreshToken }, signal));
    assertLock();
    await save(path, origin, session);
    return session.accessToken;
  });
}

/** Browser login uses a one-time code and PKCE; access and refresh tokens never enter a URL. */
export async function employeeLogin(url: string, clientName: string, path = employeeCredentialPath(url), notify = (url: string) => process.stderr.write(`Open this address to sign in:\n${url}\n`), openBrowser = true) {
  const origin = gatewayOrigin(url);
  const verifier = randomBytes(32).toString("base64url");
  let expectedFlow: string | undefined;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const received = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // The browser can return while the client awaits authorization setup.
  void received.catch(() => undefined);
  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? "/", "http://127.0.0.1");
    const code = callback.searchParams.get("code");
    if (request.method !== "GET" || callback.pathname !== "/callback" || !expectedFlow || callback.searchParams.get("state") !== expectedFlow || !code || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
      response.writeHead(400, { "content-type": "text/plain" }).end("Invalid sign-in callback"); return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" }).end("<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Signed in</title><style>body{font:18px/1.6 system-ui;max-width:600px;margin:15vh auto;padding:24px;color:#1c2420}h1{font-size:32px}</style><h1>Signed in to the gateway</h1><p>You can close this tab and return to your client.</p></html>");
    resolveCode(code);
  });
  const timeout = setTimeout(() => rejectCode(new Error("Sign-in timed out")), 10 * 60_000);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot start login callback");
    const start = z.object({ flow: z.string(), authorizationUrl: z.url() }).parse(await authenticationRequest(origin, "/v1/auth/start", { clientName, codeChallenge: digest(verifier), redirectUri: `http://127.0.0.1:${address.port}/callback` }));
    if (new URL(start.authorizationUrl).origin !== origin) throw new Error("Unexpected authorization origin");
    expectedFlow = start.flow;
    notify(start.authorizationUrl);
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? undefined : "xdg-open";
    if (openBrowser && opener) { const child = spawn(opener, [start.authorizationUrl], { stdio: "ignore" }); child.on("error", () => {}); child.unref(); }
    const code = await received;
    const session = sessionSchema.parse(await authenticationRequest(origin, "/v1/auth/token", { flow: start.flow, code, codeVerifier: verifier }));
    await locked(path, async (assertLock) => { assertLock(); await save(path, origin, session); });
    return session.credential;
  } finally { clearTimeout(timeout); server.closeAllConnections(); server.close(); }
}

export async function employeeLogout(url: string, path = employeeCredentialPath(url)) {
  const origin = gatewayOrigin(url);
  const token = await employeeGatewayAuthorization(origin, path)();
  await locked(path, async () => {
    const session = savedSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const response = await fetch(`${origin}/v1/credentials/${session.credential.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Gateway logout failed (${response.status}); the local credential was retained for retry`);
    await rm(path);
  });
}
