import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { loadAgent } from "./definition.js";
import { privateStateDirectory } from "./private-state.js";
import { serviceRequest, type ServiceMetadata } from "./service.js";

export type SessionEndpoint = { version: 1; socket: string; stateRoot: string; identity: string; pid: number };
export const sessionEndpointFile = (stateRoot: string) => join(stateRoot, "service-endpoint.json");

/** Observation only. Native SQLite locks, not this file, determine ownership. */
export async function discoverSessionService(stateRoot: string): Promise<SessionEndpoint | undefined> {
  const path = sessionEndpointFile(stateRoot);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())
      throw new Error("Session endpoint must be an owned private regular file.");
    const value = JSON.parse(await handle.readFile("utf8")) as SessionEndpoint;
    if (value.version !== 1 || value.stateRoot !== await realpath(stateRoot) || typeof value.socket !== "string" ||
        !value.socket.startsWith("/") || typeof value.identity !== "string" || !value.identity)
      throw new Error("Invalid native session endpoint.");
    return value;
  } finally { await handle.close(); }
}

export async function sessionServiceIdentity(root: string, config: unknown, agent: string) {
  const definitions = new Map<string, string>();
  const include = async (id: string) => {
    if (definitions.has(id)) return;
    const definition = await loadAgent(root, id);
    definitions.set(id, definition.fingerprint);
    for (const recipient of definition.messages ?? []) await include(recipient);
  };
  await include(agent);
  return createHash("sha256").update(JSON.stringify({ root: await realpath(root),
    definitions: [...definitions].sort(([a], [b]) => a.localeCompare(b)), config, node: await realpath(process.execPath),
    runtime: await realpath(new URL("./agent-cli.js", import.meta.url)) })).digest("hex");
}

export async function sessionServiceSocket(stateRoot: string) {
  // Unix socket paths are short even when native state lives in a deep checkout.
  if (process.platform === "win32") throw new Error("Detached session services require POSIX native ownership and Unix sockets.");
  const directory = join(await realpath("/tmp"), `dispatch-${process.getuid?.() ?? "user"}`);
  await privateStateDirectory(directory);
  return join(directory, `${createHash("sha256").update(await realpath(stateRoot)).digest("hex").slice(0, 40)}.sock`);
}

export async function publishSessionService(endpoint: SessionEndpoint) {
  const temporary = join(endpoint.stateRoot, `.service-endpoint-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(endpoint) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, sessionEndpointFile(endpoint.stateRoot));
}

/** Start only the selected ordinary session on this exact executable/release.
 * No prompt crosses this startup boundary, and no uncertain command is resent. */
export async function ensureSessionService(options: { stateRoot: string; identity: string; args: string[]; replaceOwner?: boolean }) {
  await privateStateDirectory(options.stateRoot);
  const release = await lockfile.lock(options.stateRoot, { lockfilePath: join(options.stateRoot, ".service-start.lock"),
    retries: { retries: 30, minTimeout: 100, maxTimeout: 1000 } });
  try {
    const endpoint = await discoverSessionService(options.stateRoot);
    if (endpoint) {
      try {
        const info = await serviceRequest(endpoint.socket, { method: "info" }, { expected: { stateRoot: endpoint.stateRoot, identity: endpoint.identity } });
        if (endpoint.identity !== options.identity) throw new Error("This session belongs to a different runtime, definition release or host configuration. Use its original launcher; no owner was replaced.");
        return { ...endpoint, info };
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        if (endpoint.identity !== options.identity && !options.replaceOwner)
          throw new Error("Saved owner runtime/definition/host selection differs. Use its original launcher, or deliberately select --resume-only --replace-owner after reviewing compatibility and releasing the old owner.");
      }
    }
    const log = await open(join(options.stateRoot, "service.log"), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    const info = await log.stat();
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) {
      await log.close(); throw new Error("Session service log must be an owned private regular file.");
    }
    try {
      const child = fork(new URL("./agent-cli.js", import.meta.url), [...options.args, "--session-owner", "--owner-identity", options.identity], {
        detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"], env: process.env,
      });
      let ready;
      try { ready = await new Promise<SessionEndpoint & { info: ServiceMetadata }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Session owner could not start. Inspect its private service.log; existing native locks were not changed.")));
        child.on("message", value => {
          const message = value as { ready?: SessionEndpoint; error?: string; info: ServiceMetadata };
          if (message.error) reject(new Error(message.error));
          else if (message.ready) resolve({ ...message.ready, info: message.info });
        });
      }); } finally {
        if (child.connected) child.disconnect();
        child.unref();
      }
      return ready;
    } finally { await log.close(); }
  } finally { await release(); }
}
