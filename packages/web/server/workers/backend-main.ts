import { McpPolicyGate } from "./mcp-policy.js";
import { backendWorkerMcp } from "./mcp.js";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { S3Artifacts, s3ArtifactsConfigSchema } from "./s3-artifacts.js";
import { ATTACHMENT_RPC_MAX_BYTES, attachmentSaveRequestSchema, attachmentReadRequestSchema, decodeAttachmentBytes } from "./attachments.js";
import { z } from "zod";
import { createAuth } from "../auth.js";
import { createApp } from "../app.js";
import { readConfig } from "../config.js";
import { openModels } from "../model-auth.js";
import { DispatchRuntime, type WorkerManagementActor } from "../runtime.js";
import { McpConnections } from "../mcp-connections.js";
import { WorkerRoutes } from "./routes.js";
import { distributedRuntime } from "./distributed.js";
import { tokenMatches, workerToken } from "./identity.js";
import { workerRequest } from "./transport.js";
import type { LauncherStatus } from "./launcher.js";
import { WorkerStoreProvisioner } from "./postgres-stores.js";
import { WriteAdmission } from "./admission.js";

const filename = process.env.DISPATCH_BACKEND_WORKERS_CONFIG_FILE;
if (!filename) throw new Error("DISPATCH_BACKEND_WORKERS_CONFIG_FILE is required.");
const workerConfig = z.object({ postgresStores: z.object({ adminUrlFile: z.string().startsWith("/") }).strict(), artifacts: s3ArtifactsConfigSchema, installationId: z.string().min(1), workerKeyFile: z.string(), launcherTokenFile: z.string(), operatorTokenFile: z.string(), launcherUrl: z.url(), launcherTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000), configurationRevision: z.string().min(1) }).strict().parse(JSON.parse(await readFile(filename, "utf8")));
const artifacts = await S3Artifacts.open(workerConfig.artifacts);
const workerKey = (await readFile(workerConfig.workerKeyFile, "utf8")).trim();
const stores = await WorkerStoreProvisioner.open({ connectionString: (await readFile(workerConfig.postgresStores.adminUrlFile, "utf8")).trim(), installationId: workerConfig.installationId, credentialKey: workerKey });
const launcherToken = (await readFile(workerConfig.launcherTokenFile, "utf8")).trim();
const operatorToken = (await readFile(workerConfig.operatorTokenFile, "utf8")).trim();
const config = readConfig();
await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
await mkdir(config.workspaceDir, { recursive: true, mode: 0o700 });
const provider = await openModels();
const auth = createAuth({ databasePath: join(config.stateDir, "auth.sqlite"), secretPath: join(config.stateDir, "auth.key"), origin: config.origin, rpId: config.rpId, companyId: config.companyId, companyName: config.companyName });
const connections = new McpConnections(join(config.stateDir, "connections.sqlite"), join(config.stateDir, "connections.key"), config.origin);
const support = new WriteAdmission(false, async () => {});
const directory = await DispatchRuntime.open({
  runMcpBackground: operation => support.run(operation), stateDir: join(config.stateDir, "runtime"), companyId: config.companyId, models: provider.models, directoryOnly: true,
  piStorage: config.piStorage, workspaceDir: config.workspaceDir, connectionsFile: config.connectionsFile, mcpConnections: connections,
  provider: provider.provider, modelId: provider.modelId, thinkingLevel: provider.thinkingLevel, readAllProjectUserIds: config.readAllProjectUserIds,
  peopleDirectory: { list: async companyId => auth.listCompanyPeople(companyId), get: async (companyId, userId) => auth.getCompanyPerson(companyId, userId) },
});
const routes = await WorkerRoutes.open(join(config.stateDir, "routing"), workerConfig.installationId);
const admission = new WriteAdmission(routes.admissionBlocked(), async blocked => { routes.setAdmissionBlocked(blocked); });
const mcpPolicy = new McpPolicyGate();
const runtime = distributedRuntime({ runPolicyChange: operation => mcpPolicy.change(operation), ...workerConfig, workerKey, launcherToken, directory, routes, runBackground: operation => admission.run(operation) });
// On restart support remains open until an explicit, freshly verified drain.
let transition: Promise<unknown> = Promise.resolve();
function operatorTransition<T>(operation: () => Promise<T>): Promise<T> {
  const result = transition.then(operation);
  transition = result.catch(() => {});
  return result;
}
const mcp = backendWorkerMcp(directory);
const app = new Hono();
app.use("*", async (c, next) => {
  if (c.req.path === "/internal/replace" || c.req.path === "/internal/status" || c.req.path === "/internal/drain" || c.req.path === "/internal/undrain") return next();
  const gate = c.req.path.startsWith("/internal/workers/") ? support : admission;
  if (!gate.admitting) return c.json({ error: "Application is drained" }, 503);
  return gate.run(next);
});
app.use("/internal/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin")) return c.json({ error: "Forbidden" }, 403);
  await next();
});
app.use("/internal/workers/*", bodyLimit({ maxSize: ATTACHMENT_RPC_MAX_BYTES, onError: c => c.json({ error: "Request too large" }, 413) }));
app.all("/internal/workers/:conversation/:attempt/:operation{.+}", async c => {
  const route = routes.get(c.req.param("conversation"));
  if (!route || route.attemptId !== c.req.param("attempt") || route.phase === "retiring" || !tokenMatches(workerToken(workerKey, workerConfig.installationId, route), c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  const operation = c.req.param("operation");
  if (operation === "bootstrap" && c.req.method === "GET") {
    const projection = await directory.directoryWorkerBootstrap(route.companyId, route.conversationId);
    return c.json({ ...projection, conversationKey: route.conversationId, storeId: route.storeId,
      scope: route.scope, input: route.input, storage: await stores.ensure(route.storeId) });
  }
  if (c.req.method !== "POST") return c.json({ error: "Not found" }, 404);
  const input = await c.req.json();
  if (operation === "mcp/definitions") return c.json(await mcp.definitions(route, input));
  if (operation === "mcp/call") return c.json(await mcpPolicy.call(() => mcp.call(route, input, c.req.raw.signal)));
  if (operation === "summary") {
    routes.updateSummary(route.conversationId, route.attemptId, route.storeId, input);
    return c.json({ accepted: true });
  }
  if (operation === "attachment/save") {
    const file = attachmentSaveRequestSchema.parse(input);
    const bytes = decodeAttachmentBytes(file.dataBase64);
    return c.json(await artifacts.save(route.storeId, route.conversationId, file.uploaderId, new File([new Uint8Array(bytes)], file.name, { type: file.mimeType })));
  }
  if (operation === "attachment/read") {
    const { id } = attachmentReadRequestSchema.parse(input);
    return c.json({ dataBase64: (await artifacts.read(route.storeId, id)).toString("base64") });
  }
  if (operation === "model-auth") {
    const { provider: providerId } = z.object({ provider: z.string() }).strict().parse(input);
    const catalog = await directory.exportWorkerCatalog(route.companyId);
    if (!catalog.agents.some(agent => agent.provider === providerId && !agent.archived)) return c.json({ error: "Forbidden" }, 403);
    return c.json(await provider.models.getAuth(providerId) ?? null);
  }
  if (operation === "people" || operation === "person") {
    const person = z.object({ companyId: z.string(), userId: z.string().optional() }).strict().parse(input);
    if (person.companyId !== route.companyId) return c.json({ error: "Forbidden" }, 403);
    return c.json(operation === "people" ? auth.listCompanyPeople(route.companyId) : auth.getCompanyPerson(route.companyId, person.userId ?? ""));
  }
  if (operation === "invitation") {
    const body = z.object({ actor: z.custom<WorkerManagementActor>(), requestId: z.string().min(1).max(200), definitionIds: z.array(z.string().min(1).max(200)).max(100) }).strict().parse(input);
    if (!body.actor || body.actor.companyId !== route.companyId || body.actor.conversationKey !== route.conversationId || body.actor.storeId !== route.storeId) return c.json({ error: "Forbidden" }, 403);
    return c.json(await directory.inviteWorkerAgents(body.actor, body.requestId, body.definitionIds));
  }
  if (operation === "management/read" || operation === "management/save") {
    const body = z.object({ actor: z.custom<WorkerManagementActor>(), input: z.unknown(), callId: z.string().optional() }).strict().parse(input);
    if (!body.actor || body.actor.companyId !== route.companyId || body.actor.conversationKey !== route.conversationId || body.actor.storeId !== route.storeId) return c.json({ error: "Forbidden" }, 403);
    return c.json(operation === "management/read" ? await directory.readWorkerManagedAgent(body.actor, body.input) : await directory.saveWorkerManagedAgent(body.actor, z.string().min(1).parse(body.callId), body.input));
  }
  return c.json({ error: "Not found" }, 404);
});
app.post("/internal/replace", async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  const { conversationId, attemptId } = z.object({ conversationId: z.string().min(1), attemptId: z.string().uuid() }).strict().parse(await c.req.json());
  const replacement = await operatorTransition(() => admission.run(async () => {
    const route = routes.get(conversationId);
    if (!route || route.attemptId !== attemptId) throw new Error("Stale replacement request.");
    await workerRequest(workerConfig.launcherUrl, launcherToken, "/v1/stop", { attemptId }, undefined, workerConfig.launcherTimeoutMs);
    const status = await workerRequest<LauncherStatus>(workerConfig.launcherUrl, launcherToken, "/v1/status");
    const retired = status.attempts.find(attempt => attempt.attemptId === attemptId);
    if (!status.driverReachable || retired?.phase !== "stopped" || retired.observed !== "absent") throw new Error("Retirement is not confirmed.");
    routes.retiring(conversationId, attemptId);
    return routes.replaceRetired(conversationId, attemptId, workerConfig.configurationRevision);
  }));
  return c.json({ conversationId, attemptId: replacement.attemptId, phase: replacement.phase });
});
app.post("/internal/drain", async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  await operatorTransition(async () => {
    await admission.quiesce();
    await workerRequest(workerConfig.launcherUrl, launcherToken, "/v1/drain", {}, undefined, workerConfig.launcherTimeoutMs);
    const status = await workerRequest<LauncherStatus>(workerConfig.launcherUrl, launcherToken, "/v1/status");
    if (!status.drainComplete) throw new Error("Worker retirement remains unresolved.");
    await support.quiesce();
  });
  return c.json({ quiesced: admission.quiesced && support.quiesced });
});
app.post("/internal/undrain", async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  await operatorTransition(async () => {
    await support.resume();
    await workerRequest(workerConfig.launcherUrl, launcherToken, "/v1/undrain", {}, undefined, workerConfig.launcherTimeoutMs);
    await admission.resume();
  });
  return c.json({ admitting: admission.admitting });
});
app.get("/internal/status", async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  const status = await workerRequest<LauncherStatus>(workerConfig.launcherUrl, launcherToken, "/v1/status");
  return c.json({ schemaVersion: 1, installation: workerConfig.installationId, drained: status.drained, drainComplete: status.drainComplete, backendQuiesced: admission.quiesced && support.quiesced, activeWorkers: status.activeWorkers.length, unresolvedAttempts: status.unresolvedAttempts.length });
});
const clientDir = process.env.DISPATCH_CLIENT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../client");
app.route("/", createApp({ auth, runtime, mcpConnections: connections, origin: config.origin, clientDir,
  configuration: async () => ({ company: { id: config.companyId, name: config.companyName }, defaultAgentId: "default", ...await provider.configuration(await runtime.getDefaultAgent(config.companyId)) }),
}));
app.onError((_error, c) => c.json({ error: "Internal worker request failed" }, 503));
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
let closing = false;
async function close() { if (closing) return; closing = true; server.close(); await runtime.close(); await connections.close(); artifacts.close(); await stores.close(); auth.close(); if ("closeAllConnections" in server) server.closeAllConnections(); }
process.once("SIGTERM", () => { void close(); }); process.once("SIGINT", () => { void close(); });
