#!/usr/bin/env node
/** Private coordinator SQLite owner. The root fleet relay supplies run and epoch. */
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { unfinishedStores } from "@dispatch/runner";

const root = "/var/lib/dispatch-fleet";
const arities = new Map([
  ["mintId", [0]], ["conversation", [1]], ["scanConversations", [3]], ["entry", [1, 2]],
  ["findLatestHeadMarker", [2]], ["scanEntries", [3]], ["task", [1]], ["scanTasks", [3]],
  ["submission", [1]], ["scanSubmissions", [3]], ["submissionByRequest", [2]],
  ["findDocument", [2]], ["document", [2]], ["scanDocuments", [3]], ["commit", [1]], ["close", [0]],
]);
const scans = new Set(["scanConversations", "scanEntries", "scanTasks", "scanSubmissions", "scanDocuments"]);
const diagnostic = (error: unknown) => ({ name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) });
type State = { epoch?: number; stores: Map<string, Storage>; pending: Promise<unknown>; transitionError?: unknown };
type Request = { epoch: number; operation: string; args: any[] };
const runs = new Map<string, State>();
let closing = false;

async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o077) throw new Error("Storage directories must be private and root owned.");
}
async function persist(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    const folder = await open(dirname(path), "r");
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
async function execute(run: string, role: string, request: Request, state: State) {
  const assignment = JSON.parse(await readFile(join(root, "assignments", run + ".json"), "utf8"));
  if (!assignment.roles.includes(role) || assignment.fleet?.epoch !== request.epoch) throw new Error("Native store does not belong to the current assignment.");
  const runDirectory = join(root, "native", run);
  await directory(root); await directory(join(root, "native")); await directory(runDirectory);
  const epochFile = join(runDirectory, "epoch.json");
  if (state.epoch === undefined) {
    try {
      const info = await lstat(epochFile);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Invalid storage epoch record.");
      state.epoch = JSON.parse(await readFile(epochFile, "utf8")).epoch;
      if (!Number.isSafeInteger(state.epoch) || state.epoch! < 1) throw new Error("Invalid retained epoch.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state.epoch = 0; }
  }
  if (request.epoch < state.epoch!) throw new Error("Stale ownership epoch.");
  if (state.transitionError) throw state.transitionError;
  if (request.epoch > state.epoch!) {
    state.epoch = request.epoch;
    try {
      for (const store of state.stores.values()) await store.close(context);
      state.stores.clear(); await persist(epochFile, { epoch: request.epoch });
    } catch (error) { state.transitionError = error; throw error; }
  }
  if (request.operation === "close") { await state.stores.get(role)?.close(context); state.stores.delete(role); return; }
  let store = state.stores.get(role);
  if (!store) {
    const location = join(runDirectory, role); await directory(location);
    const path = join(location, "session.sqlite");
    for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      const info = await lstat(candidate).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0)) throw new Error("Native databases must be root-owned regular files without links.");
    }
    store = await openNodeSqliteStorage(path); await chmod(path, 0o600); state.stores.set(role, store);
  }
  if (request.operation === "commit") {
    const batches = request.args[0];
    if (!Array.isArray(batches) || batches.some(batch => !Array.isArray(batch) || !batch.length)) throw new Error("Use native commit batches.");
    const receipts: { index: number; seq: number }[] = [];
    const result = await store.commit(batches, (index, seq) => receipts.push({ index, seq }), context);
    return { receipts, result: { ...result, ...(result.refused !== undefined ? { refused: diagnostic(result.refused) } : {}) } };
  }
  const args = [...request.args];
  if (scans.has(request.operation) && args[2] === null) args[2] = undefined;
  if (request.operation === "findLatestHeadMarker" && args[1] === null) args[1] = undefined;
  return (store[request.operation as keyof Storage] as (...args: any[]) => unknown)(...args, context);
}
async function dispatch(run: string, role: string, request: Request) {
  if (closing) throw new Error("Storage is closing.");
  if (!/^[a-f0-9]{64}$/.test(run) || !/^[a-z][a-z0-9_-]*$/.test(role)
    || !request || Object.keys(request).some(key => !["epoch", "operation", "args"].includes(key))
    || !Number.isSafeInteger(request.epoch) || request.epoch < 1 || !Array.isArray(request.args)
    || !arities.get(request.operation)?.includes(request.args.length)) throw new Error("Invalid native storage request.");
  let state = runs.get(run);
  if (!state) { state = { stores: new Map(), pending: Promise.resolve() }; runs.set(run, state); }
  const operation = state.pending.then(() => execute(run, role, request, state!));
  state.pending = operation.catch(() => {}); return operation;
}

async function idle(run: string) {
  if (closing) throw new Error("Storage is closing.");
  let state = runs.get(run);
  if (!state) { state = { stores: new Map(), pending: Promise.resolve() }; runs.set(run, state); }
  const operation = state.pending.then(async () => {
    const assignment = JSON.parse(await readFile(join(root, "assignments", run + ".json"), "utf8"));
    if (assignment.fleet) throw new Error("Close the worker ownership before inspecting a release change.");
    if (state.transitionError) throw state.transitionError;
    for (const store of state.stores.values()) await store.close(context);
    state.stores.clear();
    return { idle: unfinishedStores(join(root, "native", run)).length === 0 };
  });
  state.pending = operation.catch(() => {});
  return operation;
}
if (process.getuid?.() !== 0) throw new Error("Coordinator storage must run as root.");
const socket = "/run/dispatch-fleet/storage.sock";
await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
if (await lstat(socket).catch(error => { if (error.code !== "ENOENT") throw error; })) {
  await new Promise<void>((accept, reject) => {
    const connection = createConnection(socket);
    connection.once("connect", () => { connection.destroy(); reject(new Error("A storage owner already listens here.")); });
    connection.once("error", error => { if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") accept(); else reject(error); });
  });
  await unlink(socket);
}
const server = createServer(async (incoming, outgoing) => {
  try {
    const match = /^\/storage\/([a-f0-9]{64})\/([a-z][a-z0-9_-]*)$/.exec(incoming.url ?? "");
    const inspection = /^\/idle\/([a-f0-9]{64})$/.exec(incoming.url ?? "");
    if (incoming.method !== "POST" || (!match && !inspection)) throw new Error("Unknown storage endpoint.");
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const result = inspection ? await idle(inspection[1])
      : await dispatch(match![1], match![2], JSON.parse(Buffer.concat(chunks).toString()));
    outgoing.end(JSON.stringify({ ok: true, result }));
  } catch (error) { outgoing.writeHead(409).end(JSON.stringify({ ok: false, error: diagnostic(error) })); }
});
await new Promise<void>(done => server.listen(socket, done)); await chmod(socket, 0o600);
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  if (closing) return; closing = true; server.close();
  void Promise.all([...runs.values()].map(async state => {
    await state.pending; for (const store of state.stores.values()) await store.close(context);
  })).then(() => process.exit(0), () => process.exit(1));
});
