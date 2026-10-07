// Focused membership API/tool/replacement probe using scoped PostgreSQL, directory SQLite,
// and Pi 1.0.4's scripted model. No deployment, provider credentials or external effects.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, escapeLiteral } from "pg";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DispatchRuntime, type ConversationWorkerBootstrap, type WorkerManagementActor } from "../runtime.js";
import { AttachmentStore } from "../attachments.js";
import { WorkerStoreProvisioner } from "./postgres-stores.js";

if (process.env.DISPATCH_MEMBERSHIP_CHECK !== "disposable") throw new Error("Disposable authorization required.");
const postgres = process.env.DISPATCH_RUNTIME_PROBE_POSTGRES_BIN;
if (!postgres?.startsWith("/")) throw new Error("Absolute PostgreSQL bin directory required.");
const root = await mkdtemp(join(tmpdir(), "dispatch-membership-"));
const workspaceDir = join(root, "workspace"); await mkdir(workspaceDir);
const scope = { companyId: "membership-probe", userId: "creator" };
const invitedScope = { ...scope, userId: "invitee" };
const people = [{ id: scope.userId, name: "Creator" }, { id: invitedScope.userId, name: "Invitee" }];
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const common = { companyId: scope.companyId, models, provider: "faux", modelId: "faux-1", workspaceDir,
  peopleDirectory: { list: async () => people, get: async (_company: string, id: string) => people.find(person => person.id === id) ?? null } };
const runPg = (name: string, args: string[]) => execFileSync(join(postgres!, name), args, { stdio: "pipe" });
const waitFor = async (description: string, predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await delay(20); }
};
let directory: DispatchRuntime | undefined;
let worker: DispatchRuntime | undefined;
let provisioner: WorkerStoreProvisioner | undefined;
let admin: Client | undefined;
let pgStarted = false;
const passed: string[] = [];
try {
  const password = randomBytes(24).toString("hex");
  const pwfile = join(root, "password"); await writeFile(pwfile, password, { mode: 0o600 });
  runPg("initdb", ["-D", join(root, "postgres"), "--username=probe", `--pwfile=${pwfile}`, "--auth=scram-sha-256", "--no-locale"]);
  runPg("pg_ctl", ["-D", join(root, "postgres"), "-l", join(root, "postgres.log"), "-o", "-h 127.0.0.1 -p 55499 -k ''", "-w", "start"]); pgStarted = true;
  const url = new URL(`postgresql://probe:${password}@127.0.0.1:55499/postgres`);
  admin = new Client({ connectionString: url.toString() }); await admin.connect();
  await admin.query(`CREATE ROLE provisioner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
  await admin.query("CREATE DATABASE membership_probe OWNER provisioner"); url.username = "provisioner"; url.pathname = "/membership_probe";
  provisioner = await WorkerStoreProvisioner.open({ connectionString: url.toString(), installationId: "membership-probe", credentialKey: randomBytes(32).toString("base64url") });
  const directoryOptions = { ...common, stateDir: join(root, "directory"), directoryOnly: true };
  directory = await DispatchRuntime.open(directoryOptions);
  const draft = { description: "Disposable probe", instructions: "No effects", provider: "faux", modelId: "faux-1", thinkingLevel: "off" as const };
  const editor = await directory.saveAgent(scope, { ...draft, name: "Editor" });
  const guest = await directory.saveAgent(scope, { ...draft, name: "Guest" });
  const target = await directory.saveAgent(scope, { ...draft, name: "Target" });
  const chat = await directory.createChat(scope, { requestId: "human-room", agentDefinitionIds: [editor.id] });
  await directory.saveAgent(scope, { ...draft, id: editor.id, expectedRevision: 1, name: "Editor v2" });
  const bootstrap = async (id: string, storeId: string): Promise<ConversationWorkerBootstrap> => ({ conversationKey: id, storeId,
    ...await directory!.directoryChatBootstrap(scope, id), initialAgentRevisions: await directory!.workerInitialAgentRevisions(scope, id),
    catalog: await directory!.exportWorkerCatalog(scope.companyId), membership: await directory!.directoryWorkerMembership(scope, id) });
  const boot = await bootstrap(chat.conversation.id, `membership:${randomUUID()}`);
  const workerOptions = { ...common, stateDir: join(workspaceDir, "state"), attachmentStore: new AttachmentStore(join(root, "artifacts")), piStorage: await provisioner.ensure(boot.storeId) };
  worker = await DispatchRuntime.openConversation(workerOptions, boot);
  const binding = await worker.workerBinding();
  assert.equal((await worker.getChat(scope, binding.roomId)).participants.find(member => member.kind === "agent")?.agentRevision, 1);
  await assert.rejects(directory.getChat(invitedScope, chat.conversation.id));
  await assert.rejects(worker.getChat(invitedScope, binding.roomId));
  await assert.rejects(directory.inviteWorkerParticipants(invitedScope, chat.conversation.id, { requestId: "unauthorized-human", agentDefinitionIds: [guest.id] }));
  const input = { requestId: "invite-human-and-agent", userIds: [invitedScope.userId], agentDefinitionIds: [guest.id] };
  const invitation = await directory.inviteWorkerParticipants(scope, chat.conversation.id, input);
  await directory.getChat(invitedScope, chat.conversation.id); // Admission is authoritative even before worker receives it.
  await assert.rejects(worker.getChat(invitedScope, binding.roomId));
  await directory.saveAgent(scope, { ...draft, id: guest.id, expectedRevision: 1, name: "Guest v2" });
  await worker.applyWorkerCatalog(await directory.exportWorkerCatalog(scope.companyId));
  await worker.applyWorkerMembership(invitation.membership);
  const applied = await worker.getChat(invitedScope, binding.roomId);
  assert.equal(applied.participants.filter(member => member.kind === "agent").length, 2);
  const invitedAgent = applied.participants.find(member => member.kind === "agent" && member.agentDefinitionId === guest.id);
  assert(invitedAgent?.kind === "agent"); assert.equal(invitedAgent.agentRevision, 1);
  assert.equal(applied.messages.filter(message => message.kind === "membership").length, 1);
  const replay = await directory.inviteWorkerParticipants(scope, chat.conversation.id, input);
  assert.deepEqual(replay.membership, invitation.membership);
  await worker.applyWorkerMembership(replay.membership);
  assert.equal((await worker.getChat(scope, binding.roomId)).messages.filter(message => message.kind === "membership").length, 1);
  await assert.rejects(directory.inviteWorkerParticipants(scope, chat.conversation.id, { ...input, agentDefinitionIds: [target.id] }));
  await assert.rejects(worker.applyWorkerMembership(boot.membership!), /Stale/);
  await assert.rejects(worker.applyWorkerMembership({ ...replay.membership, humans: [] }), /conflicting/);
  passed.push("Backend-first private human access, pinned initial/invited revisions, duplicate invitation receipts and membership notices");
  await worker.close(); worker = undefined;
  await directory.close(); directory = await DispatchRuntime.open(directoryOptions);
  // Persist a second invitation without delivering its response to any worker.
  await directory.inviteWorkerParticipants(scope, chat.conversation.id, { requestId: "lost-delivery", agentDefinitionIds: [target.id] });
  const replacementBoot = await bootstrap(chat.conversation.id, boot.storeId);
  await rm(workspaceDir, { recursive: true }); await mkdir(workspaceDir);
  worker = await DispatchRuntime.openConversation(workerOptions, replacementBoot);
  const restored = await worker.getChat(invitedScope, binding.roomId);
  assert.equal(restored.participants.length, applied.participants.length + 1);
  assert.equal(restored.messages.filter(message => message.kind === "membership").length, 2);
  await worker.close(); worker = undefined;
  passed.push("Directory reopen and fresh-workspace replacement reconcile lost invitation delivery without duplicate agents/notices");

  // A distinct room exercises the actual native invitation tool with only one initial agent.
  const toolChat = await directory.createChat(scope, { requestId: "tool-room", agentDefinitionIds: [editor.id] });
  const toolBoot = await bootstrap(toolChat.conversation.id, `tool-invitation:${randomUUID()}`);
  let actorSeen: WorkerManagementActor | undefined;
  const toolOptions = { ...common, stateDir: join(workspaceDir, "tool-state"), attachmentStore: workerOptions.attachmentStore,
    piStorage: await provisioner.ensure(toolBoot.storeId), workerInvitations: { invite: async (actor: WorkerManagementActor, requestId: string, definitionIds: string[]) => {
      actorSeen = actor;
      return directory!.inviteWorkerAgents(actor, requestId, definitionIds);
    } } };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("conversation_invite_agent", { agentDefinitionId: target.id }, { id: "invite-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("[[silent]]"),
  ]);
  worker = await DispatchRuntime.openConversation(toolOptions, toolBoot);
  const toolBinding = await worker.workerBinding();
  await worker.submit(scope, toolBinding.roomId, { requestId: "invite-by-tool", text: "Invite the target agent." });
  await waitFor("native invitation tool", async () => (await worker!.getChat(scope, toolBinding.roomId)).participants.filter(member => member.kind === "agent").length === 2);
  assert(actorSeen && actorSeen.definitionId === editor.id && actorSeen.revision === 2);
  const authoritative = await directory.directoryWorkerMembership(scope, toolChat.conversation.id);
  assert(authoritative.agents.some(agent => agent.definitionId === target.id && agent.revision === 1));
  await assert.rejects(directory.inviteWorkerAgents({ ...actorSeen!, definitionId: guest.id }, "forged-inviter", [target.id]), /not authorized/);
  await assert.rejects(worker.addParticipants(scope, toolBinding.roomId, { requestId: "bypass", userIds: [invitedScope.userId] }), /first be admitted/);
  passed.push("Actual Pi invitation tool uses backend actor authority and reconciles membership without a transaction callback deadlock");
  passed.push("Forged nonparticipant inviter and direct worker invitation bypass fail closed");
  await worker.close(); worker = undefined;
  worker = await DispatchRuntime.open({ ...common, stateDir: join(root, "native") });
  const nativeRoom = await worker.createChat(scope, { requestId: "native-room", agentDefinitionIds: [] });
  await worker.addParticipants(scope, nativeRoom.conversation.id, { requestId: "native-invite", userIds: [invitedScope.userId], agentDefinitionIds: ["default"] });
  assert.equal((await worker.getChat(invitedScope, nativeRoom.conversation.id)).participants.length, 3);
  passed.push("Native human/agent invitations remain local and preserve access");
  console.log(JSON.stringify({ scope: "directory/worker runtime APIs and real Pi invitation tool; disposable SQLite/scoped PostgreSQL and scripted model, not HTTP/Docker acceptance", passed }, null, 2));
} finally {
  await worker?.close(); await directory?.close(); await provisioner?.close(); await admin?.end();
  if (pgStarted) runPg("pg_ctl", ["-D", join(root, "postgres"), "-m", "fast", "-w", "stop"]);
  await rm(root, { recursive: true, force: true });
}
