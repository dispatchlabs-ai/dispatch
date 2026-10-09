// Focused opt-in runtime bootstrap check; creates and removes its own SQLite/PostgreSQL state.
// No model requests. Requires PostgreSQL tools supplied through DISPATCH_RUNTIME_PROBE_POSTGRES_BIN.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchRuntime, type ConversationWorkerBootstrap } from "../runtime.js";
import { AttachmentStore } from "../attachments.js";
import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { WorkerStoreProvisioner } from "./postgres-stores.js";
import { PostgresStorage } from "../storage/postgres/storage.js";

if (process.env.DISPATCH_RUNTIME_PROBE_ALLOW !== "disposable") throw new Error("Disposable authorization required.");
const postgres = process.env.DISPATCH_RUNTIME_PROBE_POSTGRES_BIN;
if (!postgres?.startsWith("/")) throw new Error("DISPATCH_RUNTIME_PROBE_POSTGRES_BIN must name an absolute PostgreSQL bin directory.");
const root = await mkdtemp(join(tmpdir(), "dispatch-runtime-worker-"));
const workspaceDir = join(root, "workspace");
await mkdir(workspaceDir);
const scope = { companyId: "probe-company", userId: "probe-user" };
const person = { id: scope.userId, name: "Disposable Probe" };
const peopleDirectory = { list: async () => [person], get: async (company: string, user: string) => company === scope.companyId && user === scope.userId ? person : null };
const common = { companyId: scope.companyId, workspaceDir, peopleDirectory };
const opened = new Set<DispatchRuntime>();
const close = async (runtime: DispatchRuntime) => { await runtime.close(); opened.delete(runtime); };
const tracked = (runtime: DispatchRuntime) => { opened.add(runtime); return runtime; };
const runPg = (name: string, args: string[]) => execFileSync(join(postgres!, name), args, { stdio: "pipe" });
let pgStarted = false;
let provisioner: WorkerStoreProvisioner | undefined;
const sqlClients: Client[] = [];
const connect = async (connectionString: string) => { const client = new Client({ connectionString }); await client.connect(); sqlClients.push(client); return client; };
const passed: string[] = [];
try {
  const nativeOptions = { ...common, stateDir: join(root, "native") };
  let native = tracked(await DispatchRuntime.open(nativeOptions));
  const nativeRoom = await native.createChat(scope, { requestId: "native-room", agentDefinitionIds: [] });
  await native.submit(scope, nativeRoom.conversation.id, { requestId: "native-message", text: "native persistence" });
  await close(native);
  native = tracked(await DispatchRuntime.open(nativeOptions));
  assert((await native.getChat(scope, nativeRoom.conversation.id)).messages.some(item => item.text === "native persistence"));
  await close(native);
  await assert.rejects(DispatchRuntime.open({ ...nativeOptions, directoryOnly: true }), /another runtime mode/);
  passed.push("native SQLite behavior persists; implicit native-to-directory cutover rejected");

  const directoryOptions = { ...common, stateDir: join(root, "directory"), directoryOnly: true };
  let directory = tracked(await DispatchRuntime.open(directoryOptions));
  const initial = await directory.exportWorkerCatalog(scope.companyId);
  assert.equal(initial.revision, (await directory.exportWorkerCatalog(scope.companyId)).revision);
  const directoryRoom = await directory.createChat(scope, { requestId: "directory-room", agentDefinitionIds: ["developer"] });
  assert.equal(directoryRoom.participants.filter(item => item.kind === "agent").length, 0);
  assert.equal(directoryRoom.conversation.agentDefinitionId, "developer");
  await assert.rejects(directory.submit(scope, directoryRoom.conversation.id, { requestId: "forbidden", text: "must not run" }), /routed to its worker/);
  await directory.saveSkill(scope, { requestId: "new-skill", name: "Probe", description: "disposable", instructions: "No effects" });
  const changed = await directory.exportWorkerCatalog(scope.companyId);
  assert(changed.revision > initial.revision);
  await close(directory);
  directory = tracked(await DispatchRuntime.open(directoryOptions));
  const reopened = await directory.exportWorkerCatalog(scope.companyId);
  assert.equal(changed.revision, reopened.revision);
  assert.equal(changed.sourceId, reopened.sourceId);
  passed.push("directory preserves requested-agent metadata without agent participants and rejects execution; export revision survives reopen");

  const pwfile = join(root, "pg-password");
  const password = randomBytes(24).toString("hex");
  await writeFile(pwfile, password, { mode: 0o600 });
  const pgdata = join(root, "postgres");
  runPg("initdb", ["-D", pgdata, "--username=probe", `--pwfile=${pwfile}`, "--auth=scram-sha-256", "--no-locale"]);
  runPg("pg_ctl", ["-D", pgdata, "-l", join(root, "postgres.log"), "-o", "-h 127.0.0.1 -p 55497 -k ''", "-w", "start"]);
  pgStarted = true;
  const connectionString = `postgresql://probe:${password}@127.0.0.1:55497/postgres`;
  const admin = await connect(connectionString);
  await admin.query(`CREATE ROLE provisioner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
  await admin.query("CREATE DATABASE worker_probe OWNER provisioner");
  const provisionerUrl = new URL(connectionString); provisionerUrl.username = "provisioner"; provisionerUrl.pathname = "/worker_probe";
  const provisionerOptions = { connectionString: provisionerUrl.toString(), installationId: "disposable-runtime-probe", credentialKey: randomBytes(32).toString("base64url") };
  provisioner = await WorkerStoreProvisioner.open(provisionerOptions);
  await admin.query("CREATE DATABASE native_probe OWNER provisioner");
  const nativePgUrl = new URL(provisionerUrl); nativePgUrl.pathname = "/native_probe";
  const nativePg = await PostgresStorage.open({ connectionString: nativePgUrl.toString(), storeId: "native-probe" });
  await nativePg.mintId();
  await nativePg.close(BACKGROUND_CONTEXT);
  await assert.rejects(WorkerStoreProvisioner.open({ ...provisionerOptions, connectionString: nativePgUrl.toString() }), /Refusing to convert/);
  passed.push("native PostgreSQL still initializes normally; provisioning refuses implicit conversion of its database");
  const storeId = `runtime-probe:${randomUUID()}`;
  const creation = await directory.directoryChatBootstrap(scope, directoryRoom.conversation.id);
  const bootstrap: ConversationWorkerBootstrap = { conversationKey: directoryRoom.conversation.id, storeId, ...creation, catalog: reopened };
  const options = { ...common, stateDir: join(root, "worker-one"), attachmentStore: new AttachmentStore(join(root, "separate-artifact-store")), piStorage: await provisioner.ensure(storeId) };
  assert.throws(() => DispatchRuntime.openConversation({ ...options, attachmentStore: undefined }, bootstrap), /explicitly supplied durable attachment store/);
  let worker = tracked(await DispatchRuntime.openConversation(options, bootstrap));
  const binding = await worker.workerBinding();
  assert.equal(binding.workspace?.recovered, false);
  assert(binding.workspace?.notice?.includes("not durably snapshotted"));
  const view = await worker.getChat(scope, binding.roomId);
  assert.equal(view.participants.filter(item => item.kind === "agent").length, 1);
  assert.equal((await worker.listChats(scope)).length, 1);
  await assert.rejects(worker.createChat(scope, { requestId: "second-room", agentDefinitionIds: [] }), /cannot create another room/);
  await assert.rejects(worker.getChat(scope, "999999"), /not found in this worker/);
  await assert.rejects(worker.saveSkill(scope, { requestId: "worker-admin", name: "No", description: "No", instructions: "No" }), /administration belongs to the backend/);
  await worker.renameChat(scope, binding.roomId, "durable worker room");
  const artifact = await worker.uploadAttachment(scope, binding.roomId, new File(["durable artifact bytes"], "artifact.txt", { type: "text/plain" }));
  const unchangedReceipt = await worker.applyWorkerCatalog(reopened);
  await assert.rejects(worker.applyWorkerCatalog({ ...reopened, connectionOwners: { altered: "default" } }), /reused with different content/);
  await directory.saveSkill(scope, { requestId: "another-skill", name: "Probe 2", description: "disposable", instructions: "No effects" });
  const next = await directory.exportWorkerCatalog(scope.companyId);
  assert((await worker.applyWorkerCatalog(next)).revision > unchangedReceipt.revision);
  await assert.rejects(worker.applyWorkerCatalog(reopened), /Stale/);
  assert.equal((await worker.getChat(scope, binding.roomId)).conversation.title, "durable worker room");
  passed.push("PostgreSQL worker seeds one room with requested agents; scoped access and monotonic catalog receipts");
  await writeFile(join(workspaceDir, "uncommitted-marker"), "must not survive");
  await close(worker);
  worker = tracked(await DispatchRuntime.openConversation(options, { ...bootstrap, catalog: next }));
  assert.equal((await worker.workerBinding()).workspace?.generation, binding.workspace?.generation);
  await close(worker);
  await rm(options.stateDir, { recursive: true });
  await rm(workspaceDir, { recursive: true });
  await mkdir(workspaceDir); // Same configured path, entirely fresh bytes, no workspace snapshots.
  await assert.rejects(readFile(join(workspaceDir, "uncommitted-marker")), /ENOENT/);
  await assert.rejects(DispatchRuntime.openConversation(options, { ...bootstrap, conversationKey: "wrong-binding", catalog: next }), /binding conflict/);
  worker = tracked(await DispatchRuntime.openConversation(options, { ...bootstrap, catalog: next }));
  const replacementBinding = await worker.workerBinding();
  assert.equal(replacementBinding.roomId, binding.roomId);
  assert.notEqual(replacementBinding.workspace?.generation, binding.workspace?.generation);
  assert.equal(replacementBinding.workspace?.recovered, true);
  assert(replacementBinding.workspace?.notice?.includes("NOT restored"));
  assert.equal((await worker.getChat(scope, binding.roomId)).conversation.title, "durable worker room");
  assert.equal((await worker.getChat(scope, binding.roomId)).participants.filter(item => item.kind === "agent").length, 1);
  assert.equal((await worker.downloadAttachment(scope, binding.roomId, artifact.id)).bytes.toString(), "durable artifact bytes");
  await close(worker);
  const otherStore = `other:${randomUUID()}`;
  const other = await provisioner.ensure(otherStore);
  const a = await connect(options.piStorage.connectionString);
  const b = await connect(other.connectionString);
  await b.query("INSERT INTO dispatch_pi.durable_metadata VALUES ($1,2,1)", [otherStore]);
  for (const table of ["durable_metadata", "record_ids", "conversations", "entries", "tasks", "submissions", "documents", "document_revisions"]) {
    assert((await a.query(`SELECT DISTINCT store_id FROM dispatch_pi.${table}`)).rows.every(row => row.store_id === storeId));
    assert((await b.query(`SELECT DISTINCT store_id FROM dispatch_pi.${table}`)).rows.every(row => row.store_id === otherStore));
  }
  assert.equal((await a.query("UPDATE dispatch_pi.durable_metadata SET next_id=999 WHERE store_id=$1", [otherStore])).rowCount, 0);
  assert.equal((await a.query("DELETE FROM dispatch_pi.durable_metadata WHERE store_id=$1", [otherStore])).rowCount, 0);
  await assert.rejects(a.query("INSERT INTO dispatch_pi.durable_metadata VALUES ($1,2,1)", [otherStore]), /row-level security/);
  await assert.rejects(a.query("UPDATE dispatch_pi.durable_metadata SET store_id=$1 WHERE store_id=$2", [otherStore, storeId]), /row-level security/);
  for (const sql of [
    "SET ROLE provisioner", `SET ROLE ${escapeIdentifier(new URL(other.connectionString).username)}`, "SET SESSION AUTHORIZATION probe",
    "SELECT * FROM dispatch_worker.roles", "UPDATE dispatch_worker.roles SET store_id='forged'",
    "ALTER TABLE dispatch_pi.documents DISABLE ROW LEVEL SECURITY", "TRUNCATE dispatch_pi.durable_metadata CASCADE",
    "CREATE SCHEMA forbidden", "CREATE TEMP TABLE forbidden(id int)", "CREATE ROLE forbidden",
    `ALTER ROLE ${escapeIdentifier(new URL(options.piStorage.connectionString).username)} SUPERUSER`,
    "CREATE OR REPLACE FUNCTION dispatch_worker.bound_store() RETURNS text LANGUAGE sql AS 'SELECT NULL::text'",
  ]) await assert.rejects(a.query(sql));
  await a.query("SET row_security=off");
  await assert.rejects(a.query("SELECT * FROM dispatch_pi.documents"), /row-level security/);
  await a.query("RESET row_security");
  await a.query("SELECT set_config('dispatch.store_id',$1,false)", [otherStore]);
  assert.equal((await a.query("SELECT dispatch_worker.bound_store() AS id")).rows[0].id, storeId);
  await assert.rejects(PostgresStorage.open({ ...options.piStorage, storeId: otherStore }), /restricted to the bound store/);
  await assert.rejects(PostgresStorage.open({ ...options.piStorage, connectionString: provisionerUrl.toString() }), /restricted to the bound store/);
  await provisioner.close();
  provisioner = await WorkerStoreProvisioner.open(provisionerOptions);
  assert.equal((await provisioner.ensure(storeId)).connectionString, options.piStorage.connectionString);
  passed.push("direct SQL is RLS-bound across all Pi tables; cross-store writes, role/session escalation, mapping tampering and DDL denied");
  passed.push("provisioner reopen reconciles stable credentials; worker mode refuses owner or mismatched-store credentials");
  passed.push("fresh local-state/workspace replacement reopens one PostgreSQL room without duplicate agents; binding mismatch fails closed");
  passed.push("fresh-workspace notice is durable before runtime open returns, with a changed generation after replacement");
  passed.push("attachment Pi metadata and bytes in an explicitly separate injected store survive worker replacement");
  console.log(JSON.stringify({ scope: "runtime bootstrap/directory API with disposable SQLite/PostgreSQL; no model/tool invocation or Docker/RPC", passed }, null, 2));
} finally {
  for (const runtime of opened) await runtime.close();
  await provisioner?.close();
  for (const client of sqlClients) await client.end();
  if (pgStarted) runPg("pg_ctl", ["-D", join(root, "postgres"), "-m", "fast", "-w", "stop"]);
  await rm(root, { recursive: true, force: true });
}
