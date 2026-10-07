import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WorkerLauncher, type ContainerDriver } from "./launcher.js";
import { createLauncherControl } from "./control.js";
import { WriteAdmission } from "./admission.js";

if (process.env.DISPATCH_WORKER_CHECK_ALLOW !== "disposable") throw new Error("Set DISPATCH_WORKER_CHECK_ALLOW=disposable.");
const directory = await mkdtemp(join(tmpdir(), "dispatch-control-check-"));
const driver: ContainerDriver = {
  list: async () => [], create: async () => { throw new Error("Not exercised"); },
  start: async () => { throw new Error("Not exercised"); }, retire: async () => { throw new Error("Not exercised"); },
};
const launcher = await WorkerLauncher.open({ stateDir: directory, installationId: "control-check", driver });
try {
  const token = randomBytes(32).toString("base64url");
  const app = createLauncherControl(launcher, token);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  assert.equal((await app.request("/v1/status")).status, 401);
  assert.equal((await app.request("/v1/status", { headers: { ...headers, Origin: "https://example.invalid" } })).status, 401);
  const status = await app.request("/v1/status", { headers });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal((await status.json()).drainComplete, true);
  assert.equal((await app.request("/v1/ensure", { method: "POST", headers, body: JSON.stringify({ attemptId: "a", command: ["arbitrary"] }) })).status, 400);
  assert.equal((await app.request("/v1/ensure", { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await app.request("/v1/ensure", { method: "POST", headers, body: "x".repeat(9000) })).status, 413);
  assert.equal((await app.request("/v1/undrain", { method: "POST", headers })).status, 200);
  assert.equal((await app.request("/v1/drain", { method: "POST", headers })).status, 200);

  let release!: () => void;
  let persisted = false;
  const admission = new WriteAdmission(false, async value => { persisted = value; });
  const write = admission.run(() => new Promise<void>(resolve => { release = resolve; }));
  const barrier = admission.quiesce();
  assert.equal(admission.admitting, false);
  assert.equal(admission.quiesced, false);
  await assert.rejects(admission.run(async () => {}));
  release(); await write; await barrier;
  assert.equal(persisted, true); assert.equal(admission.quiesced, true);
  await admission.resume(); assert.equal(admission.admitting, true);

  let finishPersist!: () => void;
  const raced = new WriteAdmission(true, async blocked => {
    if (!blocked) await new Promise<void>(resolve => { finishPersist = resolve; });
  });
  const resume = raced.resume();
  await Promise.resolve();
  const drain = raced.quiesce();
  finishPersist(); await resume;
  assert.equal(raced.admitting, false);
  await drain; assert.equal(raced.quiesced, true);
  console.log(JSON.stringify({ passed: true, scope: "in-process authenticated control and admission barrier; not deployed backend quiescence" }));
} finally { await launcher.close(); await rm(directory, { recursive: true, force: true }); }
