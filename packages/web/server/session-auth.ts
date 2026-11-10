import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { passwordVerifier } from "./password-verifier.js";

const verify = await passwordVerifier(process.env.DISPATCH_SESSION_AUTH_FILE);
const cookieName = "__Host-dispatch_session";
const lifetime = 12 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sessions = new Map<string, { expires: number; streams: Set<ServerResponse> }>();
function revoke(key: string) {
  const session = sessions.get(key);
  sessions.delete(key);
  for (const stream of session?.streams ?? []) stream.end();
}
let attempts: number[] = [];
function redirect(response: ServerResponse, location: string) {
  response.writeHead(303, { location }).end();
}
function page(response: ServerResponse, message = "", status = 200, signedIn = false) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Web</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#fafafa;color:#171717;font:16px system-ui;min-height:100dvh;display:grid;place-items:center;padding:24px}main{width:100%;max-width:380px;padding:32px;border:1px solid #e5e5e5;border-radius:12px;background:white}h1{font-size:24px;letter-spacing:-.5px;margin:0 0 24px}label{display:block;font-size:14px;margin-top:20px}input,button{width:100%;font:inherit;border-radius:6px;padding:10px 12px}input{margin-top:8px;border:1px solid #d4d4d4;background:white;color:#171717}button{margin-top:24px;border:1px solid #171717;background:#171717;color:white;cursor:pointer}input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #525252;outline-offset:3px}[role=alert]{font-size:14px;color:#b91c1c}a{color:inherit}
</style></head><body><main><h1>${signedIn ? "Signed in" : "Sign in to Web"}</h1>
${message ? `<p role="alert">${message}</p>` : ""}
${signedIn ? '<a href="/">Open conversations</a><form method="post" action="/logout"><button>Sign out</button></form>' : '<form method="post" action="/login"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>'}
</main></body></html>`);
}
export async function authorize(request: IncomingMessage, response: ServerResponse) {
  // main.ts enforces exact Host/Origin/Fetch Metadata before calling this module.
  const path = new URL(request.url ?? "/", "https://session.invalid").pathname;
  const time = Date.now();
  for (const [key, session] of sessions) if (session.expires <= time) revoke(key);
  const token = (request.headers.cookie ?? "").split(";").map(v => v.trim())
    .find(v => v.startsWith(cookieName + "="))?.slice(cookieName.length + 1) ?? "";
  const key = digest(token);
  const signedIn = sessions.has(key);
  if (path === "/login" && request.method === "GET") {
    page(response, "", 200, signedIn);
    return false;
  }
  if (path === "/login" && request.method === "POST") {
    if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded") {
      page(response, "Use the sign-in form.", 415);
      return false;
    }
    attempts = attempts.filter(t => time - t < 60000);
    if (attempts.length >= 6) {
      response.setHeader("retry-after", "60");
      page(response, "Please wait a minute and try again.", 429);
      return false;
    }
    attempts.push(time);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 8192) {
        page(response, "Sign-in request is too large.", 413);
        return false;
      }
      chunks.push(chunk);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const username = form.get("username") ?? "", password = form.get("password") ?? "";
    if (!username || !password || !await verify(username, password)) {
      page(response, "Username or password was incorrect.", 401);
      return false;
    }
    revoke(key);
    const session = randomBytes(32).toString("hex");
    sessions.set(digest(session), { expires: time + lifetime, streams: new Set() });
    response.setHeader("set-cookie", `${cookieName}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${lifetime / 1000}`);
    redirect(response, "/");
    return false;
  }
  if (path === "/logout" && request.method === "POST") {
    revoke(key);
    response.setHeader("set-cookie", `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    redirect(response, "/login");
    return false;
  }
  if (signedIn) {
    if (request.method === "GET" && /^\/api\/chats\/[^/]+\/events$/.test(path)) {
      const session = sessions.get(key)!;
      session.streams.add(response);
      const expiry = setTimeout(() => revoke(key), session.expires - time);
      expiry.unref();
      response.once("close", () => {
        clearTimeout(expiry);
        session.streams.delete(response);
      });
    }
    return true;
  }
  if (path === "/" && request.method === "GET") redirect(response, "/login");
  else response.writeHead(401, { "content-type": "application/json" })
    .end(JSON.stringify({ error: "Sign in at /login to continue." }));
  return false;
}
