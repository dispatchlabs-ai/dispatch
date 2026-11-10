import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { sessionState, sessionLifetime as lifetime, sessionRenewal } from "./session-state.js";
import { passwordVerifier } from "./password-verifier.js";

const verify = await passwordVerifier(process.env.DISPATCH_SESSION_AUTH_FILE);
const cookieName = "__Host-dispatch_session";
const state = await sessionState(process.env.DISPATCH_SESSION_STATE_FILE, digest(`${verify.credentialDigest}\0${process.env.DISPATCH_ORIGIN ?? "loopback"}`));
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
const streams = new Map<string, Set<ServerResponse>>();
let unavailable = false;
let serial = Promise.resolve();
const cookie = (response: ServerResponse, token: string) => response.setHeader("set-cookie",
  `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${lifetime / 1000}`);
function revoke(key: string) {
  const active = streams.get(key);
  streams.delete(key);
  for (const stream of active ?? []) stream.end();
}
let attempts: number[] = [];
function redirect(response: ServerResponse, location: string) {
  response.writeHead(303, { location }).end();
}
function linkTarget(value: string | null) {
  // Only the app shell and its link fields are return destinations, never an external URL.
  if (!value?.startsWith("/?")) return "/";
  const url = new URL(value, "https://session.invalid");
  if (url.pathname !== "/") return "/";
  const query = new URLSearchParams();
  for (const field of ["installation", "chat", "key", "title", "context"])
    if (url.searchParams.has(field)) query.set(field, url.searchParams.get(field)!);
  // Retain incomplete links too, so sign-in cannot silently turn one into New conversation.
  return query.size ? `/?${query}` : "/";
}
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function page(response: ServerResponse, message = "", status = 200, signedIn = false, target = "/") {
  const action = `/login?${new URLSearchParams({returnTo: target})}`;
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Web</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#fafafa;color:#171717;font:16px system-ui;min-height:100dvh;display:grid;place-items:center;padding:24px}main{width:100%;max-width:380px;padding:32px;border:1px solid #e5e5e5;border-radius:12px;background:white}h1{font-size:24px;letter-spacing:-.5px;margin:0 0 24px}label{display:block;font-size:14px;margin-top:20px}input,button{width:100%;font:inherit;border-radius:6px;padding:10px 12px}input{margin-top:8px;border:1px solid #d4d4d4;background:white;color:#171717}button{margin-top:24px;border:1px solid #171717;background:#171717;color:white;cursor:pointer}input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #525252;outline-offset:3px}[role=alert]{font-size:14px;color:#b91c1c}a{color:inherit}
</style></head><body><main><h1>${signedIn ? "Signed in" : "Sign in to Web"}</h1>
${message ? `<p role="alert">${message}</p>` : ""}
${signedIn ? `<a href="${escapeHtml(target)}">Open conversations</a><form method="post" action="/logout"><button>Sign out</button></form>` : `<form method="post" action="${escapeHtml(action)}"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>`}
</main></body></html>`);
}
async function durable<T>(operation: () => Promise<T>) {
  try { return await operation(); }
  catch {
    // A failed durable revocation/admission cannot leave usable memory-only auth.
    unavailable = true;
    for (const key of streams.keys()) revoke(key);
    throw new Error("Session authentication unavailable. Inspect private state before restarting.");
  }
}
function loginBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off("data", data); request.off("end", end);
      request.off("error", failed); request.off("aborted", aborted);
      if (error) { request.pause(); reject(error); }
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > 8192) finish(Object.assign(new Error("Sign-in request is too large."), { status: 413 }));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const failed = (error: Error) => finish(error);
    const aborted = () => finish(new Error("Sign-in upload disconnected."));
    const timer = setTimeout(() => finish(Object.assign(new Error("Sign-in upload timed out."), { status: 408 })), 15_000);
    request.on("data", data); request.once("end", end);
    request.once("error", failed); request.once("aborted", aborted);
  });
}
export async function authorize(request: IncomingMessage, response: ServerResponse) {
  // main.ts validates Host/Origin/Fetch Metadata before any upload admission.
  const url = new URL(request.url ?? "/", "https://session.invalid");
  const login = url.pathname === "/login" && request.method === "POST";
  if (login) {
    const target = linkTarget(url.searchParams.get("returnTo"));
    if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded") {
      page(response, "Use the sign-in form.", 415, false, target); return false;
    }
    const time = Date.now();
    // Synchronous admission bounds uploads and credential hashing independently of state I/O.
    attempts = attempts.filter(t => time - t < 60000);
    if (attempts.length >= 6) {
      response.setHeader("retry-after", "60");
      page(response, "Please wait a minute and try again.", 429, false, target); return false;
    }
    attempts.push(time);
    let body: string;
    try { body = await loginBody(request); }
    catch (error) {
      response.setHeader("connection", "close");
      response.once("finish", () => request.destroy());
      page(response, (error as {status?: number}).status === 413 ? "Sign-in request is too large." : "Sign-in upload timed out.",
        (error as {status?: number}).status ?? 400, false, target);
      return false;
    }
    const form = new URLSearchParams(body);
    const username = form.get("username") ?? "", password = form.get("password") ?? "";
    if (!username || !password || !await verify(username, password)) {
      page(response, "Username or password was incorrect.", 401, false, target); return false;
    }
  }
  const operation = serial.then(() => {
    if (unavailable) throw new Error("Session authentication unavailable.");
    // Read current state only after verification; never commit a pre-upload snapshot.
    return authorizeSerial(request, response);
  });
  serial = operation.then(() => {}, () => {});
  return operation;
}
async function authorizeSerial(request: IncomingMessage, response: ServerResponse) {
  // main.ts enforces exact Host/Origin/Fetch Metadata before calling this module.
  const url = new URL(request.url ?? "/", "https://session.invalid");
  const path = url.pathname;
  const target = linkTarget(url.searchParams.get("returnTo"));
  const time = Date.now();
  const saved = await durable(() => state.read());
  let dirty = false;
  for (const [key, expires] of Object.entries(saved.sessions)) if (expires <= time) {
    delete saved.sessions[key]; revoke(key); dirty = true;
  }
  if (dirty) await durable(() => state.write(saved));
  const token = (request.headers.cookie ?? "").split(";").map(v => v.trim())
    .find(v => v.startsWith(cookieName + "="))?.slice(cookieName.length + 1) ?? "";
  const key = digest(token);
  const signedIn = Object.hasOwn(saved.sessions, key);
  if (signedIn && saved.sessions[key] <= time + lifetime - sessionRenewal) {
    saved.sessions[key] = time + lifetime;
    await durable(() => state.write(saved));
    cookie(response, token);
  }
  if (path === "/login" && request.method === "GET") {
    page(response, "", 200, signedIn, target);
    return false;
  }
  if (path === "/login" && request.method === "POST") {
    delete saved.sessions[key];
    const session = randomBytes(32).toString("hex");
    saved.sessions[digest(session)] = time + lifetime;
    await durable(() => state.write(saved));
    revoke(key);
    cookie(response, session);
    redirect(response, target);
    return false;
  }
  if (path === "/logout" && request.method === "POST") {
    delete saved.sessions[key];
    await durable(() => state.write(saved));
    revoke(key);
    response.setHeader("set-cookie", `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    redirect(response, "/login");
    return false;
  }
  if (signedIn) {
    if (request.method === "GET" && /^\/api\/chats\/[^/]+\/events$/.test(path)) {
      const active = streams.get(key) ?? new Set<ServerResponse>();
      streams.set(key, active); active.add(response);
      response.once("close", () => { active.delete(response); if (!active.size) streams.delete(key); });
    }
    return true;
  }
  if (path === "/" && request.method === "GET") redirect(response, `/login?${new URLSearchParams({returnTo: linkTarget(request.url ?? "/")})}`);
  else response.writeHead(401, { "content-type": "application/json" })
    .end(JSON.stringify({ error: "Sign in at /login to continue." }));
  return false;
}

// Re-read durable expiry so sliding renewal never leaves an old SSE expiry timer.
// Observation alone does not renew a session; normal authenticated requests do.
const expiry = setInterval(() => {
  const operation = serial.then(async () => {
    const saved = await durable(() => state.read()), now = Date.now();
    for (const key of streams.keys()) if (!saved.sessions[key] || saved.sessions[key] <= now) revoke(key);
  });
  serial = operation.catch(() => { unavailable = true; for (const key of streams.keys()) revoke(key); });
}, 60_000);
expiry.unref();
