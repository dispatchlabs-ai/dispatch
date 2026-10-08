import { McpPolicyGate } from "./mcp-policy.js";
import { backendWorkerMcp } from "./mcp.js";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createServer as createHttpsServer } from "node:https";
import { createSecureContext } from "node:tls";
import { Hono } from "hono";
import { once } from "node:events";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { bodyLimit } from "hono/body-limit";
import { S3Artifacts, s3ArtifactsConfigSchema } from "./s3-artifacts.js";
import { ATTACHMENT_RPC_MAX_BYTES, attachmentSaveRequestSchema, attachmentReadRequestSchema, decodeAttachmentBytes } from "./attachments.js";
import { z } from "zod";
import { createAuth } from "../auth.js";
import { createApp } from "../app.js";
import { readConfig } from "../config.js";
import { readDirectoryStoreConfig } from "../storage/directory-config.js";
import { openModels } from "../model-auth.js";
import { DispatchRuntime, RuntimeError, type WorkerManagementActor } from "../runtime.js";
import { McpConnections } from "../mcp-connections.js";
import { WorkerRoutes } from "./routes.js";
import { readRoutingStoreConfig, openConfiguredWorkerRoutes } from "./routing-config.js";
import { distributedRuntime } from "./distributed.js";
import { tokenMatches, workerToken } from "./identity.js";
import { workerRequest } from "./transport.js";
import type { LauncherStatus } from "./launcher.js";
import { WorkerStoreProvisioner } from "./postgres-stores.js";
import { verifiedPostgresConfig } from "../storage/postgres/tls.js";
import { WriteAdmission } from "./admission.js";

const filename = process.env.DISPATCH_BACKEND_WORKERS_CONFIG_FILE;
if (!filename) throw new Error("DISPATCH_BACKEND_WORKERS_CONFIG_FILE is required.");
const workerConfig = z.object({ routingStoreConfigFile: z.string().startsWith("/").optional(), directoryStoreConfigFile: z.string().startsWith("/").optional(), tls: z.object({ keyFile: z.string().startsWith("/"), certFile: z.string().startsWith("/") }).strict().optional(), postgresStores: z.object({ adminUrlFile: z.string().startsWith("/"), caFile: z.string().startsWith("/").optional() }).strict(), artifacts: s3ArtifactsConfigSchema, installationId: z.string().min(1), workerKeyFile: z.string(), launcherTokenFile: z.string(), operatorTokenFile: z.string(), launcherUrl: z.url(), launcherTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000), configurationRevision: z.string().min(1) }).strict().parse(JSON.parse(await readFile(filename, "utf8")));
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
const startupCleanup: Array<() => void | Promise<void>> = [];
try {
const routes = routingConfig ? await openConfiguredWorkerRoutes(routingConfig)
  : await WorkerRoutes.open(join(config.stateDir, "routing"), workerConfig.installationId);
startupCleanup.push(() => routes.close());
const admission = new WriteAdmission(routes.admissionBlocked(), async blocked => { await routes.setAdmissionBlocked(blocked); });
const artifacts = await S3Artifacts.open(workerConfig.artifacts);
startupCleanup.push(() => artifacts.close());
const workerKey = (await readFile(workerConfig.workerKeyFile, "utf8")).trim();
const stores = await WorkerStoreProvisioner.open({ connectionString: storeUrl, ca: storeCa, installationId: workerConfig.installationId, credentialKey: workerKey });
startupCleanup.push(() => stores.close());
const launcherToken = (await readFile(workerConfig.launcherTokenFile, "utf8")).trim();
const operatorToken = (await readFile(workerConfig.operatorTokenFile, "utf8")).trim();
await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
await mkdir(config.workspaceDir, { recursive: true, mode: 0o700 });
startupCleanup.push(() => { cleanupSessionResources(); });
const provider = await openModels();
const auth = await createAuth({ databasePath: join(config.stateDir, "auth.sqlite"), secretPath: join(config.stateDir, "auth.key"), origin: config.origin, rpId: config.rpId, companyId: config.companyId, companyName: config.companyName });
startupCleanup.push(() => auth.close());
const connections = new McpConnections(join(config.stateDir, "connections.sqlite"), join(config.stateDir, "connections.key"), config.origin);
startupCleanup.push(() => connections.close());
const support = new WriteAdmission(false, async () => {});
const directory = await DispatchRuntime.open({
  runMcpBackground: operation => support.run(operation), stateDir: join(config.stateDir, "runtime"), companyId: config.companyId, models: provider.models, directoryOnly: true,
  piStorage: directoryStorage, workspaceDir: config.workspaceDir, connectionsFile: config.connectionsFile, mcpConnections: connections,
  provider: provider.provider, modelId: provider.modelId, thinkingLevel: provider.thinkingLevel, readAllProjectUserIds: config.readAllProjectUserIds,
  peopleDirectory: { list: async companyId => auth.listCompanyPeople(companyId), get: async (companyId, userId) => auth.getCompanyPerson(companyId, userId) },
});
startupCleanup.push(async () => { try { await support.quiesce(); } finally { await directory.close(); } });
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
  const currentRoute = () => {
    const route = routes.get(c.req.param("conversation"));
    if (!route || route.attemptId !== c.req.param("attempt") || route.phase === "retiring" || !tokenMatches(workerToken(workerKey, workerConfig.installationId, route), c.req.header("Authorization")))
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
  if (operation === "model-auth") {
    const { provider: providerId } = z.object({ provider: z.string() }).strict().parse(input);
    const catalog = await directory.exportWorkerCatalog(route.companyId);
    if (!catalog.agents.some(agent => agent.provider === providerId && !agent.archived)) return c.json({ error: "Forbidden" }, 403);
    return c.json(await provider.models.getAuth(providerId) ?? null);
  }
  if (operation === "people" || operation === "person") {
    const person = z.object({ companyId: z.string(), userId: z.string().optional() }).strict().parse(input);
    if (person.companyId !== route.companyId) return c.json({ error: "Forbidden" }, 403);
    return c.json(operation === "people" ? await auth.listCompanyPeople(route.companyId) : await auth.getCompanyPerson(route.companyId, person.userId ?? ""));
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
  const replacement = await operatorTransition(() => admission.run(() => mcpPolicy.change(async () => {
    const route = routes.get(conversationId);
    if (!route || route.attemptId !== attemptId) throw new Error("Stale replacement request.");
    await workerRequest(workerConfig.launcherUrl, launcherToken, "/v1/stop", { attemptId }, undefined, workerConfig.launcherTimeoutMs);
    const status = await workerRequest<LauncherStatus>(workerConfig.launcherUrl, launcherToken, "/v1/status");
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
  const status = await workerRequest<LauncherStatus>(workerConfig.launcherUrl, launcherToken, "/v1/status");
  if (!status.drainComplete) throw new Error("Worker retirement remains unresolved.");
  await support.quiesce();
  await connections.quiesce();
  await auth.quiesce();
}
app.post("/internal/drain", async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  await operatorTransition(drainBackend);
  return c.json({ quiesced: admission.quiesced && support.quiesced });
});
app.post("/internal/undrain", async c => {
  if (!tokenMatches(operatorToken, c.req.header("Authorization"))) return c.json({ error: "Forbidden" }, 403);
  await operatorTransition(async () => {
    if (closing) throw new Error("Backend shutdown is in progress.");
    await connections.resume();
    await auth.resume();
    if (!connections.admitting || !auth.admitting) throw new Error("Credential admission remains closed.");
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
app.onError((error, c) => error instanceof RuntimeError && error.status === 403
  ? c.json({ error: "Forbidden" }, 403)
  : c.json({ error: "Internal worker request failed" }, 503));
const listener = { fetch: app.fetch, hostname: config.host, port: config.port };
const server = tls
  ? serve({ ...listener, createServer: createHttpsServer, serverOptions: tls })
  : serve(listener);
startupCleanup.push(() => {
  server.close();
  if ("closeAllConnections" in server) server.closeAllConnections();
});
await once(server, "listening");
let closing = false;
let shutdown: Promise<void> | undefined;
let teardownStarted = false;
function close(): Promise<void> {
  closing = true;
  return shutdown ??= operatorTransition(async () => {
    // Persist admission closure and join worker effects before releasing owners.
    // An unresolved retirement leaves the server available for status/recovery,
    // never reporting a successful shutdown or reopening application admission.
    await drainBackend();
    teardownStarted = true;
    const failures: unknown[] = [];
    // Attempt every independent cleanup even if an earlier close fails. Retain
    // the terminal result: closing owners is not a replayable drain operation.
    for (const cleanup of [
      () => { server.close(); },
      () => runtime.close(),
      () => { cleanupSessionResources(); },
      () => connections.close(),
      () => artifacts.close(),
      () => stores.close(),
      () => auth.close(),
      () => { if ("closeAllConnections" in server) server.closeAllConnections(); },
    ]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Backend resource teardown failed.");
  }).catch(error => {
    if (!teardownStarted) shutdown = undefined;
    throw error;
  });
}
function requestShutdown() {
  void close().catch(() => {
    process.exitCode = 1;
    console.error(teardownStarted
      ? "Backend resource teardown failed; admission remains closed. Operator intervention required."
      : "Backend shutdown incomplete; admission remains closed. Resolve retirement and retry shutdown.");
  });
}
process.on("SIGTERM", requestShutdown); process.on("SIGINT", requestShutdown);
} catch (error) {
  const failures: unknown[] = [error];
  for (const cleanup of startupCleanup.reverse()) {
    try { await cleanup(); } catch (failure) { failures.push(failure); }
  }
  throw new AggregateError(failures, "Backend startup failed; resource cleanup attempted.");
}
