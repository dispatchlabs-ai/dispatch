import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sessionLifetime, sessionState } from "./session-state.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Prove access to this operator's private files before attributing a loopback browser to the socket owner. */
export async function localWebUser(origin: string, installation: string) {
  const binding = digest(JSON.stringify([origin, installation]));
  const directory = join(homedir(), ".local", "state", "dispatch-web", binding);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sessions = await sessionState(join(directory, "sessions.json"), binding);
  const launch = await mkdtemp(join(directory, "launch-"));
  const file = join(launch, "sign-in.html");
  const ticket = randomBytes(32).toString("hex");
  const link = `${origin}/login?ticket=${ticket}`;
  await writeFile(file, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${link}"><a href="${link}">Sign in to Dispatch Web</a>`, { flag: "wx", mode: 0o600 });
  const cookie = `dispatch_local_${binding.slice(0, 16)}`;
  let writes = Promise.resolve();
  return {
    link: pathToFileURL(file).href, directory: launch,
    async authorize(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? "/", origin);
      if (request.method === "GET" && url.pathname === "/login" && url.searchParams.get("ticket") === ticket) {
        const token = randomBytes(32).toString("hex");
        const issue = writes.then(async () => {
          const now = Date.now();
          const state = await sessions.read();
          for (const [key, expiry] of Object.entries(state.sessions)) if (expiry <= now) delete state.sessions[key];
          state.sessions[digest(token)] = now + sessionLifetime;
          await sessions.write(state);
        });
        writes = issue.catch(() => {});
        await issue;
        response.writeHead(303, { location: "/", "referrer-policy": "no-referrer",
          "set-cookie": `${cookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetime / 1000}` }).end();
        return false;
      }
      const token = request.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(cookie + "="))?.slice(cookie.length + 1);
      if (token && (await sessions.read()).sessions[digest(token)] > Date.now()) return true;
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("Open the private sign-in link printed by the Web launcher.");
      return false;
    },
  };
}
