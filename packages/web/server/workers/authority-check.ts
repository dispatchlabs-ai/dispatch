// Focused backend actor-authority API checks with disposable directory SQLite.
// Calls below begin after the HTTP route/attempt/store check; they do not qualify transport auth.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { DispatchRuntime, type WorkerManagementActor } from "../runtime.js";
import type { AuthPrincipal } from "../auth.js";

if (process.env.DISPATCH_AUTHORITY_CHECK !== "disposable") throw new Error("Disposable authorization required.");
const root = await mkdtemp(join(tmpdir(), "dispatch-worker-authority-"));
const workspaceDir = join(root, "workspace"); await mkdir(workspaceDir);
const scope = { companyId: "authority-probe", userId: "probe-human" };
const person = { id: scope.userId, name: "Authority Probe" };
const principal: AuthPrincipal = { ...scope, sessionId: "probe-session", email: "probe@example.invalid", name: person.name, expiresAt: Date.now() + 60_000 };
const models = createModels(); models.setProvider(fauxProvider().provider);
const options = { stateDir: join(root, "directory"), workspaceDir, companyId: scope.companyId, directoryOnly: true,
  models, provider: "faux", modelId: "faux-1", peopleDirectory: { list: async () => [person], get: async () => person } };
let runtime: DispatchRuntime | undefined;
const forbidden = (error: unknown) => error instanceof Error && "status" in error && error.status === 403;
try {
  runtime = await DispatchRuntime.open(options);
  const draft = { description: "Disposable authority probe", instructions: "No effects", provider: "faux", modelId: "faux-1", thinkingLevel: "off" as const };
  const editor = await runtime.saveAgent(scope, { ...draft, name: "Editor" });
  const outsider = await runtime.saveAgent(scope, { ...draft, name: "Not a participant" });
  const target = await runtime.saveAgent(scope, { ...draft, name: "Target" });
  const room = await runtime.createChat(scope, { requestId: "actor-room", agentDefinitionIds: [editor.id] });
  const policy = { editorRevision: 1, action: "save", fields: ["instructions"], maxSavesPerHour: 10 };
  for (const agent of [editor, outsider]) await runtime.saveManagementGrant(principal, { editorId: agent.id, targetId: target.id, expectedVersion: 0, requestId: `grant-${agent.id}`, reason: "disposable probe", policy });
  const claim: WorkerManagementActor = { companyId: scope.companyId, conversationKey: room.conversation.id, storeId: "probe-store",
    definitionId: editor.id, revision: 1, instanceId: 999_991 as WorkerManagementActor["instanceId"], participantId: "forged-participant",
    roomId: 999_992 as WorkerManagementActor["roomId"], configuration: { ...editor, instructions: "forged instructions", tools: ["bash"], extensions: ["coding-tools"] } };
  await assert.rejects(runtime.readWorkerManagedAgent({ ...claim, definitionId: outsider.id, configuration: outsider }, { targetId: target.id }), forbidden);
  await assert.rejects(runtime.readWorkerManagedAgent({ ...claim, companyId: "other-company" }, { targetId: target.id }), forbidden);
  await assert.rejects(runtime.readWorkerManagedAgent({ ...claim, conversationKey: "missing-room" }, { targetId: target.id }), forbidden);
  await assert.rejects(runtime.readWorkerManagedAgent({ ...claim, revision: 2 }, { targetId: target.id }), forbidden);
  const save = { targetId: target.id, operationId: "one-operation", expectedRevision: 1, reason: "disposable edit", patch: { instructions: "Saved through backend pin" } };
  const result = await runtime.saveWorkerManagedAgent(claim, "call-one", save);
  const forgedReplay = { ...claim, instanceId: 999_993 as WorkerManagementActor["instanceId"], participantId: "another-forged-participant", configuration: outsider };
  assert.deepEqual(await runtime.saveWorkerManagedAgent(forgedReplay, "call-two", save), result);
  let state = await runtime.managementGrants(principal);
  assert.equal(state.saves.length, 1);
  assert.notEqual(state.saves[0].instanceId, String(claim.instanceId));
  assert.notEqual(state.saves[0].participantId, claim.participantId);
  assert.equal(state.saves[0].roomId, room.conversation.id);
  assert.equal(state.saves[0].definitionId, editor.id);
  assert.equal(state.saves[0].workerStoreId, "probe-store");
  await assert.rejects(runtime.saveWorkerManagedAgent(forgedReplay, "call-three", { ...save, patch: { instructions: "different content" } }), error => error instanceof Error && "status" in error && error.status === 409);
  await runtime.close(); runtime = await DispatchRuntime.open(options);
  assert.deepEqual(await runtime.saveWorkerManagedAgent(forgedReplay, "call-after-reopen", save), result);
  await assert.rejects(runtime.readWorkerManagedAgent({ ...claim, definitionId: outsider.id, configuration: outsider }, { targetId: target.id }), forbidden);
  await runtime.saveManagementGrant(principal, { editorId: editor.id, targetId: target.id, expectedVersion: 1, requestId: "revoke-editor", reason: "disposable revocation", policy: null });
  await assert.rejects(runtime.readWorkerManagedAgent(claim, { targetId: target.id }), forbidden);
  await assert.rejects(runtime.saveWorkerManagedAgent(claim, "call-after-revocation", { ...save, operationId: "new-operation", expectedRevision: 2 }), forbidden);
  // Returning an already committed receipt is not a new save; preserve native retry semantics.
  assert.deepEqual(await runtime.saveWorkerManagedAgent(forgedReplay, "receipt-after-revocation", save), result);
  state = await runtime.managementGrants(principal); assert.equal(state.saves.length, 1);
  console.log(JSON.stringify({ scope: "backend directory management API, disposable SQLite; authenticated route/attempt/store binding and distributed invitation propagation are outside this probe", passed: [
    "Granted editor absent from this conversation cannot impersonate a participant",
    "Foreign company, missing room and unpinned editor revision are denied",
    "Submitted configuration/instance/participant/room fields do not supply authority or receipt identity",
    "Forged instance IDs and new call IDs cannot bypass stable operation receipts",
    "Different-content replay conflicts; actor pins and receipts survive reopen",
    "Revocation denies new reads/saves while committed receipt replay remains read-only",
  ], committedSaves: state.saves.length }, null, 2));
} finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
