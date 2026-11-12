import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { unlinkSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

/** The Pi Durable this process actually loaded. */
export const piDurableVersion: string = (createRequire(import.meta.url)("@earendil-works/pi-durable/package.json") as { version: string }).version;

export type RuntimeSelection = { piDurable: string };
type Holder = { pid: number; piDurable: string; started: string };

export const runtimeSelectionFile = (runtimeRoot: string) => join(runtimeRoot, ".runtime.json");
const holdersDirectory = (runtimeRoot: string) => join(runtimeRoot, ".runtime-holders");
const interruptedFile = (runtimeRoot: string) => join(runtimeRoot, ".runtime-interrupted.json");

/** Compare two Pi Durable versions by their release numbers. */
export const order = (a: string, b: string) => {
  const parse = (value: string) => value.split("-")[0].split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index++) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) - (y[index] ?? 0);
  return 0;
};
const json = async <T>(path: string): Promise<T | undefined> => {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
};
const replace = async (path: string, value: unknown) => {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(temporary, path);
};
/** Start time and arguments of every process, so a recorded pid is never mistaken for a reused one. */
const processes = () => new Promise<Map<number, { started: string; args: string }>>((resolve, reject) =>
  execFile("/bin/ps", ["-axo", "pid=,lstart=,args="], { maxBuffer: 64 * 1024 * 1024, env: { LC_ALL: "C" } }, (error, out) => {
    if (error) return reject(error);
    const found = new Map<number, { started: string; args: string }>();
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
      if (match) found.set(Number(match[1]), { started: match[2].replace(/\s+/g, " "), args: match[3] });
    }
    resolve(found);
  }));

/** Whether a session owner reports unfinished work. Unknown counts as unfinished, so it is resumed. */
const unfinished = (endpoint: { socket?: string; identity?: string }) => new Promise<boolean>(resolve => {
  if (!endpoint.socket) return resolve(true);
  const outgoing = request({ socketPath: endpoint.socket, path: "/v1/commands", method: "POST", timeout: 5000, headers: { "content-type": "application/json" } }, response => {
    let body = "";
    response.on("data", chunk => { body += chunk; });
    response.on("end", () => { try { resolve(JSON.parse(body).result.busy !== false); } catch { resolve(true); } });
  });
  outgoing.on("error", () => resolve(true));
  outgoing.on("timeout", () => outgoing.destroy());
  outgoing.end(JSON.stringify({ command: { method: "status" }, expected: { identity: endpoint.identity } }));
});

export async function readRuntimeSelection(runtimeRoot: string): Promise<RuntimeSelection | undefined> {
  const value = await json<RuntimeSelection>(runtimeSelectionFile(runtimeRoot));
  if (value && (typeof value.piDurable !== "string" || !/^\d+\.\d+\.\d+/.test(value.piDurable))) throw new Error("Invalid runtime selection file.");
  return value;
}

async function locked<T>(runtimeRoot: string, work: () => Promise<T>) {
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  // A takeover waits up to a minute for other owners to close; later arrivals wait for it.
  const release = await lockfile.lock(runtimeRoot, { lockfilePath: join(runtimeRoot, ".runtime.lock"), retries: { retries: 150, minTimeout: 200, maxTimeout: 1000 } });
  try { return await work(); } finally { await release(); }
}

/** One Pi Durable per state root, decided under one lock. An older runtime refuses.
 * Otherwise every live process of another version that owns stores here (registered
 * holders, and session owners started before holders were recorded) is asked to close
 * normally, and only when all of them are gone does this version become the selection.
 * `hold` registers this process as an owner of stores under the root. `beforeSelect` runs
 * under the same lock once the others have closed and before this version is recorded: it
 * receives the processes of this version that still own stores here; a throw or `false` selects nothing. */
export async function selectRuntime(runtimeRoot: string, options: { hold?: boolean; beforeSelect?: (open: number[]) => Promise<void | false> } = {}) {
  await locked(runtimeRoot, async () => {
    const selected = await readRuntimeSelection(runtimeRoot);
    if (selected && order(piDurableVersion, selected.piDurable) < 0)
      throw new Error(`This state root runs Pi Durable ${selected.piDurable}; this launcher carries ${piDurableVersion}. Use the installed current release. No store was opened.`);
    const running = await processes();
    const close = new Map<number, string | undefined>();
    const endpoints = new Map<string, { socket?: string; identity?: string }>();
    const holders = new Set<number>(), owners = new Set<number>();
    for (const name of await readdir(holdersDirectory(runtimeRoot)).catch(() => [] as string[])) {
      const path = join(holdersDirectory(runtimeRoot), name);
      const holder = await json<Holder>(path).catch(() => undefined);
      if (!holder || running.get(holder.pid)?.started !== holder.started) { await unlink(path).catch(() => {}); continue; }
      holders.add(holder.pid);
      if (holder.piDurable !== piDurableVersion) close.set(holder.pid, undefined);
    }
    for (const entry of await readdir(runtimeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const endpoint = await json<{ pid?: number; socket?: string; identity?: string }>(join(runtimeRoot, entry.name, "service-endpoint.json")).catch(() => undefined);
      const owner = endpoint?.pid === undefined ? undefined : running.get(endpoint.pid);
      const parts = owner?.args.split(/\s+/) ?? [];
      if (!owner || !parts.includes("--session-owner") || parts[parts.indexOf("--session") + 1] !== entry.name) continue;
      endpoints.set(entry.name, endpoint!);
      owners.add(endpoint!.pid!);
      if (close.has(endpoint!.pid!)) { close.set(endpoint!.pid!, entry.name); continue; }
      if (holders.has(endpoint!.pid!)) continue;
      // An owner from before holders were recorded: read the version beside its module.
      let version: string | undefined;
      try { version = (createRequire(parts.find(part => part.endsWith("/agent-cli.js"))!)("@earendil-works/pi-durable/package.json") as { version: string }).version; } catch {}
      if (version !== piDurableVersion) close.set(endpoint!.pid!, entry.name);
    }
    if (close.size) {
      const named = [...close.values()].filter((name): name is string => name !== undefined);
      const sessions = (await Promise.all(named.map(async name => await unfinished(endpoints.get(name)!) ? name : undefined))).filter((name): name is string => name !== undefined);
      // SIGTERM is each owner's ordinary shutdown: native work stays pending, nothing is cancelled.
      for (const pid of close.keys()) try { process.kill(pid, "SIGTERM"); } catch {}
      const alive = () => [...close.keys()].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
      for (let attempt = 0; alive().length && attempt < 600; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      if (alive().length) throw new Error(`Processes ${alive().join(", ")} on another Pi Durable version did not close within 60 seconds. This runtime was not selected and no store was opened.`);
      // Their endpoint records now name no process; remove them so no client waits on a closed owner.
      for (const name of named) await unlink(join(runtimeRoot, name, "service-endpoint.json")).catch(() => {});
      if (sessions.length) await replace(interruptedFile(runtimeRoot), [...new Set([...(await json<string[]>(interruptedFile(runtimeRoot)) ?? []), ...sessions])]);
    }
    if (await options.beforeSelect?.([...new Set([...holders, ...owners])].filter(pid => !close.has(pid) && pid !== process.pid)) === false) return;
    if (selected?.piDurable !== piDurableVersion) await replace(runtimeSelectionFile(runtimeRoot), { piDurable: piDurableVersion });
    if (options.hold && !held.has(runtimeRoot)) {
      const path = join(holdersDirectory(runtimeRoot), `${process.pid}.json`);
      await mkdir(holdersDirectory(runtimeRoot), { recursive: true, mode: 0o700 });
      await replace(path, { pid: process.pid, piDurable: piDurableVersion, started: (await processes()).get(process.pid)!.started } satisfies Holder);
      held.add(runtimeRoot);
      process.once("exit", () => { try { unlinkSync(path); } catch {} });
    }
  });
}
const held = new Set<string>();

/** Sessions whose owners a takeover closed. The caller resumes them on the selected runtime;
 * taking the list is the claim, so each is resumed once. */
export async function takeInterruptedSessions(runtimeRoot: string) {
  return locked(runtimeRoot, async () => {
    const sessions = await json<string[]>(interruptedFile(runtimeRoot)) ?? [];
    await unlink(interruptedFile(runtimeRoot)).catch(() => {});
    return sessions;
  });
}
