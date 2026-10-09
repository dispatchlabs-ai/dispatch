// Opt-in Dispatch worker/Pi recovery probe. Real scoped PostgreSQL and stock bash tools;
// scripted upstream faux model, no provider credentials, Docker, or production state.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, escapeLiteral } from "pg";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { DispatchRuntime, type ConversationWorkerBootstrap } from "../runtime.js";
import { AttachmentStore } from "../attachments.js";
import { WorkerStoreProvisioner, type WorkerStoreConfig } from "./postgres-stores.js";

if (process.env.DISPATCH_RECOVERY_PROBE_ALLOW !== "disposable") throw new Error("Disposable authorization required.");
const postgres = process.env.DISPATCH_RUNTIME_PROBE_POSTGRES_BIN;
if (!postgres?.startsWith("/")) throw new Error("Absolute PostgreSQL bin directory required.");
const mode = process.env.DISPATCH_RECOVERY_PROBE_MODE ?? "orderly";
assert(mode === "orderly" || mode === "sigkill", "Expected orderly or sigkill recovery mode.");
const crash = mode === "sigkill";
const childConfig = process.argv[2] === "--crash-child"
  ? JSON.parse(await readFile(process.argv[3], "utf8")) as { root: string; bootstrap: ConversationWorkerBootstrap; storage: WorkerStoreConfig } : undefined;
const root = childConfig?.root ?? await mkdtemp(join(tmpdir(), "dispatch-worker-recovery-"));
const workspaceDir = join(root, "workspace");
const stateDir = join(workspaceDir, "state");
const effects = join(root, "effects"); // Independent of the disposable worker workspace/transcript.
const pidFile = join(root, "tool-pid");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const scope = { companyId: "recovery-probe", userId: "probe-human" };
const person = { id: scope.userId, name: "Recovery Probe" };
const faux = fauxProvider();
const models = createModels(); models.setProvider(faux.provider);
const common = { companyId: scope.companyId, models, provider: "faux", modelId: "faux-1", workspaceDir,
  peopleDirectory: { list: async () => [person], get: async () => person } };
const runPg = (name: string, args: string[]) => execFileSync(join(postgres!, name), args, { stdio: "pipe" });
const waitFor = async (description: string, predicate: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(20);
  }
};
const absent = async (file: string) => {
  try { await readFile(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
};
const toolResults = (input: TranscriptContext) => input.messages.filter(message => message.role === "toolResult");
let directory: DispatchRuntime | undefined;
let worker: DispatchRuntime | undefined;
let provisioner: WorkerStoreProvisioner | undefined;
let admin: Client | undefined;
let pgStarted = false;
let recoveredInput: TranscriptContext | undefined;
let completedResultObserved = false;
let child: ChildProcess | undefined;
let toolPid: number | undefined;
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
};
const killTool = () => {
  if (toolPid !== undefined) {
    assert(Number.isSafeInteger(toolPid) && toolPid > 1);
    if (alive(toolPid)) process.kill(-toolPid, "SIGKILL");
  }
};
const recoveryResponse = (input: TranscriptContext) => { recoveredInput = structuredClone(input); return fauxAssistantMessage("RECOVERY_PROBE_DONE"); };
const initialResponses = (): Parameters<typeof faux.setResponses>[0] => [
  fauxAssistantMessage(fauxToolCall("bash", { command: `printf 'completed\\n' >> ${quote(effects)}; printf 'committed-result-marker\\n'; printf 'local-only' > local-only.txt` }, { id: "completed-call" }), { stopReason: "toolUse" }),
  input => {
    const result = toolResults(input).find(result => result.toolCallId === "completed-call");
    assert(result && !result.isError && JSON.stringify(result.content).includes("committed-result-marker"));
    completedResultObserved = true;
    return fauxAssistantMessage(fauxToolCall("bash", { command: `printf 'interrupted\\n' >> ${quote(effects)}; printf '%s' "$$" > ${quote(pidFile)}; exec sleep 120` }, { id: "interrupted-call" }), { stopReason: "toolUse" });
  },
  recoveryResponse,
];
if (childConfig) {
  assert(crash);
  faux.setResponses(initialResponses());
  worker = await DispatchRuntime.openConversation({ ...common, stateDir, attachmentStore: new AttachmentStore(join(root, "artifacts")), piStorage: childConfig.storage }, childConfig.bootstrap);
  const binding = await worker.workerBinding();
  await writeFile(join(root, "child-binding.json"), JSON.stringify(binding), { mode: 0o600 });
  await worker.submit(scope, binding.roomId, { requestId: "recovery-message", text: "Run the two harmless probe commands, then report recovery." });
  // Keep the owner alive until the parent kills it; no graceful shutdown handler.
  await new Promise(() => { setInterval(() => {}, 1000); });
}
try {
  await mkdir(workspaceDir);
  const password = randomBytes(24).toString("hex");
  const pwfile = join(root, "password"); await writeFile(pwfile, password, { mode: 0o600 });
  runPg("initdb", ["-D", join(root, "postgres"), "--username=probe", `--pwfile=${pwfile}`, "--auth=scram-sha-256", "--no-locale"]);
  runPg("pg_ctl", ["-D", join(root, "postgres"), "-l", join(root, "postgres.log"), "-o", "-h 127.0.0.1 -p 55498 -k ''", "-w", "start"]);
  pgStarted = true;
  const url = new URL(`postgresql://probe:${password}@127.0.0.1:55498/postgres`);
  admin = new Client({ connectionString: url.toString() }); await admin.connect();
  await admin.query(`CREATE ROLE provisioner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
  await admin.query("CREATE DATABASE recovery_probe OWNER provisioner");
  url.username = "provisioner"; url.pathname = "/recovery_probe";
  provisioner = await WorkerStoreProvisioner.open({ connectionString: url.toString(), installationId: "recovery-probe", credentialKey: randomBytes(32).toString("base64url") });
  directory = await DispatchRuntime.open({ ...common, stateDir: join(root, "directory"), directoryOnly: true });
  const chat = await directory.createChat(scope, { requestId: "recovery-room", agentDefinitionIds: ["developer"] });
  const bootstrap: ConversationWorkerBootstrap = { conversationKey: chat.conversation.id, storeId: `recovery:${randomUUID()}`,
    ...await directory.directoryChatBootstrap(scope, chat.conversation.id), ...await directory.directoryWorkerBootstrap(scope.companyId, chat.conversation.id) };
  const options = { ...common, stateDir, attachmentStore: new AttachmentStore(join(root, "artifacts")), piStorage: await provisioner.ensure(bootstrap.storeId) };
  let binding: Awaited<ReturnType<DispatchRuntime["workerBinding"]>>;
  if (crash) {
    const filename = join(root, "child-config.json");
    await writeFile(filename, JSON.stringify({ root, bootstrap, storage: options.piStorage }), { mode: 0o600 });
    child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--crash-child", filename], { stdio: "ignore" });
    let spawnError: Error | undefined;
    child.once("error", error => { spawnError = error; });
    // The second command can only start after the child asserts observation of the committed first result.
    await waitFor("child second tool invocation", async () => {
      if (spawnError) throw spawnError;
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error("Recovery child exited before interruption.");
      return !await absent(pidFile);
    });
    binding = JSON.parse(await readFile(join(root, "child-binding.json"), "utf8"));
    toolPid = Number(await readFile(pidFile, "utf8"));
    assert(Number.isSafeInteger(toolPid) && toolPid > 1);
    const exited = once(child, "exit");
    assert(child.kill("SIGKILL"));
    const [code, signal] = await exited;
    assert.equal(code, null); assert.equal(signal, "SIGKILL");
    assert(!alive(child.pid!));
    // A process crash is not a container/cgroup fence: stock bash has its own process group.
    // Explicitly retire that known probe tool before any replacement is permitted to open.
    killTool();
    faux.setResponses([recoveryResponse]);
  } else {
    faux.setResponses(initialResponses());
    worker = await DispatchRuntime.openConversation(options, bootstrap);
    binding = await worker.workerBinding();
    await worker.submit(scope, binding.roomId, { requestId: "recovery-message", text: "Run the two harmless probe commands, then report recovery." });
    await waitFor("second tool invocation", async () => !await absent(pidFile));
    toolPid = Number(await readFile(pidFile, "utf8"));
    assert(Number.isSafeInteger(toolPid) && toolPid > 1);
    assert(completedResultObserved);
    assert.equal(recoveredInput, undefined);
    await worker.close(); worker = undefined; // Harness.close(), never user-facing Stop.
  }
  await waitFor("old tool process termination", () => !alive(toolPid!));
  toolPid = undefined; await rm(pidFile); // Do not retain a retired PID for later cleanup.
  assert.equal(await readFile(effects, "utf8"), "completed\ninterrupted\n");
  await rm(workspaceDir, { recursive: true }); await mkdir(workspaceDir);
  assert(await absent(join(workspaceDir, "local-only.txt")));
  worker = await DispatchRuntime.openConversation(options, bootstrap);
  await waitFor("resumed model input", () => recoveredInput !== undefined);
  const recovered = recoveredInput!;
  const results = toolResults(recovered);
  const completed = results.find(result => result.toolCallId === "completed-call");
  const interrupted = results.find(result => result.toolCallId === "interrupted-call");
  assert(completed && !completed.isError && JSON.stringify(completed.content).includes("committed-result-marker"));
  assert(interrupted?.isError && JSON.stringify(interrupted.content).includes("interrupted"));
  const sections = Object.assign({}, ...recovered.messages.filter(message => message.role === "system").map(message => message.sections ?? {})) as Record<string, string | null>;
  assert(sections["worker-workspace"]?.includes("NOT restored"));
  assert(sections["worker-workspace"]?.includes("Do not blindly repeat"));
  await waitFor("public recovered response", async () => (await worker!.getChat(scope, binding.roomId)).messages.some(message => message.text.includes("RECOVERY_PROBE_DONE")));
  const replacement = await worker.workerBinding();
  assert.notEqual(replacement.workspace?.generation, binding.workspace?.generation);
  assert.equal(replacement.workspace?.recovered, true);
  await worker.close(); worker = undefined;
  assert.equal(await readFile(effects, "utf8"), "completed\ninterrupted\n");
  assert(await absent(join(workspaceDir, "local-only.txt")));
  assert.equal(faux.state.callCount, crash ? 1 : 3);
  console.log(JSON.stringify({ scope: `Dispatch worker runtime, real scoped PostgreSQL, stock Pi 1.0.4 bash, scripted faux provider; ${crash ? "worker SIGKILL plus explicit tool retirement, not Docker/cgroup qualification" : "orderly shutdown/reopen, not Docker or hard crash"}`, passed: [
    "Completed bash result committed before second independent invocation began",
    crash ? "Worker exited by SIGKILL without Harness.close; known tool group explicitly killed and absence verified before replacement" : "Harness.close terminated the old tool process before replacement opened",
    "Committed result reused; independent effect count stayed one",
    "Interrupted unsafe bash was not replayed; error reached resumed model; independent invocation count stayed one",
    "Replacement used fresh workspace bytes; lost file was not silently restored or recreated",
    "Fresh-workspace notice was in the first resumed model input, before its response",
    "Recovered response reached the public Dispatch chat snapshot",
  ], completedEffects: 1, interruptedInvocations: 1, replacementModelRequests: crash ? faux.state.callCount : 1 }, null, 2));
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  if (!toolPid && !await absent(pidFile)) toolPid = Number(await readFile(pidFile, "utf8"));
  killTool();
  if (toolPid) await waitFor("probe tool cleanup", () => !alive(toolPid!));
  await worker?.close(); await directory?.close(); await provisioner?.close(); await admin?.end();
  if (pgStarted) runPg("pg_ctl", ["-D", join(root, "postgres"), "-m", "fast", "-w", "stop"]);
  await rm(root, { recursive: true, force: true });
}
