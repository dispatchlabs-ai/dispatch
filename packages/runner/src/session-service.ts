import { createHash, randomUUID } from "node:crypto";
import { execFile, fork } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { loadAgent } from "./definition.js";
import { privateStateDirectory } from "./private-state.js";
import { serviceRequest, type ServiceMetadata } from "./service.js";
import { piDurableVersion } from "./runtime-version.js";

export type SessionEndpoint = { version: 1; socket: string; stateRoot: string; identity: string; pid: number;
  /** Pi Durable loaded by this owner. Absent on owners started before this field existed. */
  piDurable?: string };
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

/** Ask a verified owner to close normally, then wait for its process to go.
 * SIGTERM is the owner's ordinary shutdown: native work is left pending for the
 * next owner, never cancelled; an interrupted unsafe tool call is reported as interrupted. */
async function retireOwner(endpoint: SessionEndpoint) {
  try { process.kill(endpoint.pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  for (let attempt = 0; attempt < 600; attempt++) {
    let alive = true;
    try { process.kill(endpoint.pid, 0); } catch { alive = false; }
    if (!alive) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("The session's owner from an earlier release did not exit within 60 seconds. Nothing was replaced; retry, or inspect its private service.log.");
}

/** Pi Durable loaded by a live owner. Owners started before endpoints recorded it are
 * resolved from their running module; an unresolvable owner counts as another version. */
async function ownerPiDurable(endpoint: SessionEndpoint) {
  if (endpoint.piDurable) return endpoint.piDurable;
  try {
    const args = await new Promise<string>((resolve, reject) => execFile("/bin/ps", ["-o", "args=", "-p", String(endpoint.pid)], (error, out) => error ? reject(error) : resolve(out)));
    const module = args.split(/\s+/).find(part => part.endsWith("/agent-cli.js"));
    if (!module) return;
    return (createRequire(module)("@earendil-works/pi-durable/package.json") as { version: string }).version;
  } catch { return; }
}

/** Close every live session owner under this installation's state root that runs another
 * (or an unrecorded) Pi Durable, so versions never run side by side. Owners with unfinished
 * work are handed to `resume`, which restarts them on the calling launcher. */
export async function closeOtherRuntimeOwners(runtimeRoot: string, resume: (session: string) => void | Promise<void>) {
  const sessions = (await readdir(runtimeRoot, { withFileTypes: true })).filter(entry => entry.isDirectory());
  await Promise.all(sessions.map(async entry => {
    const endpoint = await discoverSessionService(join(runtimeRoot, entry.name)).catch(() => undefined);
    if (!endpoint) return;
    let unfinished: boolean;
    // Liveness first: most retained endpoint files belong to owners that already exited.
    try { unfinished = (await serviceRequest(endpoint.socket, { method: "status" }, { expected: { stateRoot: endpoint.stateRoot, identity: endpoint.identity } })).busy; }
    catch { return; }
    if (await ownerPiDurable(endpoint) === piDurableVersion) return;
    await retireOwner(endpoint);
    if (unfinished) await resume(entry.name);
  }));
}

/** Remove this process's own endpoint record after a deliberate idle exit, so the
 * next client starts the session on whichever release is then selected. */
export async function retireSessionService(endpoint: SessionEndpoint) {
  const path = sessionEndpointFile(endpoint.stateRoot);
  try {
    const saved = JSON.parse(await readFile(path, "utf8")) as SessionEndpoint;
    if (saved.pid === endpoint.pid && saved.identity === endpoint.identity) await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Start or join the selected ordinary session. No prompt crosses this startup
 * boundary, and no uncertain command is resent. */
export async function ensureSessionService(options: { stateRoot: string; identity: string; args: string[] }) {
  await privateStateDirectory(options.stateRoot);
  const release = await lockfile.lock(options.stateRoot, { lockfilePath: join(options.stateRoot, ".service-start.lock"),
    retries: { retries: 30, minTimeout: 100, maxTimeout: 1000 } });
  try {
    const endpoint = await discoverSessionService(options.stateRoot);
    if (endpoint) {
      try {
        const expected = { stateRoot: endpoint.stateRoot, identity: endpoint.identity };
        const info = await serviceRequest(endpoint.socket, { method: "info" }, { expected });
        if (endpoint.identity === options.identity) return { ...endpoint, info };
        // A live owner from another release or host configuration. An owner on
        // another Pi Durable always closes: versions never run side by side.
        // On the same Pi Durable, unfinished work keeps its owner until idle.
        if (await ownerPiDurable(endpoint) === piDurableVersion && (await serviceRequest(endpoint.socket, { method: "status" }, { expected })).busy) {
          process.stderr.write("This session has unfinished work under its earlier definitions; attached to that owner. It follows the selected release once idle.\n");
          return { ...endpoint, info };
        }
        await retireOwner(endpoint);
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
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
