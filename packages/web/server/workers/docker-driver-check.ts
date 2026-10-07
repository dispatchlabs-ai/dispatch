// Explicit disposable-Docker qualification; not imported by application entrypoints.
// See the DISPATCH_DOCKER_PROBE_* guards below. Never target an existing service/network.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerContainerDriver } from "./docker-driver.js";
import { WorkerLauncher } from "./launcher.js";

if (process.env.DISPATCH_DOCKER_PROBE_ALLOW !== "disposable") throw new Error("Explicit disposable probe authorization is required.");
const image = process.env.DISPATCH_DOCKER_PROBE_IMAGE!;
const network = process.env.DISPATCH_DOCKER_PROBE_NETWORK!;
if (!network?.startsWith("dispatch-driver-probe-")) throw new Error("Create a dedicated dispatch-driver-probe-* bridge network first.");
const installationId = `dispatch-driver-probe-${randomUUID()}`;
const driver = new DockerContainerDriver({
  installationId, image, network, user: "1000:1000", workingDirectory: "/tmp",
  command: ["sh", "-c", "test ! -e /tmp/dispatch-probe-sentinel || exit 79; touch /tmp/dispatch-probe-sentinel; trap 'exit 0' TERM; while :; do sleep 1; done"],
  memoryBytes: 64 * 1024 * 1024, nanoCpus: 250_000_000, pidsLimit: 32,
  stopGraceSeconds: 2, requestTimeoutMs: 15_000,
  ...(process.env.DISPATCH_DOCKER_SOCKET ? { socketPath: process.env.DISPATCH_DOCKER_SOCKET } : {}),
});
const stateDir = await mkdtemp(join(tmpdir(), "dispatch-docker-probe-"));
let launcher: WorkerLauncher | undefined;
const passed: string[] = [];
try {
  const spec = { installationId, attemptId: "stopped-create", conversationId: "create-only", storeId: "create-only", configurationRevision: "probe-v1", name: `${installationId}-stopped-create` };
  await driver.create(spec);
  let containers = await driver.list(installationId);
  assert.equal(containers.length, 1);
  assert.equal(containers[0].state, "created");
  const stoppedId = containers[0].id;
  await driver.create(spec);
  assert.equal((await driver.list(installationId))[0].id, stoppedId);
  await assert.rejects(driver.create({ ...spec, configurationRevision: "changed-input" }), /different launch identity/);
  await assert.rejects(driver.list("another-installation"), /installation mismatch/);
  const foreign = new DockerContainerDriver({ installationId: "another-installation", image, network, user: "1000:1000", memoryBytes: 64 * 1024 * 1024, nanoCpus: 250_000_000, pidsLimit: 32 });
  await assert.rejects(foreign.retire(stoppedId), /installation mismatch/);
  await driver.start(stoppedId);
  assert.equal((await driver.list(installationId))[0].state, "running");
  await driver.retire(stoppedId);
  await driver.retire(stoppedId);
  await assert.rejects(driver.start(stoppedId), /no longer exists/);
  assert.equal((await driver.list(installationId)).length, 0);
  passed.push("real Engine stopped-only/idempotent create, changed-input rejection, installation boundary and immutable retirement");

  const open = () => WorkerLauncher.open({ stateDir, installationId, driver });
  launcher = await open();
  assert.equal((await launcher.status()).drainComplete, true);
  await launcher.undrain();
  const req = (attemptId: string, conversationId = attemptId) => ({ attemptId, conversationId, storeId: conversationId, configurationRevision: "probe-v1" });
  const first = await launcher.ensure(req("first"));
  const second = await launcher.ensure(req("second"));
  assert.notEqual(first.containerId, second.containerId);
  assert.equal((await launcher.status()).activeWorkers.length, 2);
  await launcher.close();
  launcher = await open();
  assert.equal((await launcher.ensure(req("first"))).containerId, first.containerId);
  await launcher.stop("first");
  assert.equal((await launcher.ensure(req("second"))).containerId, second.containerId);
  const replaced = await launcher.ensure(req("first-replacement", "first"));
  assert.notEqual(replaced.containerId, first.containerId);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await launcher.status()).activeWorkers.length, 2); // Fresh layer did not trip the old sentinel.
  await assert.rejects(launcher.ensure(req("first")), /cannot be restarted/);
  passed.push("two real worker containers; controller reopen; fresh replacement while other worker retains identity");

  assert.equal((await launcher.drain()).drainComplete, true);
  await launcher.close();
  launcher = await open();
  assert.equal((await launcher.status()).drainComplete, true);
  await assert.rejects(launcher.ensure(req("blocked")), /drained/);
  assert.equal((await driver.list(installationId)).length, 0);
  passed.push("real dynamic-worker drain and persisted admission seal");
  console.log(JSON.stringify({ scope: "Docker driver + launcher with harmless shell workers; no Dispatch/Pi/model execution", installationId, image, passed }, null, 2));
} finally {
  await launcher?.close();
  for (const container of await driver.list(installationId)) await driver.retire(container.id);
  assert.equal((await driver.list(installationId)).length, 0, "Probe containers remain; inspect this installation label before proceeding.");
  await rm(stateDir, { recursive: true, force: true });
}
