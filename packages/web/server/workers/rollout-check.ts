// Focused rollout/summary probe: scoped PostgreSQL, directory SQLite and Pi 1.0.4.
// Real Pi tool execution and loopback worker RPC; injected upstream MCP/credential service.
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
import { DispatchRuntime, type ConversationWorkerBootstrap, type WorkerMcp, type WorkerManagementActor } from "../runtime.js";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { workerMcp as remoteWorkerMcp, backendWorkerMcp, type WorkerMcpRoute } from "./mcp.js";
import { workerRequest } from "./transport.js";
import { WriteAdmission } from "./admission.js";
import type { McpConnections, ManagedConnectionRecord } from "../mcp-connections.js";
import { AttachmentStore } from "../attachments.js";
import { WorkerStoreProvisioner } from "./postgres-stores.js";

if (process.env.DISPATCH_ROLLOUT_CHECK !== "disposable") throw new Error("Disposable authorization required.");
const postgres = process.env.DISPATCH_RUNTIME_PROBE_POSTGRES_BIN;
if (!postgres?.startsWith("/")) throw new Error("Absolute PostgreSQL bin directory required.");
const root = await mkdtemp(join(tmpdir(), "dispatch-rollout-"));
const workspaceDir = join(root, "workspace"); await mkdir(workspaceDir);
const scope = { companyId: "rollout-probe", userId: "creator" };
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
let heldCall: Promise<void> | undefined;
let releaseCall: (() => void) | undefined;
let callEntered = false;
let cancelledNotifications = 0;
const records: ManagedConnectionRecord[] = ["a", "b"].map(id => ({ id, companyId: scope.companyId, ownerId: scope.userId,
  name: id, endpoint: `https://${id}.invalid/mcp`, identity: id, serverName: id, authentication: "bearer", authorization: "authorized", scopes: [], createdAt: 1 }));
const json = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const managed = {
  initialize: () => {}, list: () => records, record: (id: string) => records.find(record => record.id === id)!,
  requireAssignment: (_scope: unknown, id: string) => { assert.equal(managed.record(id).authorization, "authorized"); },
  beforeConnect: async () => {}, recordServer: () => {},
  authProvider: () => ({ token: async () => "disposable-token", onUnauthorized: async () => {} }),
  fetch: async (_id: string, _input: string | URL, init?: RequestInit) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 202 });
    const request = JSON.parse(String(init?.body)) as { id?: unknown; method: string };
    if (request.method === "initialize") return json(request.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "rollout", version: "1" } });
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "notifications/cancelled") { cancelledNotifications++; return new Response(null, { status: 202 }); }
    if (request.method === "tools/call") {
      remoteCalls++;
      if (heldCall) { callEntered = true; await heldCall; }
      return json(request.id, { content: [{ type: "text", text: `AUTHORIZED_${_id}` }] });
    }
    assert.equal(request.method, "tools/list");
    return json(request.id, { tools: [{ name: "probe", description: "No external effects", inputSchema: { type: "object", properties: {} } }] });
  },
} satisfies Pick<McpConnections, "initialize" | "list" | "record" | "requireAssignment" | "beforeConnect" | "recordServer" | "authProvider" | "fetch">;
let actorSeen: WorkerManagementActor | undefined;
let remoteCalls = 0;
let preparations = 0;
const support = new WriteAdmission(false, async () => {});
let server: ServerType | undefined;
let origin: string;
const routes = new Map<string, WorkerMcpRoute>();
const token = randomBytes(32).toString("base64url");
const workerMcpFor = (conversationId: string): WorkerMcp => {
  const remote = remoteWorkerMcp((operation, input, signal) => workerRequest(origin, token, `/${conversationId}/${operation}`, input, signal));
  return { prepare: async (...args) => { preparations++; await remote.prepare(...args); } };
};
try {
  const password = randomBytes(24).toString("hex");
  const pwfile = join(root, "password"); await writeFile(pwfile, password, { mode: 0o600 });
  runPg("initdb", ["-D", join(root, "postgres"), "--username=probe", `--pwfile=${pwfile}`, "--auth=scram-sha-256", "--no-locale"]);
  runPg("pg_ctl", ["-D", join(root, "postgres"), "-l", join(root, "postgres.log"), "-o", "-h 127.0.0.1 -p 55500 -k ''", "-w", "start"]); pgStarted = true;
  const url = new URL(`postgresql://probe:${password}@127.0.0.1:55500/postgres`);
  admin = new Client({ connectionString: url.toString() }); await admin.connect();
  await admin.query(`CREATE ROLE provisioner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
  await admin.query("CREATE DATABASE rollout_probe OWNER provisioner"); url.username = "provisioner"; url.pathname = "/rollout_probe";
  provisioner = await WorkerStoreProvisioner.open({ connectionString: url.toString(), installationId: "rollout-probe", credentialKey: randomBytes(32).toString("base64url") });
  const directoryOptions = { ...common, runMcpBackground: <T>(operation: () => Promise<T>) => support.run(operation), mcpConnections: managed as unknown as McpConnections, stateDir: join(root, "directory"), directoryOnly: true };
  directory = await DispatchRuntime.open(directoryOptions);
  const app = new Hono();
  app.post("/:conversation/:operation", async c => {
    if (c.req.header("Authorization") !== `Bearer ${token}`) return c.json({ error: "Forbidden" }, 403);
    return support.run(async () => {
      const route = routes.get(c.req.param("conversation"));
      if (!route) return c.json({ error: "Forbidden" }, 403);
      const input = await c.req.json();
      const bridge = backendWorkerMcp(directory!);
      if (c.req.param("operation") === "definitions") return c.json(await bridge.definitions(route, input));
      if (input.actor?.storeId === route.storeId) actorSeen = input.actor;
      return c.json(await bridge.call(route, input, c.req.raw.signal));
    });
  });
  app.onError((_error, c) => c.json({ error: "Denied" }, 403));
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server!.listening ? resolve() : server!.once("listening", resolve));
  const address = server.address(); assert(address && typeof address === "object"); origin = `http://127.0.0.1:${address.port}`;
  const draft = { name: "Pinned", description: "Disposable rollout probe", instructions: "Original instructions", provider: "faux", modelId: "faux-1", thinkingLevel: "off" as const };
  const agent = await directory.saveAgent(scope, { ...draft, capabilities: ["files-and-commands"], connectionIds: ["a"] });
  const chat = await directory.createChat(scope, { requestId: "room", agentDefinitionIds: [agent.id] });
  const boot: ConversationWorkerBootstrap = { conversationKey: chat.conversation.id, storeId: `rollout:${randomUUID()}`,
    ...await directory.directoryChatBootstrap(scope, chat.conversation.id), ...await directory.directoryWorkerBootstrap(scope.companyId, chat.conversation.id) };
  routes.set(chat.conversation.id, { companyId: scope.companyId, conversationId: chat.conversation.id, storeId: boot.storeId });
  const options = { ...common, stateDir: join(workspaceDir, "state"), workerMcp: workerMcpFor(chat.conversation.id), attachmentStore: new AttachmentStore(join(root, "artifacts")), piStorage: await provisioner.ensure(boot.storeId) };
  worker = await DispatchRuntime.openConversation(options, boot);
  const roomId = (await worker.workerBinding()).roomId;
  const firstSummary = await worker.workerSummary();
  assert.deepEqual(await worker.workerSummary(), firstSummary);
  const initial = (await worker.getChat(scope, roomId)).participants.find(member => member.kind === "agent")!;
  assert(initial.kind === "agent");
  const firstMcp = boot.membership!.agents[0].mcp;
  const definitionPayload = await workerRequest(origin, token, `/${chat.conversation.id}/definitions`, { revision: boot.membership!.revision });
  assert(!JSON.stringify(definitionPayload).includes("disposable-token"));
  await assert.rejects(workerRequest(origin, "invalid", `/${chat.conversation.id}/definitions`, { revision: boot.membership!.revision }));
  await assert.rejects(workerRequest(origin, token, `/${chat.conversation.id}/definitions`, { revision: boot.membership!.revision + 1 }));
  const aTool = firstMcp.tools[0]; assert(aTool);
  faux.setResponses([fauxAssistantMessage(fauxToolCall(aTool, {}, { id: "a-call" }), { stopReason: "toolUse" }), fauxAssistantMessage("ROLLOUT_A_DONE")]);
  await worker.submit(scope, roomId, { requestId: "first", text: "Public title" });
  await waitFor("first remote tool", async () => remoteCalls === 1 && (await worker!.getChat(scope, roomId)).messages.some(message => message.text === "ROLLOUT_A_DONE"));
  assert(actorSeen);
  const v2 = await directory.saveAgent(scope, { ...draft, id: agent.id, expectedRevision: 1, instructions: "Future only", capabilities: [], connectionIds: ["b"] });
  const pendingChat = await directory.createChat(scope, { requestId: "pending-room", agentDefinitionIds: [agent.id] });
  const pendingBoot = { conversationKey: pendingChat.conversation.id, storeId: `pending:${randomUUID()}`,
    ...await directory.directoryChatBootstrap(scope, pendingChat.conversation.id) };
  const unchanged = await directory.directoryWorkerMembership(scope, chat.conversation.id);
  assert.deepEqual(unchanged, boot.membership);
  await directory.authorizeWorkerMcp(actorSeen!, "a", aTool);
  const bTool = v2.tools.find(name => name.startsWith("mcp_"))!;
  await assert.rejects(directory.authorizeWorkerMcp(actorSeen!, "b", bTool));
  const rollout = { ...draft, id: agent.id, expectedRevision: v2.revision, requestId: "rollout-b", instructions: "Must not replace original", capabilities: [], connectionIds: ["b"], applyConnectionsToExisting: true };
  const v3 = await directory.saveAgent(scope, rollout);
  const rolled = await directory.directoryWorkerMembership(scope, chat.conversation.id);
  assert(rolled.revision > unchanged.revision);
  assert.equal(rolled.agents[0].revision, 1);
  assert.deepEqual(rolled.agents[0].mcp.connections.map(connection => connection.id), ["b"]);
  assert.deepEqual(await directory.saveAgent(scope, rollout), v3);
  assert.deepEqual(await directory.directoryWorkerMembership(scope, chat.conversation.id), rolled);
  await assert.rejects(directory.saveAgent(scope, { ...rollout, connectionIds: ["a"] }));
  await assert.rejects(directory.authorizeWorkerMcp(actorSeen!, "a", aTool));
  await directory.authorizeWorkerMcp(actorSeen!, "b", bTool);
  await assert.rejects(directory.authorizeWorkerMcp(actorSeen!, "b", aTool));
  for (const patch of [{ companyId: "other" }, { conversationKey: "missing" }, { definitionId: "default" }, { revision: 99 }])
    await assert.rejects(directory.authorizeWorkerMcp({ ...actorSeen!, ...patch }, "b", bTool));
  const forged = { ...actorSeen!, configuration: { ...actorSeen!.configuration, connections: firstMcp.connections, tools: [aTool] } };
  await assert.rejects(directory.authorizeWorkerMcp(forged, "a", aTool));
  const beforeDenied = remoteCalls;
  await assert.rejects(workerRequest(origin, token, `/${chat.conversation.id}/call`, { actor: forged, connectionId: "a", toolName: aTool, args: {} }));
  await assert.rejects(workerRequest(origin, token, `/${chat.conversation.id}/call`, { actor: { ...actorSeen!, storeId: "another-store" }, connectionId: "b", toolName: bTool, args: {} }));
  assert.equal(remoteCalls, beforeDenied);
  await worker.applyWorkerCatalog(await directory.exportWorkerCatalog(scope.companyId));
  await worker.applyWorkerMembership(rolled);
  const updated = (await worker.getChat(scope, roomId)).participants.find(member => member.kind === "agent")!;
  assert(updated.kind === "agent");
  // Connection descriptors are an internal actor field, not part of the existing presentation contract.
  assert.equal(updated.agentRevision, initial.agentRevision);
  assert.equal(updated.agent.instructions, initial.agent.instructions);
  assert.equal(updated.agent.name, initial.agent.name);
  assert.equal(updated.agent.thinkingLevel, initial.agent.thinkingLevel);
  assert.deepEqual(updated.agent.skills, initial.agent.skills);
  assert.deepEqual(updated.agent.extensions.filter(name => !name.startsWith("dispatch-mcp-")), initial.agent.extensions.filter(name => !name.startsWith("dispatch-mcp-")));
  assert.equal(updated.agent.provider, initial.agent.provider);
  assert.equal(updated.agent.modelId, initial.agent.modelId);
  assert.equal(updated.agent.cwd, initial.agent.cwd);
  assert.deepEqual(updated.agent.tools.filter(name => !name.startsWith("mcp_")), initial.agent.tools.filter(name => !name.startsWith("mcp_")));
  assert.deepEqual(updated.agent.tools.filter(name => name.startsWith("mcp_")), [bTool]);
  const count = preparations;
  await worker.applyWorkerMembership(rolled); assert.equal(preparations, count);
  await assert.rejects(worker.applyWorkerMembership(unchanged)); assert.equal(preparations, count);
  faux.setResponses([fauxAssistantMessage(fauxToolCall(bTool, {}, { id: "b-call" }), { stopReason: "toolUse" }), fauxAssistantMessage("ROLLOUT_B_DONE")]);
  await worker.submit(scope, roomId, { requestId: "second", text: "Use the updated connection" });
  await waitFor("updated remote tool", async () => remoteCalls === 2 && (await worker!.getChat(scope, roomId)).messages.some(message => message.text === "ROLLOUT_B_DONE"));
  records[1].authorization = "revoked";
  await assert.rejects(directory.authorizeWorkerMcp(actorSeen!, "b", bTool));
  records[1].authorization = "authorized";
  const bridge = backendWorkerMcp(directory);
  const call = { actor: actorSeen!, connectionId: "b", toolName: bTool, args: {} };
  heldCall = new Promise<void>(resolve => { releaseCall = resolve; }); callEntered = false;
  const admitted = bridge.call(routes.get(chat.conversation.id)!, call);
  await waitFor("admitted upstream call", async () => callEntered);
  let drained = false;
  const draining = support.quiesce().then(() => { drained = true; });
  await delay(25); assert(!drained && !support.quiesced);
  await assert.rejects(bridge.call(routes.get(chat.conversation.id)!, call));
  releaseCall!(); await admitted; await draining; assert(support.quiesced);
  heldCall = undefined; await support.resume();
  heldCall = new Promise<void>(resolve => { releaseCall = resolve; }); callEntered = false;
  const cancellation = new AbortController();
  const callsBeforeAbort = remoteCalls;
  const interrupted = bridge.call(routes.get(chat.conversation.id)!, call, cancellation.signal);
  const rejected = assert.rejects(interrupted);
  await waitFor("cancellable upstream call", async () => callEntered);
  cancellation.abort(); await rejected;
  await waitFor("native MCP cancellation notification", async () => cancelledNotifications > 0);
  releaseCall!(); heldCall = undefined;
  assert.equal(remoteCalls, callsBeforeAbort + 1);
  passed.push("Support quiescence waits for admitted MCP calls, denies late calls; cancellation reaches native MCP without retrying an uncertain external invocation");
  passed.push("Native Pi tool callbacks resolve backend pins; new-only saves preserve old selection, explicit rollout changes MCP only, retries deduplicate and revocation/forged authority deny");
  const summary = await worker.workerSummary();
  assert(summary.revision > firstSummary.revision); assert.equal(summary.suggestedTitle, "Public title");
  assert.deepEqual(await worker.workerSummary(), summary);
  await directory.saveAgent(scope, { ...draft, id: agent.id, expectedRevision: v3.revision, requestId: "lost-rollout-a", connectionIds: ["a"], applyConnectionsToExisting: true });
  await worker.close(); worker = undefined;
  await directory.close(); directory = await DispatchRuntime.open(directoryOptions);
  const projection = await directory.directoryWorkerBootstrap(scope.companyId, chat.conversation.id);
  await rm(workspaceDir, { recursive: true }); await mkdir(workspaceDir);
  worker = await DispatchRuntime.openConversation(options, { ...boot, ...projection });
  assert.equal((await worker.workerBinding()).roomId, roomId);
  const restored = (await worker.getChat(scope, roomId)).participants.find(member => member.kind === "agent")!;
  assert(restored.kind === "agent"); assert.equal(restored.agentRevision, 1);
  assert.equal(restored.agent.instructions, initial.agent.instructions);
  assert.deepEqual(restored.agent.tools.filter(name => name.startsWith("mcp_")), [aTool]);
  const restoredSummary = await worker.workerSummary();
  assert(restoredSummary.revision >= summary.revision);
  if (restoredSummary.revision === summary.revision) assert.deepEqual(restoredSummary, summary);
  assert.deepEqual(await worker.workerSummary(), restoredSummary);
  passed.push("Directory reopen/fresh-workspace replacement reconciles lost rollout delivery while preserving history, pinned revision and durable summary ordering");
  await worker.close(); worker = undefined;
  routes.set(pendingBoot.conversationKey, { companyId: scope.companyId, conversationId: pendingBoot.conversationKey, storeId: pendingBoot.storeId });
  worker = await DispatchRuntime.openConversation({ ...options, workerMcp: workerMcpFor(pendingBoot.conversationKey), stateDir: join(root, "pending-state"), piStorage: await provisioner.ensure(pendingBoot.storeId) },
    { ...pendingBoot, ...await directory.directoryWorkerBootstrap(scope.companyId, pendingChat.conversation.id) });
  const pending = (await worker.getChat(scope, (await worker.workerBinding()).roomId)).participants.find(member => member.kind === "agent")!;
  assert(pending.kind === "agent"); assert.equal(pending.agentRevision, v2.revision);
  assert.equal(pending.agent.instructions, "Future only");
  assert.deepEqual(pending.agent.tools.filter(name => name.startsWith("mcp_")), [aTool]);
  passed.push("First startup after rollout uses current MCP selection rather than the historical definition's removed connection");
  await worker.close(); worker = undefined;
  worker = await DispatchRuntime.open({ ...common, stateDir: join(root, "native"), mcpConnections: managed as unknown as McpConnections });
  const nativeAgent = await worker.saveAgent(scope, { ...draft, connectionIds: ["a"] });
  const nativeChat = await worker.createChat(scope, { requestId: "native", agentDefinitionIds: [nativeAgent.id] });
  await worker.saveAgent(scope, { ...draft, id: nativeAgent.id, expectedRevision: nativeAgent.revision, connectionIds: ["b"], applyConnectionsToExisting: true, instructions: "Future native instruction" });
  const nativeMember = (await worker.getChat(scope, nativeChat.conversation.id)).participants.find(member => member.kind === "agent")!;
  assert(nativeMember.kind === "agent"); assert.equal(nativeMember.agentRevision, nativeAgent.revision);
  assert.equal(nativeMember.agent.instructions, draft.instructions);
  assert.deepEqual(nativeMember.agent.tools.filter(name => name.startsWith("mcp_")), [bTool]);
  passed.push("Native MCP binding rollout still preserves instructions/revision and changes only selected MCP tools");
  console.log(JSON.stringify({ scope: "Runtime APIs, real Pi tool execution/scoped PostgreSQL; loopback worker RPC through real bridge/native MCP client; injected upstream MCP/credentials, not deployed entrypoints/Docker/live OAuth", passed }, null, 2));
} finally {
  releaseCall?.();
  await worker?.close();
  if (server) { await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
  await directory?.close(); await provisioner?.close(); await admin?.end();
  if (pgStarted) runPg("pg_ctl", ["-D", join(root, "postgres"), "-m", "fast", "-w", "stop"]);
  await rm(root, { recursive: true, force: true });
}
