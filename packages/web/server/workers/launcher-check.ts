// Focused disposable-data qualification for the launcher core, not a Docker or application test.
// Run explicitly: DISPATCH_LAUNCHER_CHECK=disposable npx tsx packages/web/server/workers/launcher-check.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkerLauncher, type ContainerDriver, type ContainerSpec, type LauncherContainer, type LaunchRequest } from "./launcher.js";

if (process.env.DISPATCH_LAUNCHER_CHECK !== "disposable") throw new Error("Set DISPATCH_LAUNCHER_CHECK=disposable to run this isolated check.");

type Method = "create" | "start" | "retire";
class FaultDriver implements ContainerDriver {
  containers = new Map<string, LauncherContainer>();
  nextId = 0;
  calls = { create: 0, start: 0, retire: 0 };
  available = true;
  fault?: { method: Method; timing: "before" | "after" | "delayed" };
  late: Array<() => void> = [];

  async list(installationId: string) {
    if (!this.available) throw new Error("Injected driver unavailable");
    return structuredClone([...this.containers.values()].filter(item => item.installationId === installationId));
  }
  async create(spec: ContainerSpec) {
    await this.effect("create", () => {
      if ([...this.containers.values()].some(item => item.name === spec.name)) return;
      const id = `container-${++this.nextId}`;
      this.containers.set(id, { ...spec, id, state: "created" });
    });
  }
  async start(id: string) {
    await this.effect("start", () => {
      const container = this.containers.get(id);
      if (container) container.state = "running"; // A retired immutable ID cannot execute again.
    });
  }
  async retire(id: string) { await this.effect("retire", () => { this.containers.delete(id); }); }
  private async effect(method: Method, effect: () => void) {
    this.calls[method]++;
    if (!this.available) throw new Error("Injected driver unavailable");
    const fault = this.fault?.method === method ? this.fault : undefined;
    if (fault) this.fault = undefined;
    if (fault?.timing === "delayed") this.late.push(effect);
    if (fault?.timing === "before" || fault?.timing === "delayed") throw new Error(`Injected ${method} timeout`);
    effect();
    if (fault?.timing === "after") throw new Error(`Injected ${method} lost response`);
  }
  flush() { for (const effect of this.late.splice(0)) effect(); }
}

const stateDir = await mkdtemp(join(tmpdir(), "dispatch-launcher-check-"));
const driver = new FaultDriver();
const installationId = "disposable-launcher-check";
const open = () => WorkerLauncher.open({ stateDir, installationId, driver });
const request = (attemptId: string, conversationId = attemptId): LaunchRequest => ({ attemptId, conversationId, storeId: `store:${conversationId}`, configurationRevision: "revision-1" });
let launcher = await open();
const passed: string[] = [];
try {
  assert.equal((await launcher.status()).drainComplete, true);
  await assert.rejects(launcher.ensure(request("blocked")), /drained/);
  await assert.rejects(open(), /already owned/);
  passed.push("new installations are drained; exclusive launcher owner");
  await launcher.undrain();
  await launcher.undrain(); // An acknowledged undrain can itself have a lost response.

  driver.fault = { method: "create", timing: "after" };
  await assert.rejects(launcher.ensure(request("lost-create")), /lost response/);
  assert.equal(driver.containers.size, 1);
  assert.equal(driver.calls.start, 0);
  await launcher.close();
  launcher = await open();
  const recoveredCreate = await launcher.ensure(request("lost-create"));
  assert.equal(recoveredCreate.phase, "running");
  assert.match(recoveredCreate.name, /^dispatch-worker-[a-f0-9]{40}$/);
  assert(recoveredCreate.name.length <= 63);
  assert.equal(driver.calls.create, 1);
  assert.equal(driver.calls.start, 1);
  passed.push("lost create response reconciles same stopped container across reopen");

  await assert.rejects(launcher.ensure({ ...request("lost-create"), configurationRevision: "revision-2" }), /inputs changed/);
  await assert.rejects(launcher.ensure(request("competitor", "lost-create")), /previous executor/);
  await assert.rejects(launcher.ensure({ ...request("other-conversation"), storeId: "store:lost-create" }), /previous executor/);
  const duplicate = await Promise.all([launcher.ensure(request("lost-create")), launcher.ensure(request("lost-create"))]);
  assert.equal(duplicate[0].containerId, duplicate[1].containerId);
  assert.equal(driver.calls.start, 1);
  passed.push("immutable attempt inputs, conversation/store exclusivity and duplicate admission");

  const catalogMismatch = driver.containers.get(recoveredCreate.containerId!)!;
  catalogMismatch.configurationRevision = "unexpected-revision";
  await assert.rejects(launcher.ensure(request("lost-create")), /identity conflict/);
  assert((await launcher.status()).orphanContainerIds.includes(catalogMismatch.id));
  catalogMismatch.configurationRevision = "revision-1";
  passed.push("observed container configuration must match immutable launch inputs");
  catalogMismatch.state = "unknown";
  await assert.rejects(launcher.ensure(request("lost-create")), /state is unknown/);
  assert((await launcher.status()).unresolvedAttempts.includes("lost-create"));
  catalogMismatch.state = "running";
  passed.push("unknown executor state is unresolved, not permission to restart");

  driver.fault = { method: "start", timing: "after" };
  await assert.rejects(launcher.ensure(request("lost-start")), /lost response/);
  const startsAfterLostResponse = driver.calls.start;
  await launcher.close();
  launcher = await open();
  assert.equal((await launcher.reconcile("lost-start")).phase, "running");
  assert.equal(driver.calls.start, startsAfterLostResponse);
  passed.push("lost start response reconciles running ID without another start");

  driver.fault = { method: "start", timing: "delayed" };
  await assert.rejects(launcher.ensure(request("late-start")), /timeout/);
  await assert.rejects(launcher.reconcile("late-start"), /journaled start is unresolved/);
  const unaffected = await launcher.ensure(request("unaffected"));
  await launcher.stop("late-start");
  driver.flush();
  assert.equal(driver.containers.get(unaffected.containerId!)?.state, "running");
  assert.equal([...driver.containers.values()].some(item => item.attemptId === "late-start"), false);
  await assert.rejects(launcher.ensure(request("late-start")), /cannot be restarted/);
  passed.push("uncertain start is not resent; immutable retirement defeats delayed start; other conversation continues");

  driver.fault = { method: "retire", timing: "before" };
  await assert.rejects(launcher.stop("lost-create"), /timeout/);
  await assert.rejects(launcher.ensure(request("replacement", "lost-create")), /previous executor/);
  await launcher.close();
  launcher = await open();
  assert.equal((await launcher.reconcile("lost-create")).phase, "stopped");
  const replacement = await launcher.ensure(request("replacement", "lost-create"));
  assert.notEqual(replacement.containerId, recoveredCreate.containerId);
  assert.notEqual(replacement.name, recoveredCreate.name);
  passed.push("uncertain stop blocks replacement until retirement; replacement has fresh container identity");

  driver.fault = { method: "retire", timing: "after" };
  await assert.rejects(launcher.stop("replacement"), /lost response/);
  assert.equal((await launcher.stop("replacement")).phase, "stopped");
  await assert.rejects(launcher.ensure(request("replacement", "lost-create")), /cannot be restarted/);
  passed.push("lost retirement response and repeated stop retain terminal tombstone");

  await launcher.stop("stop-before-ensure");
  await launcher.close();
  launcher = await open();
  await assert.rejects(launcher.ensure(request("stop-before-ensure")), /cannot be restarted/);
  passed.push("stop arriving before ensure persists an unknown-attempt tombstone");

  driver.fault = { method: "create", timing: "delayed" };
  await assert.rejects(launcher.ensure(request("late-create")), /timeout/);
  await launcher.stop("late-create");
  driver.flush();
  assert.equal([...driver.containers.values()].find(item => item.attemptId === "late-create")?.state, "created");
  assert((await launcher.status()).unresolvedAttempts.includes("late-create"));
  await launcher.stop("late-create");
  assert.equal([...driver.containers.values()].some(item => item.attemptId === "late-create"), false);
  passed.push("late create remains stopped and is discovered/retired rather than resurrected");

  const exited = driver.containers.get(unaffected.containerId!)!;
  exited.state = "exited";
  const startsBeforeExited = driver.calls.start;
  await assert.rejects(launcher.ensure(request("unaffected")), /Exited workers require retirement/);
  assert.equal(driver.calls.start, startsBeforeExited);
  passed.push("exited worker is never automatically restarted");

  driver.available = false;
  const unavailable = await launcher.drain();
  assert.equal(unavailable.drained, true);
  assert.equal(unavailable.driverReachable, false);
  assert.equal(unavailable.drainComplete, false);
  await launcher.close();
  launcher = await open();
  await assert.rejects(launcher.ensure(request("during-drain")), /drained/);
  await assert.rejects(launcher.undrain(), /Resolve all attempts/);
  driver.available = true;
  assert.equal((await launcher.drain()).drainComplete, true);
  passed.push("driver loss cannot certify drain; persisted admission seal survives reopen");

  driver.containers.set("orphan", { ...request("orphan-attempt"), id: "orphan", name: "orphan", installationId, state: "running" });
  const orphanStatus = await launcher.status();
  assert.deepEqual(orphanStatus.orphanContainerIds, ["orphan"]);
  assert.equal(orphanStatus.drainComplete, false);
  assert.equal((await launcher.drain()).drainComplete, true);
  passed.push("installation inventory catches orphan dynamic workers during drain");

  await launcher.close();
  await assert.rejects(WorkerLauncher.open({ stateDir, installationId: "different-installation", driver }), /different installation/);
  launcher = await open();
  assert.equal((await launcher.status()).drainComplete, true);
  passed.push("state directory rejects installation identity changes");

  const originalList = driver.list.bind(driver);
  driver.list = async id => [...await originalList(id), { ...request("foreign"), id: "foreign", name: "foreign", installationId: "another-installation", state: "running" }];
  const retiresBeforeForeign = driver.calls.retire;
  assert.equal((await launcher.drain()).drainComplete, false);
  assert.equal(driver.calls.retire, retiresBeforeForeign);
  driver.list = originalList;
  assert.equal((await launcher.drain()).drainComplete, true);
  passed.push("invalid cross-installation inventory cannot certify drain or retire foreign workers");

  const blocker = new DatabaseSync(join(stateDir, "launcher.sqlite"));
  try {
    blocker.exec("BEGIN EXCLUSIVE");
    await assert.rejects(launcher.undrain(), /journal failed/);
    blocker.exec("ROLLBACK");
    await assert.rejects(launcher.status(), /journal failed/);
  } finally { blocker.close(); }
  await launcher.close();
  launcher = await open();
  assert.equal((await launcher.status()).drainComplete, true);
  passed.push("journal write failure permanently poisons the controller until reopen");

  await launcher.undrain();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalStart = driver.start.bind(driver);
  driver.start = async id => { entered(); await gate; await originalStart(id); };
  const admitted = launcher.ensure(request("close-drain"));
  await started;
  const closing = launcher.close();
  await assert.rejects(launcher.ensure(request("after-close")), /closing/);
  release();
  await admitted;
  await closing;
  launcher = await open();
  assert.equal((await launcher.status()).activeWorkers.length, 1);
  assert.equal((await launcher.drain()).drainComplete, true);
  passed.push("controller close drains admitted operations but does not silently stop workers");

  console.log(JSON.stringify({ scope: "launcher core with injected driver; no Docker, HTTP, Pi execution or deployment exercised", passed }, null, 2));
} finally {
  await launcher.close();
  await rm(stateDir, { recursive: true, force: true });
}
