// Disposable distributed-runtime ordering qualification: real Pi directory/workers,
// scoped PostgreSQL, loopback HTTP and a launcher lifecycle double (not Docker).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { Client, escapeLiteral } from "pg";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { DispatchRuntime } from "../runtime.js";
import { AttachmentStore } from "../attachments.js";
import { distributedRuntime } from "./distributed.js";
import { WorkerRoutes } from "./routes.js";
import { WorkerStoreProvisioner } from "./postgres-stores.js";
import { McpPolicyGate } from "./mcp-policy.js";
import { tokenMatches, workerToken } from "./identity.js";
import type { LaunchAttempt, LauncherStatus } from "./launcher.js";

if (process.env.DISPATCH_DISTRIBUTED_POLICY_CHECK !== "disposable") throw new Error("Disposable authorization required.");
const postgres = process.env.DISPATCH_RUNTIME_PROBE_POSTGRES_BIN;
if (!postgres?.startsWith("/")) throw new Error("Absolute PostgreSQL bin directory required.");
const root = await mkdtemp(join(tmpdir(), "dispatch-policy-"));
const workspaceDir = join(root, "workspace"); await mkdir(workspaceDir);
const scope = { companyId: "policy-probe", userId: "creator" };
const reader = { ...scope, userId: "reader" };
const people = [{ id: scope.userId, name: "Creator" }, { id: reader.userId, name: "Reader" }];
const models = createModels(); models.setProvider(fauxProvider().provider);
const common = { companyId: scope.companyId, models, provider: "faux", modelId: "faux-1", workspaceDir,
  peopleDirectory: { list: async () => people, get: async (_company: string, id: string) => people.find(person => person.id === id) ?? null } };
const installationId = "policy-probe", workerKey = randomBytes(32).toString("base64url"), launcherToken = randomBytes(32).toString("base64url");
const runPg = (name: string, args: string[]) => execFileSync(join(postgres!, name), args, { stdio: "pipe" });
const waitFor = async (description: string, predicate: () => boolean) => {
  const deadline = Date.now() + 20_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await delay(10); }
};
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
let directory: DispatchRuntime | undefined, routes: WorkerRoutes | undefined, provisioner: WorkerStoreProvisioner | undefined;
let admin: Client | undefined, server: ServerType | undefined, pgStarted = false;
const nativeFetch = globalThis.fetch;
const workers = new Map<string, { runtime: DispatchRuntime; roomId: string; tail: Promise<unknown> }>();
const attempts = new Map<string, LaunchAttempt>();
const tombstones = new Set<string>();
const held = new Set<ReturnType<typeof latch>>();
let starting: ReturnType<typeof latch> | undefined, rpcHold: ReturnType<typeof latch> | undefined;
let ensureEntered = false, rpcEntered = 0, syncs = 0, stops = 0, failSync = false, failStop = false;
const passed: string[] = [];
try {
  const password = randomBytes(24).toString("hex"), pwfile = join(root, "password");
  await writeFile(pwfile, password, { mode: 0o600 });
  runPg("initdb", ["-D", join(root, "postgres"), "--username=probe", `--pwfile=${pwfile}`, "--auth=scram-sha-256", "--no-locale"]);
  runPg("pg_ctl", ["-D", join(root, "postgres"), "-l", join(root, "postgres.log"), "-o", "-h 127.0.0.1 -p 55501 -k ''", "-w", "start"]); pgStarted = true;
  const url = new URL(`postgresql://probe:${password}@127.0.0.1:55501/postgres`);
  admin = new Client({ connectionString: url.toString() }); await admin.connect();
  await admin.query(`CREATE ROLE provisioner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
  await admin.query("CREATE DATABASE policy_probe OWNER provisioner"); url.username = "provisioner"; url.pathname = "/policy_probe";
  provisioner = await WorkerStoreProvisioner.open({ connectionString: url.toString(), installationId, credentialKey: workerKey });
  directory = await DispatchRuntime.open({ ...common, stateDir: join(root, "directory"), directoryOnly: true });
  routes = await WorkerRoutes.open(join(root, "routes"), installationId);
  const app = new Hono();
  app.use("/v1/*", async (c, next) => { assert(tokenMatches(launcherToken, c.req.header("Authorization"))); await next(); });
  app.get("/v1/status", c => c.json({ installationId, driverReachable: true, drained: false, drainComplete: false,
    attempts: [...attempts.values()].map(attempt => ({ ...attempt, observed: attempt.phase === "stopped" ? "absent" : "running" })),
    containers: [], activeWorkers: [], unresolvedAttempts: [], orphanContainerIds: [],
  } satisfies LauncherStatus));
  app.post("/v1/ensure", async c => {
    const input = await c.req.json();
    if (starting && !attempts.has(input.attemptId)) { ensureEntered = true; await starting.promise; }
    if (tombstones.has(input.attemptId)) return c.json({ error: "Stopped attempt" }, 409);
    let attempt = attempts.get(input.attemptId);
    if (!attempt) {
      const route = routes!.get(input.conversationId)!;
      attempt = { ...input, name: `dispatch-worker-${input.attemptId.replaceAll("-", "")}`, phase: "running" };
      attempts.set(input.attemptId, attempt!);
      const runtime = await DispatchRuntime.openConversation({ ...common, stateDir: join(root, input.attemptId),
        piStorage: await provisioner!.ensure(route.storeId), attachmentStore: new AttachmentStore(join(root, "artifacts")),
      }, { conversationKey: route.conversationId, storeId: route.storeId,
        ...await directory!.directoryChatBootstrap(scope, route.conversationId), ...await directory!.directoryWorkerBootstrap(scope.companyId, route.conversationId) });
      workers.set(attempt!.name, { runtime, roomId: (await runtime.workerBinding()).roomId, tail: Promise.resolve() });
    }
    return c.json(attempt!);
  });
  app.post("/v1/stop", async c => {
    const { attemptId } = await c.req.json(); stops++;
    if (failStop) return c.json({ error: "Unresolved retirement" }, 503);
    tombstones.add(attemptId);
    const attempt = attempts.get(attemptId);
    if (attempt) {
      const worker = workers.get(attempt.name); await worker?.runtime.close(); workers.delete(attempt.name);
      attempt.phase = "stopped";
    }
    return c.json({ attemptId, phase: "stopped" });
  });
  app.all("/worker/:name/:operation", async c => {
    const attempt = [...attempts.values()].find(item => item.name === c.req.param("name"))!;
    const route = routes!.get(attempt.conversationId)!;
    assert(tokenMatches(workerToken(workerKey, installationId, route), c.req.header("Authorization")));
    const worker = workers.get(attempt.name)!;
    const operation = c.req.param("operation");
    if (operation === "ready") return c.json({ roomId: worker.roomId, conversationId: attempt.conversationId, attemptId: attempt.attemptId });
    const body = await c.req.json();
    const work = worker.tail.then(async () => {
      if (operation === "sync") { syncs++; if (failSync) return c.json({ error: "Missing acknowledgement" }, 503); }
      else { rpcEntered++; if (rpcHold) await rpcHold.promise; }
      await worker.runtime.applyWorkerCatalog(body.catalog);
      await worker.runtime.applyWorkerMembership(body.membership);
      if (operation === "sync") return c.json({ revision: body.catalog.revision, membershipRevision: body.membership.revision });
      assert.equal(body.method, "getChat");
      return c.json({ result: await worker.runtime.getChat(body.scope, worker.roomId) });
    });
    worker.tail = work.catch(() => {});
    return work;
  });
  app.onError((_error, c) => c.json({ error: "Denied" }, 403));
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server!.listening ? resolve() : server!.once("listening", resolve));
  const address = server.address(); assert(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}`;
  // Substitute only internal DNS; every request still crosses an actual HTTP socket.
  globalThis.fetch = ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return nativeFetch(url.hostname.startsWith("dispatch-worker-") ? `${origin}/worker/${url.hostname}${url.pathname}` : input, init);
  }) as typeof fetch;
  const mcpGate = new McpPolicyGate(); let transitions = 0;
  const runtime = distributedRuntime({ directory, routes, installationId, workerKey, launcherToken, launcherUrl: origin, configurationRevision: "probe",
    runBackground: operation => operation(), runPolicyChange: operation => mcpGate.change(async () => { transitions++; return operation(); }) });
  let project = await directory.createProject(scope, { requestId: "project", name: "Policy probe", kind: "shared" });
  const projectMembers = (withReader: boolean) => [{ userId: scope.userId, role: "manager" as const }, ...(withReader ? [{ userId: reader.userId, role: "member" as const }] : [])];
  const change = (withReader: boolean, requestId: string) => runtime.saveProject(scope, project.id,
    { requestId, expectedRevision: project.revision!, name: project.name, defaultAgentDefinitionIds: ["default"], members: projectMembers(withReader) });
  project = await change(true, "add-reader");
  const a = await runtime.createChat(scope, { requestId: "a", sharedProjectId: project.id });
  const c = await directory.createChat(scope, { requestId: "c", sharedProjectId: project.id });
  starting = latch(); held.add(starting);
  const concurrentStart = runtime.getChat(reader, c.conversation.id);
  await waitFor("startup before launcher inventory", () => ensureEntered);
  await runtime.getChat(reader, a.conversation.id); // A does not wait for independent C.
  const beforeTransitions = transitions, beforeSyncs = syncs;
  let acknowledged = false;
  const revocation = change(false, "revoke-during-start").then(value => { acknowledged = true; return value; });
  const lateRead = assert.rejects(runtime.getChat(reader, a.conversation.id));
  await delay(30);
  assert(!acknowledged); assert.equal(transitions, beforeTransitions); assert.equal(syncs, beforeSyncs);
  await directory.getChat(reader, a.conversation.id);
  starting.release(); starting = undefined;
  await concurrentStart; project = await revocation; await lateRead;
  assert(syncs >= beforeSyncs + 2);
  for (const worker of workers.values()) await assert.rejects(worker.runtime.getChat(reader, worker.roomId));
  passed.push("Independent calls stay concurrent; policy waits for a startup absent from old inventory, synchronizes both workers, and denies queued revoked access");

  project = await change(true, "restore-reader");
  rpcHold = latch(); held.add(rpcHold); const beforeRpc = rpcEntered;
  const oldRpc = runtime.getChat(reader, a.conversation.id);
  await waitFor("old RPC before worker catalog application", () => rpcEntered > beforeRpc);
  acknowledged = false;
  const revokeOld = change(false, "revoke-delayed-rpc").then(value => { acknowledged = true; return value; });
  await delay(30); assert(!acknowledged);
  rpcHold.release(); rpcHold = undefined; await oldRpc; project = await revokeOld;
  await assert.rejects(runtime.getChat(reader, a.conversation.id));
  passed.push("A delayed already-admitted RPC settles before policy mutation/acknowledgement; subsequent access cannot use its old projection");

  const mcpHeld = latch(); held.add(mcpHeld);
  const admittedMcp = mcpGate.call(() => mcpHeld.promise);
  const beforeMcp = transitions;
  const mcpTransition = change(true, "wait-for-mcp");
  await delay(30); assert.equal(transitions, beforeMcp);
  await assert.rejects(mcpGate.call(async () => {}));
  mcpHeld.release(); await admittedMcp; project = await mcpTransition;
  passed.push("Distributed policy ordering composes with MCP-call draining without gating reconciliation callbacks");

  const dormant = await directory.createChat(scope, { requestId: "dormant", sharedProjectId: project.id });
  const dormantBoot = await directory.directoryChatBootstrap(scope, dormant.conversation.id);
  const unknown = await routes.ensure(dormant.conversation.id, dormantBoot.scope, dormantBoot.input, "probe");
  project = await change(false, "fence-unknown-ensure");
  assert(tombstones.has(unknown.attemptId));
  assert.notEqual(routes.get(dormant.conversation.id)!.attemptId, unknown.attemptId);
  assert.equal(attempts.size, 2); // No dormant worker launched just to acknowledge policy.
  const delayedEnsure = await nativeFetch(`${origin}/v1/ensure`, { method: "POST", headers: { Authorization: `Bearer ${launcherToken}`, "Content-Type": "application/json" }, body: JSON.stringify(unknown) });
  assert.equal(delayedEnsure.status, 409);
  passed.push("Missing launcher attempt is tombstoned, verified absent and replaced only as dormant intent; delayed old ensure is denied");

  failSync = true; failStop = true;
  await assert.rejects(change(true, "unresolved-stop"));
  assert(stops > 0);
  failSync = false; failStop = false;
  // Identical request receipt is reusable after failed acknowledgement; the ordering
  // queue must not stay wedged or falsely report the earlier failure as success.
  project = await change(true, "unresolved-stop");
  await runtime.getChat(reader, a.conversation.id);
  failSync = true;
  project = await change(false, "retire-unresponsive");
  assert.equal(workers.size, 0);
  passed.push("Unacknowledged/unretired policy returns failure; identical retry recovers, and confirmed retirement is the only fallback to acknowledgement");
  console.log(JSON.stringify({ scope: "Real Pi directory/workers and scoped PostgreSQL over loopback HTTP; launcher lifecycle double, not Docker or deployed entrypoints", passed }, null, 2));
} finally {
  for (const item of held) item.release();
  globalThis.fetch = nativeFetch;
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  for (const worker of workers.values()) await worker.runtime.close();
  await directory?.close(); routes?.close(); await provisioner?.close(); await admin?.end();
  if (pgStarted) runPg("pg_ctl", ["-D", join(root, "postgres"), "-m", "fast", "-w", "stop"]);
  await rm(root, { recursive: true, force: true });
}
