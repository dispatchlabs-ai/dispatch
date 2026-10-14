import { httpTelemetry } from "../telemetry.js";
import { S3ProjectArchiveStore } from "./s3-project-archives.js";
import { createWebBackend } from "../web/backend.js";
import { McpPolicyGate } from "./mcp-policy.js";
import { backendWorkerMcp } from "./mcp.js";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createSecureContext } from "node:tls";
import { Hono } from "hono";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { bodyLimit } from "hono/body-limit";
import { S3Artifacts, s3ArtifactsConfigSchema } from "./s3-artifacts.js";
import { ATTACHMENT_RPC_MAX_BYTES, attachmentSaveRequestSchema, attachmentReadRequestSchema, decodeAttachmentBytes } from "./attachments.js";
import { z } from "zod";
import { createAuth } from "../auth.js";
import { ProviderSetup } from "../provider-setup.js";
import { createApp } from "../app.js";
import { readConfig } from "../config.js";
import { readDirectoryStoreConfig } from "../storage/directory-config.js";
import { readAuthStoreConfig, openConfiguredAuth } from "../auth/config.js";
import { readMcpConnectionConfig, openConfiguredMcpConnections } from "../storage/mcp-config.js";
import { readProviderCredentialConfig, openConfiguredProviderCredentials } from "../storage/provider-credential-config.js";
import { openModels } from "../model-auth.js";
import { DEFAULT_AGENT_ID, DispatchRuntime, RuntimeError, type WorkerManagementActor } from "../runtime.js";
import { McpConnections } from "../mcp-connections.js";
import { WorkerRoutes } from "./routes.js";
import { readRoutingStoreConfig, openConfiguredWorkerRoutes } from "./routing-config.js";
import { distributedRuntime } from "./distributed.js";
import { tokenMatches, workerToken } from "./identity.js";
import { workerRequest } from "./transport.js";
import type { LauncherStatus } from "./launcher.js";
import { WorkerStoreProvisioner } from "./postgres-stores.js";
import { readRestrictedConfigurationFile } from "../storage/restricted-config-file.js";
import { verifiedPostgresConfig } from "../storage/postgres/tls.js";
import { WriteAdmission } from "./admission.js";
import { projectChatsSchema, projectChatReadSchema } from "../project-chat-context.js";
import { readWorkerProjectChat } from "./project-chat-reader.js";
import { HistoryCursorError } from "../chat-pages.js";

export async function openBackendOwner() {
const filename = process.env.DISPATCH_BACKEND_WORKERS_CONFIG_FILE;
if (!filename) throw new Error("DISPATCH_BACKEND_WORKERS_CONFIG_FILE is required.");
const workerConfig = z.object({
  workerIdleTimeoutMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(600_000),
  providerStoreConfigFile: z.string().startsWith("/").optional(),
  authStoreConfigFile: z.string().startsWith("/").optional(),
  mcpStoreConfigFile: z.string().startsWith("/").optional(),
  routingStoreConfigFile: z.string().startsWith("/").optional(), directoryStoreConfigFile: z.string().startsWith("/").optional(), tls: z.object({ keyFile: z.string().startsWith("/"), certFile: z.string().startsWith("/") }).strict().optional(), postgresStores: z.object({ adminUrlFile: z.string().startsWith("/"), caFile: z.string().startsWith("/").optional() }).strict(), artifacts: s3ArtifactsConfigSchema, installationId: z.string().min(1), workerKeyFile: z.string(), launcherTokenFile: z.string(), operatorTokenFile: z.string(), launcherUrl: z.url(), launcherTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000), configurationRevision: z.string().min(1) }).strict().parse(JSON.parse(await readFile(filename, "utf8")));
// Recovery belongs to this invocation, never a retained deployment setting.
const { values: recovery } = parseArgs({ options: {
  "recover-routing-owner": { type: "string" },
  "recover-provider-owner": { type: "string" },
  "recover-mcp-owner": { type: "string" },
  "confirm-retired-backend": { type: "boolean", default: false },
} });
const recovering = Boolean(recovery["recover-routing-owner"] || recovery["recover-provider-owner"] || recovery["recover-mcp-owner"]);
if (recovering !== recovery["confirm-retired-backend"])
  throw new Error("Owner recovery requires exact owner IDs and --confirm-retired-backend after independently confirming old backend termination.");
for (const [owner, configuration] of [
  [recovery["recover-routing-owner"], workerConfig.routingStoreConfigFile],
  [recovery["recover-provider-owner"], workerConfig.providerStoreConfigFile],
  [recovery["recover-mcp-owner"], workerConfig.mcpStoreConfigFile],
]) {
  if (owner !== undefined && (!configuration || !z.string().uuid().safeParse(owner).success))
    throw new Error("Recovery requires a UUID owner ID and the corresponding PostgreSQL store configuration.");
}
// Load configured identity before opening stores; missing/invalid TLS never falls back to HTTP.
const tls = workerConfig.tls ? {
  key: await readFile(workerConfig.tls.keyFile), cert: await readFile(workerConfig.tls.certFile),
  minVersion: "TLSv1.2" as const,
} : undefined;
if (tls) createSecureContext(tls);
const storeUrl = (await readFile(workerConfig.postgresStores.adminUrlFile, "utf8")).trim();
const storeCa = workerConfig.postgresStores.caFile === undefined ? undefined : await readFile(workerConfig.postgresStores.caFile, "utf8");
if (storeCa !== undefined) verifiedPostgresConfig(storeUrl, storeCa);
if (workerConfig.directoryStoreConfigFile !== undefined) {
  if (["DISPATCH_PI_STORAGE", "DISPATCH_POSTGRES_URL", "DISPATCH_POSTGRES_STORE_ID"].some(name => process.env[name] !== undefined))
    throw new Error("directoryStoreConfigFile cannot be combined with legacy Pi storage environment settings.");
  if (!process.env.DISPATCH_DATA_DIR) throw new Error("Directory PostgreSQL mode requires explicit DISPATCH_DATA_DIR.");
}
const config = readConfig();
const directoryStorage = workerConfig.directoryStoreConfigFile === undefined ? config.piStorage
  : await readDirectoryStoreConfig(workerConfig.directoryStoreConfigFile);
const routingConfig = workerConfig.routingStoreConfigFile === undefined ? undefined
  : await readRoutingStoreConfig(workerConfig.routingStoreConfigFile);
if (routingConfig && routingConfig.installationId !== workerConfig.installationId)
  throw new Error("Routing installation identity does not match backend identity.");
const providerConfig = workerConfig.providerStoreConfigFile === undefined ? undefined : await readProviderCredentialConfig(workerConfig.providerStoreConfigFile);
const authConfig = workerConfig.authStoreConfigFile === undefined ? undefined : await readAuthStoreConfig(workerConfig.authStoreConfigFile);
const mcpConfig = workerConfig.mcpStoreConfigFile === undefined ? undefined : await readMcpConnectionConfig(workerConfig.mcpStoreConfigFile);
// Validate every configured credential file before any database or artifact opens.
for (const store of [providerConfig, authConfig, mcpConfig]) {
  if (!store) continue;
  let url: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    if (store.installationId !== workerConfig.installationId) throw new Error();
    url = await readRestrictedConfigurationFile(store.databaseUrlFile, true);
    const ca = await readRestrictedConfigurationFile(store.databaseCaFile, false);
    verifiedPostgresConfig(url.toString("utf8").trim(), ca.toString("utf8"));
    key = await readRestrictedConfigurationFile(store.encryptionKeyFile, true);
    if (key.length !== 32) throw new Error();
  } catch {
    throw new Error("Invalid backend credential configuration; check installation identity, restricted files, key and TLS.");
  } finally { url?.fill(0); key?.fill(0); }
}
const startupCleanup: Array<() => void | Promise<void>> = [];
try {
const routes = routingConfig ? await openConfiguredWorkerRoutes(routingConfig, recovery["recover-routing-owner"])
  : await WorkerRoutes.open(join(config.stateDir, "routing"), workerConfig.installationId);
startupCleanup.push(() => routes.close());
if (recovering) await routes.setAdmissionBlocked(true);
const admission = new WriteAdmission(routes.admissionBlocked(), async blocked => { await routes.setAdmissionBlocked(blocked); });
const artifacts = await S3Artifacts.open(workerConfig.artifacts);
startupCleanup.push(() => artifacts.close());
const archives = await S3ProjectArchiveStore.open(workerConfig.artifacts, workerConfig.installationId);
startupCleanup.push(() => archives.close());
const workerKey = (await readFile(workerConfig.workerKeyFile, "utf8")).trim();
const stores = await WorkerStoreProvisioner.open({ connectionString: storeUrl, ca: storeCa, installationId: workerConfig.installationId, credentialKey: workerKey });
startupCleanup.push(() => stores.close());
const launcherToken = (await readFile(workerConfig.launcherTokenFile, "utf8")).trim();
const operatorToken = (await readFile(workerConfig.operatorTokenFile, "utf8")).trim();
await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
await mkdir(config.workspaceDir, { recursive: true, mode: 0o700 });
startupCleanup.push(() => { cleanupSessionResources(); });
const credentials = providerConfig ? await openConfiguredProviderCredentials(providerConfig, recovery["recover-provider-owner"]) : undefined;
if (credentials) {
  startupCleanup.push(() => credentials.close());
  await credentials.quiesce();
}
const provider = await openModels(process.env, credentials, false);
const auth = authConfig ? await openConfiguredAuth(authConfig, config) : await createAuth({ databasePath: join(config.stateDir, "auth.sqlite"), secretPath: join(config.stateDir, "auth.key"), origin: config.origin, rpId: config.rpId, companyId: config.companyId, companyName: config.companyName });
startupCleanup.push(() => auth.close());
await auth.quiesce();
const connections = mcpConfig ? await openConfiguredMcpConnections(mcpConfig, config.origin, recovery["recover-mcp-owner"]) : new McpConnections(join(config.stateDir, "connections.sqlite"), join(config.stateDir, "connections.key"), config.origin);
startupCleanup.push(() => connections.close());
await connections.quiesce();
const support = new WriteAdmission(true, async () => {});
const providerSetup = credentials ? new ProviderSetup(provider.models, credentials, workerConfig.installationId, id => auth.isSessionValid(id), operation => support.run(operation)) : undefined;
startupCleanup.push(async () => { await providerSetup?.close(); });
const directory = await DispatchRuntime.open({
  connectMcpOnOpen: false, runMcpBackground: operation => support.run(operation), stateDir: join(config.stateDir, "runtime"), companyId: config.companyId, models: provider.models, directoryOnly: true,
  projectArchiveStore: archives,
  piStorage: directoryStorage, workspaceDir: config.workspaceDir, connectionsFile: config.connectionsFile, mcpConnections: connections,
  provider: provider.provider, modelId: provider.modelId, thinkingLevel: provider.thinkingLevel, readAllProjectUserIds: config.readAllProjectUserIds,
  peopleDirectory: { list: async companyId => auth.listCompanyPeople(companyId), get: async (companyId, userId) => auth.getCompanyPerson(companyId, userId) },
});
startupCleanup.push(async () => { try { await support.quiesce(); } finally { await directory.close(); } });
const mcpPolicy = new McpPolicyGate();
const runtime = distributedRuntime({ runPolicyChange: operation => mcpPolicy.change(operation), ...workerConfig, workerKey, launcherToken, directory, routes, runBackground: operation => admission.run(operation) });
async function launcherStatus(): Promise<LauncherStatus> {
  const status = await workerRequest<LauncherStatus>(workerConfig.launcherUrl, launcherToken, "/v1/status");
  if (status.installationId !== workerConfig.installationId)
    throw new Error("Launcher installation identity does not match backend identity.");
  return status;
}
let credentialsQuiesced = true;
// Process-local, explicit operator intent; never inferred from a persisted drain.
let plannedQuiescence = false;
async function resumeCredentials(refresh = true) {
  credentialsQuiesced = false;
  await credentials?.resume();
  await auth.resume();
  await connections.resume();
  if ((credentials && !credentials.admitting) || !auth.admitting || !connections.admitting)
    throw new Error("Credential admission remains closed.");
  if (refresh) await provider.models.refresh({ allowNetwork: false });
}
if (!routes.admissionBlocked()) {
  await resumeCredentials();
  await support.resume();
  await support.run(() => directory.startMcpConnections());
} else {
  // Public admission closure can precede worker retirement. Until fresh launcher
  // evidence confirms retirement, retain authenticated callbacks needed to drain.
  // Do not proactively refresh models or discover MCP connections in this mode.
  let retired = false;
  try {
    const status = await launcherStatus();
    retired = status.drainComplete;
  } catch { /* Unreachable launcher is not retirement evidence. */ }
  if (!retired) {
    await resumeCredentials(false);
    await support.resume();
    providerSetup?.resume();
  }
}
let transition: Promise<unknown> = Promise.resolve();
function operatorTransition<T>(operation: () => Promise<T>): Promise<T> {
  const result = transition.then(operation);
  transition = result.catch(() => {});
  return result;
}
const mcp = backendWorkerMcp(directory);
const app = new Hono();
app.use("*", httpTelemetry());
app.use("*", async (c, next) => {
  if (c.req.path === "/internal/health" || c.req.path === "/internal/ready" || c.req.path === "/internal/replace" || c.req.path === "/internal/status" || c.req.path === "/internal/drain" || c.req.path === "/internal/sleep" || c.req.path === "/internal/undrain") return next();
  const gate = c.req.path.startsWith("/internal/workers/") ? support : admission;
  if (!gate.admitting) return c.json({ error: "Application is drained" }, 503);
  return gate.run(next);
});
app.use("/internal/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin")) return c.json({ error: "Forbidden" }, 403);
  await next();
});
// Private load-balancer liveness is independent of admission and readiness.
app.get("/internal/health", c => c.text("ok"));
app.get("/internal/ready", async c => {
  try { const available = healthReady(); return c.text(available ? "ok" : "unavailable", available ? 200 : 503); }
  catch { return c.text("unavailable", 503); }
});
app.use("/internal/workers/*", bodyLimit({ maxSize: ATTACHMENT_RPC_MAX_BYTES, onError: c => c.json({ error: "Request too large" }, 413) }));
app.all("/internal/workers/:conversation/:attempt/:operation{.+}", async c => {
  const currentRoute = () => {
    const route = routes.get(c.req.param("conversation"));
    if (!route || route.attemptId !== c.req.param("attempt") || route.phase === "retiring" || route.phase === "sleeping" || !tokenMatches(workerToken(workerKey, workerConfig.installationId, route), c.req.header("Authorization")))
      throw new RuntimeError(403, "Forbidden");
    return route;
  };
  const route = currentRoute();
  const assertCurrent = () => { currentRoute(); };
  const operation = c.req.param("operation");
  if (operation === "bootstrap" && c.req.method === "GET") {
    const projection = await directory.directoryWorkerBootstrap(route.companyId, route.conversationId);
    return c.json({ ...projection, conversationKey: route.conversationId, storeId: route.storeId,
      scope: route.scope, input: route.input, storage: await stores.ensure(route.storeId) });
  }
  if (c.req.method !== "POST") return c.json({ error: "Not found" }, 404);
  const input = await c.req.json();
  assertCurrent();
  if (operation === "participants/report") {
    const result = await directory.acknowledgeWorkerParticipants(route.companyId, route.conversationId, route.storeId, input);
    assertCurrent();
    return c.json(result ?? { accepted: true });
  }
  if (operation === "secrets") return c.json(await mcpPolicy.call(async () => {
    const request = z.object({
      actor: z.custom<import("../runtime.js").WorkerManagementActor>(value => typeof value === "object" && value !== null),
      secretId: z.string().uuid().optional(),
    }).strict().parse(input);
    const { actor } = request;
    if (actor.companyId !== route.companyId || actor.conversationKey !== route.conversationId || actor.storeId !== route.storeId)
      throw new RuntimeError(403, "Secret actor is outside the authenticated worker route.");
    const authorized = await directory.authorizeWorkerSecrets(actor);
    assertCurrent();
    const result = request.secretId ? { value: await connections.resolveNamedSecret(authorized.companyId, authorized.definitionId, request.secretId) }
      : { secrets: await connections.grantedNamedSecrets(authorized.companyId, authorized.definitionId) };
    assertCurrent();
    c.req.raw.signal.throwIfAborted();
    return result;
  }));
  if (operation === "search") return c.json(await mcpPolicy.call(async () => {
    const request = z.object({
      actor: z.custom<import("../runtime.js").WorkerManagementActor>(value => typeof value === "object" && value !== null),
      query: z.object({ q: z.string().trim().min(1).max(10000), recency: z.number().int().nonnegative().optional(), domains: z.array(z.string().min(1).max(253)).max(100).optional() }).strict(),
    }).strict().parse(input);
    const { actor } = request;
    if (actor.companyId !== route.companyId || actor.conversationKey !== route.conversationId || actor.storeId !== route.storeId)
      throw new RuntimeError(403, "Search actor is outside the authenticated worker route.");
    assertCurrent();
    const authorized = await directory.authorizeWorkerSearch(actor);
    const searchApiKey = await connections.resolveSearchSecret(authorized.companyId, authorized.definitionId);
    assertCurrent();
    c.req.raw.signal.throwIfAborted();
    return createWebBackend({ searchApiKey }).search(request.query, c.req.raw.signal);
  }));
  if (operation === "mcp/definitions") return c.json(await mcp.definitions(route, input));
  if (operation === "mcp/call") return c.json(await mcpPolicy.call(() => {
    assertCurrent();
    return mcp.call(route, input, c.req.raw.signal, assertCurrent);
  }));
  if (operation === "summary") {
    await routes.updateSummary(route.conversationId, route.attemptId, route.storeId, input);
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
  if (operation === "model-auth" || operation === "model-auth-check") {
    const { provider: providerId } = z.object({ provider: z.string() }).strict().parse(input);
    const resolveAuth = () => operation === "model-auth-check"
      ? provider.models.checkAuth(providerId, { signal: c.req.raw.signal })
      : provider.models.getAuth(providerId, { signal: c.req.raw.signal });
    if (providerId === "openai-codex") return c.json(await mcpPolicy.call(async () => {
      await directory.authorizeWorkerImageCredentials(route.companyId, route.conversationId, route.storeId);
      assertCurrent();
      const result = await resolveAuth() ?? null;
      assertCurrent();
      c.req.raw.signal.throwIfAborted();
      return result;
    }));
    const catalog = await directory.exportWorkerCatalog(route.companyId);
    if (!catalog.agents.some(agent => agent.provider === providerId && !agent.archived)) return c.json({ error: "Forbidden" }, 403);
    const result = await resolveAuth() ?? null;
    assertCurrent();
    return c.json(result);
  }
  if (operation === "people" || operation === "person") {
    const person = z.object({ companyId: z.string(), userId: z.string().optional() }).strict().parse(input);
    if (person.companyId !== route.companyId) return c.json({ error: "Forbidden" }, 403);
    return c.json(operation === "people" ? await auth.listCompanyPeople(route.companyId) : await auth.getCompanyPerson(route.companyId, person.userId ?? ""));
  }
  if (operation === "project-chats" || operation === "project-chat-read") return c.json(await mcpPolicy.call(async () => {
    const body = z.object({ actor: z.custom<WorkerManagementActor>(), input: z.unknown() }).strict().parse(input);
    if (!body.actor || body.actor.companyId !== route.companyId || body.actor.conversationKey !== route.conversationId || body.actor.storeId !== route.storeId) throw new RuntimeError(403, "Forbidden");
    assertCurrent();
    if (operation === "project-chats") {
      const result = await directory.listWorkerProjectChats(body.actor, projectChatsSchema.parse(body.input));
      for (const chat of result.chats) {
        const observation = routes.readSummary(chat.id);
        if (observation) chat.updatedAt = Math.max(chat.updatedAt, observation.value.updatedAt);
      }
      assertCurrent();
      return result;
    }
    const query = projectChatReadSchema.parse(body.input);
    const authorized = await directory.authorizeWorkerProjectChat(body.actor, query.chatId);
    const target = routes.get(query.chatId);
    if (!target || target.companyId !== route.companyId) throw new RuntimeError(503, "Chat history is unavailable.");
    let result;
    try {
      result = await readWorkerProjectChat({ connectionString: storeUrl, ca: storeCa, storeId: target.storeId }, target, authorized.projectId, authorized.metadata, query,
        attachment => artifacts.read(target.storeId, attachment.id));
    } catch (error) {
      if (error instanceof Error && ("status" in error || error instanceof HistoryCursorError)) throw error;
      throw new RuntimeError(503, "Chat history is unavailable.");
    }
    assertCurrent();
    c.req.raw.signal.throwIfAborted();
    const current = await directory.authorizeWorkerProjectChat(body.actor, query.chatId);
    const currentRoute = routes.get(query.chatId);
    if (current.projectId !== authorized.projectId || currentRoute?.storeId !== target.storeId || currentRoute.nativeRoomId !== target.nativeRoomId) throw new RuntimeError(404, "Chat not found.");
    return result;
  }));
  if (operation === "project-spec") {
    const body = z.object({ actor: z.custom<WorkerManagementActor>(), input: z.object({ revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict() }).strict().parse(input);
    if (!body.actor || body.actor.companyId !== route.companyId || body.actor.conversationKey !== route.conversationId || body.actor.storeId !== route.storeId) return c.json({ error: "Forbidden" }, 403);
    return c.json(await directory.readWorkerProjectSpec(body.actor, body.input));
  }
  if (operation === "invitation") {
    const body = z.object({ actor: z.custom<WorkerManagementActor>(), requestId: z.string().min(1).max(200), definitionIds: z.array(z.string().min(1).max(200)).max(100) }).strict().parse(input);
    if (!body.actor || body.actor.companyId !== route.companyId || body.actor.conversationKey !== route.conversationId || body.actor.storeId !== route.storeId) return c.json({ error: "Forbidden" }, 403);
    return c.json(await directory.inviteWorkerAgents(body.actor, body.requestId, body.definitionIds));
  }
  if (operation === "management/read" || operation === "management/save") {
    const body = z.object({ actor: z.custom<WorkerManagementActor>(), input: z.unknown(), callId: z.string().optional() }).strict().parse(input);
    if (!body.actor || body.actor.companyId !== route.companyId || body.actor.conversationKey !== route.conversationId || body.actor.storeId !== route.storeId) return c.json({ error: "Forbidden" }, 403);
    if (operation === "management/read") return c.json(await directory.readWorkerManagedAgent(body.actor, body.input));
    const result = await directory.saveWorkerManagedAgent(body.actor, z.string().min(1).parse(body.callId), body.input);
    runtime.deferCatalogReconciliation(route.companyId);
    return c.json(result);
  }
  return c.json({ error: "Not found" }, 404);
});
app.post("/internal/replace", async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  const { conversationId, attemptId } = z.object({ conversationId: z.string().min(1), attemptId: z.string().uuid() }).strict().parse(await c.req.json());
  const replacement = await operatorTransition(() => admission.run(() => runtime.runWorkerTransition(async () => {
    const route = routes.get(conversationId);
    if (!route || route.attemptId !== attemptId) throw new Error("Stale replacement request.");
    await workerRequest(workerConfig.launcherUrl, launcherToken, "/v1/stop", { attemptId }, undefined, workerConfig.launcherTimeoutMs);
    const status = await launcherStatus();
    const retired = status.attempts.find(attempt => attempt.attemptId === attemptId);
    if (!status.driverReachable || retired?.phase !== "stopped" || retired.observed !== "absent") throw new Error("Retirement is not confirmed.");
    await routes.retiring(conversationId, attemptId);
    return await routes.replaceRetired(conversationId, attemptId, workerConfig.configurationRevision);
  })));
  return c.json({ conversationId, attemptId: replacement.attemptId, phase: replacement.phase });
});
// Keep worker support available until the launcher confirms retirement.
async function drainBackend() {
  await admission.quiesce();
  await workerRequest(workerConfig.launcherUrl, launcherToken, "/v1/drain", {}, undefined, workerConfig.launcherTimeoutMs);
  const status = await launcherStatus();
  if (!status.drainComplete) throw new Error("Worker retirement remains unresolved.");
  await providerSetup?.quiesce();
  await support.quiesce();
  credentialsQuiesced = false;
  const results = await Promise.allSettled([connections.quiesce(), auth.quiesce(), credentials?.quiesce()]);
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Credential drain failed.");
  credentialsQuiesced = true;
}
app.post("/internal/drain", async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  await operatorTransition(drainBackend);
  return c.json({ quiesced: admission.quiesced && support.quiesced && credentialsQuiesced });
});
app.post("/internal/sleep", bodyLimit({ maxSize: 1024 }), async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  z.object({}).strict().parse(await c.req.json());
  const idle = await operatorTransition(async () => {
    if (closing || (!plannedQuiescence && !ready())) throw new Error("Backend is not ready for planned sleep.");
    plannedQuiescence = true;
    await admission.quiesce();
    if (!await runtime.retireIdleWorkers()) return false;
    // No workers remain; this existing final drain cannot cancel native work.
    await drainBackend();
    return true;
  });
  return idle ? c.json({ quiesced: true }) : c.json({ quiesced: false, reason: "busy" }, 409);
});
app.post("/internal/undrain", async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  await operatorTransition(async () => {
    if (closing) throw new Error("Backend shutdown is in progress.");
    await resumeCredentials();
    await support.resume();
    providerSetup?.resume();
    await support.run(() => directory.startMcpConnections());
    await workerRequest(workerConfig.launcherUrl, launcherToken, "/v1/undrain", {}, undefined, workerConfig.launcherTimeoutMs);
    await admission.resume();
    plannedQuiescence = false;
  });
  return c.json({ admitting: admission.admitting });
});
app.get("/internal/status", async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  const status = await launcherStatus();
  return c.json({ schemaVersion: 1, installation: workerConfig.installationId, drained: status.drained, drainComplete: status.drainComplete, backendQuiesced: admission.quiesced && support.quiesced && credentialsQuiesced, activeWorkers: status.activeWorkers.length, unresolvedAttempts: status.unresolvedAttempts.length });
});
const clientDir = process.env.DISPATCH_CLIENT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../client");
app.route("/", createApp({ auth, runtime, mcpConnections: connections, providerSetup, origin: config.origin,
  clientDir: process.env.DISPATCH_SERVE_CLIENT === "false" ? undefined : clientDir,
  configuration: async () => ({ company: { id: config.companyId, name: config.companyName }, defaultAgentId: DEFAULT_AGENT_ID, ...await provider.configuration(await runtime.getDefaultAgent(config.companyId)) }),
}));
app.onError((error, c) => error instanceof RuntimeError && error.status === 403
  ? c.json({ error: "Forbidden" }, 403)
  : c.json({ error: "Internal worker request failed" }, 503));
let closing = false;
let shutdown: Promise<void> | undefined;
let teardownStarted = false;
function close(retireOnly = false, beforeSupportClose?: () => Promise<void>): Promise<void> {
  closing = true;
  clearInterval(idleTimer);
  plannedQuiescence = false;
  return shutdown ??= operatorTransition(async () => {
    // Persist admission closure and join worker effects before releasing owners.
    // An unresolved retirement leaves the server available for status/recovery,
    // never reporting a successful shutdown or reopening application admission.
    if (retireOnly) {
      // Handover preserves workers and the persisted installation drain state.
      await admission.suspend();
      await beforeSupportClose?.();
      await providerSetup?.close();
      await support.quiesce();
      await Promise.all([connections.quiesce(), auth.quiesce(), credentials?.quiesce()]);
    } else await drainBackend();
    teardownStarted = true;
    const failures: unknown[] = [];
    // Attempt every independent cleanup even if an earlier close fails. Retain
    // the terminal result: closing owners is not a replayable drain operation.
    for (const cleanup of [
      async () => { await providerSetup?.close(); },
      () => runtime.close(),
      () => { cleanupSessionResources(); },
      () => connections.close(),
      () => archives.close(),
      () => artifacts.close(),
      () => stores.close(),
      () => auth.close(),
      () => credentials?.close(),
    ]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Backend resource teardown failed.");
  }).catch(error => {
    if (!teardownStarted) shutdown = undefined;
    throw error;
  });
}
function resourcesHealthy() {
  if (closing) return false;
  // Local dependency health only: no ECS inventory or launcher mutation queue.
  routes.admissionBlocked();
  return stores.healthy && directory.healthy && auth.healthy && connections.healthy && (!credentials || credentials.healthy);
}
function resourcesReady() {
  return support.admitting && resourcesHealthy() && (!credentials || credentials.admitting) && auth.admitting && connections.admitting;
}
function ready() { return admission.admitting && resourcesReady(); }
function healthReady() { return ready() || (plannedQuiescence && resourcesHealthy()); }
let idleSweep: Promise<void> | undefined;
const idleTimer = setInterval(() => {
  if (idleSweep || !ready()) return;
  idleSweep = admission.run(() => runtime.retireInactiveWorkers(workerConfig.workerIdleTimeoutMs)).catch(() => {
    console.warn("Idle worker retirement incomplete; the next sweep will reconcile the recorded attempts.");
  }).finally(() => { idleSweep = undefined; });
}, 30_000);
idleTimer.unref();
startupCleanup.push(async () => { clearInterval(idleTimer); await idleSweep; });
return { app, tls, host: config.host, port: config.port,
  close: () => close(), retire: (beforeSupportClose?: () => Promise<void>) => close(true, beforeSupportClose), ready, healthReady, supportReady: resourcesReady,
};
} catch (error) {
  const failures: unknown[] = [error];
  for (const cleanup of startupCleanup.reverse()) {
    try { await cleanup(); } catch (failure) { failures.push(failure); }
  }
  throw new AggregateError(failures, "Backend startup failed; resource cleanup attempted.");
}
}
