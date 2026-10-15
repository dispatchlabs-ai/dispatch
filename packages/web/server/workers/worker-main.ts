import { httpTelemetry, closeTelemetry } from "../telemetry.js";
import { CollaborationError } from "../collaboration/shared.js";
import { ProjectAccessError } from "../project-access.js";
import { ProjectArchiveError } from "../project-archives.js";
import { AttachmentError } from "../attachments.js";
import { HistoryCursorError } from "../chat-pages.js";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { mkdir } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { DispatchRuntime, RuntimeError, type ConversationWorkerBootstrap, type WorkerCatalogSnapshot } from "../runtime.js";
import { openModels } from "../model-auth.js";
import { WriteAdmission } from "./admission.js";
import { workerMcp } from "./mcp.js";
import { workerModels } from "./models.js";
import { ATTACHMENT_RPC_MAX_BYTES, decodeAttachmentBytes, RemoteAttachmentStore } from "./attachments.js";
import type { WorkerStoreConfig } from "./postgres-stores.js";
import { tokenMatches } from "./identity.js";
import { validateBackendCa, workerRequest } from "./transport.js";
import type { AuthCheck, AuthResult } from "@earendil-works/pi-ai";
import type { RuntimeScope, SendMessageInput, AddParticipantsInput, UpdateChatInput } from "../../src/shared/contracts.js";
import { awaitWarmAssignment } from "./warm-worker.js";
import type { WorkerSummary } from "./summaries.js";

await awaitWarmAssignment();
const env = z.object({
  DISPATCH_BACKEND_CA_PEM: z.string().optional(),
  DISPATCH_BACKEND_INTERNAL_URL: z.url(), DISPATCH_WORKER_TOKEN: z.string().min(43),
  DISPATCH_WORKER_ATTEMPT_ID: z.string().min(1), DISPATCH_CONVERSATION_ID: z.string().min(1),
  DISPATCH_POSTGRES_STORE_ID: z.string().min(1),
}).parse(process.env);
if (env.DISPATCH_BACKEND_CA_PEM !== undefined) {
  validateBackendCa(env.DISPATCH_BACKEND_CA_PEM);
  if (new URL(env.DISPATCH_BACKEND_INTERNAL_URL).protocol !== "https:") throw new Error("Backend CA requires HTTPS.");
}
const path = `/internal/workers/${encodeURIComponent(env.DISPATCH_CONVERSATION_ID)}/${encodeURIComponent(env.DISPATCH_WORKER_ATTEMPT_ID)}`;
const backend = <T>(suffix: string, body?: unknown, signal?: AbortSignal) => workerRequest<T>(env.DISPATCH_BACKEND_INTERNAL_URL, env.DISPATCH_WORKER_TOKEN, path + suffix, body, signal, 60_000, env.DISPATCH_BACKEND_CA_PEM);
const bootstrap = await backend<ConversationWorkerBootstrap & { storage: WorkerStoreConfig }>("/bootstrap");
if (bootstrap.conversationKey !== env.DISPATCH_CONVERSATION_ID || bootstrap.storeId !== env.DISPATCH_POSTGRES_STORE_ID || bootstrap.storage.storeId !== bootstrap.storeId || bootstrap.storage.access !== "worker") throw new Error("Worker bootstrap identity mismatch.");
await mkdir("/workspace/state", { recursive: true, mode: 0o700 });
const providers = await openModels({ DISPATCH_PI_AGENT_DIR: "/workspace/provider-catalog" });
const models = workerModels(providers.models.getProviders(),
  (provider, signal) => backend<AuthResult | undefined>("/model-auth", { provider }, signal),
  (provider, signal) => backend<AuthCheck | undefined>("/model-auth-check", { provider }, signal));
const runtime = await DispatchRuntime.openConversation({
  stateDir: "/workspace/state", workspaceDir: "/workspace", companyId: bootstrap.scope.companyId,
  piStorage: bootstrap.storage, models,
  workerParticipants: { report: report => backend("/participants/report", report) },
  workerGitHub: (actor, bindingId, operation, signal) => {
    if (new URL(env.DISPATCH_BACKEND_INTERNAL_URL).protocol !== "https:") throw new RuntimeError(503, "GitHub credentials require encrypted backend transport.");
    return backend("/github", { actor, bindingId, operation }, signal);
  },
  workerSecrets: (actor, secretId, signal) => {
    if (new URL(env.DISPATCH_BACKEND_INTERNAL_URL).protocol !== "https:") throw new RuntimeError(503, "Secrets require encrypted backend transport.");
    return backend("/secrets", { actor, secretId }, signal);
  },
  workerProjectSpec: (actor, input) => backend("/project-spec", { actor, input }),
  workerProjectChats: {
    list: (actor, input) => backend("/project-chats", { actor, input }),
    read: (actor, input) => backend("/project-chat-read", { actor, input }),
  },
  workerSearch: (actor, query, signal) => backend("/search", { actor, query }, signal),
  workerMcp: workerMcp((operation, input, signal) => backend(`/mcp/${operation}`, input, signal)),
  peopleDirectory: { list: companyId => backend("/people", { companyId }), get: (companyId, userId) => backend("/person", { companyId, userId }) },
  attachmentStore: new RemoteAttachmentStore((operation, input) => backend(`/attachment/${operation}`, input)),
  workerInvitations: {
    invite: (actor, requestId, definitionIds) => backend("/invitation", { actor, requestId, definitionIds }),
    createInstance: (actor, input) => backend("/instance", { actor, input }),
  },
  workerManagement: {
    read: (actor, input) => backend("/management/read", { actor, input }),
    save: (actor, callId, input) => backend("/management/save", { actor, callId, input }),
  },
}, bootstrap);
const binding = await runtime.workerBinding();
if (!binding?.roomId) throw new Error("Worker room binding missing.");
const roomId = String(binding.roomId);
const admission = new WriteAdmission(false, async () => {});
const app = new Hono();
app.use("*", httpTelemetry());
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") || !tokenMatches(env.DISPATCH_WORKER_TOKEN, c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
  await next();
});
// Outside ordinary RPC admission: this command must join, not wait on itself.
app.post("/idle-retire", bodyLimit({ maxSize: 1024 }), async c => {
  const { minimumIdleMs } = z.object({ minimumIdleMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict().parse(await c.req.json());
  return c.json({ idle: await retireIfIdle(minimumIdleMs), attemptId: env.DISPATCH_WORKER_ATTEMPT_ID, summary: retiredSummary });
});
app.use("*", async (c, next) => {
  if (!admission.admitting) return c.json({ error: "Worker is closing" }, 503);
  await admission.run(next);
});
app.use("*", bodyLimit({ maxSize: ATTACHMENT_RPC_MAX_BYTES, onError: c => c.json({ error: "Request too large" }, 413) }));
app.get("/ready", c => c.json({ roomId, conversationId: env.DISPATCH_CONVERSATION_ID, attemptId: env.DISPATCH_WORKER_ATTEMPT_ID, idleTimeoutSupported: true }));
const rpcSchema = z.object({
  scope: z.object({ companyId: z.string(), userId: z.string() }).strict(),
  method: z.enum(["removeParticipant", "workerInstanceResult", "exportProjectArchive", "transcriptPage", "publicDetail", "saveDefinitionOfDone", "getChat", "validateSubmit", "submit", "submitAndGetChat", "composing", "addParticipants", "stop", "updateChat", "renameChat", "authorizeAttachmentUpload", "uploadAttachment", "downloadAttachment"]),
  input: z.unknown().optional(), catalog: z.custom<WorkerCatalogSnapshot>(),
  membership: z.custom<import("../runtime.js").WorkerMembershipSnapshot>(),
}).strict();
// Apply the catalog and admit its command as one ordered operation. Otherwise
// concurrent requests can apply a newer policy between an older apply and use.
let rpcTail: Promise<void> = Promise.resolve();
app.use("*", async (c, next) => {
  if (c.req.path !== "/rpc" && c.req.path !== "/sync") return next();
  const operation = rpcTail.then(next);
  rpcTail = operation.catch(() => {});
  await operation;
});
app.post("/sync", async c => {
  const { catalog, membership } = z.object({ catalog: z.custom<WorkerCatalogSnapshot>(), membership: z.custom<import("../runtime.js").WorkerMembershipSnapshot>() }).strict().parse(await c.req.json());
  await runtime.applyWorkerCatalog(catalog);
  await runtime.applyWorkerMembership(membership);
  return c.json({ revision: catalog.revision, membershipRevision: membership.revision });
});
app.post("/rpc", async c => {
  const { method, scope, input, catalog, membership } = rpcSchema.parse(await c.req.json());
  if (scope.companyId !== bootstrap.scope.companyId) return c.json({ error: "Forbidden" }, 403);
  await runtime.applyWorkerCatalog(catalog);
  await runtime.applyWorkerMembership(membership);
  let result: unknown;
  switch (method) {
    case "removeParticipant": {
      const { participantId } = z.object({ participantId: z.string().min(1).max(200) }).strict().parse(input);
      result = await runtime.removeParticipant(scope, roomId, participantId); break;
    }
    case "workerInstanceResult": {
      const { actorId } = z.object({ actorId: z.string().min(1).max(200) }).strict().parse(input);
      result = await runtime.workerInstanceResult(scope, roomId, actorId); break;
    }
    case "exportProjectArchive": {
      const { projectId } = z.object({ projectId: z.string().uuid() }).strict().parse(input);
      result = await runtime.exportProjectArchive(scope, projectId, [roomId]); break;
    }
    case "uploadAttachment": {
      const file = z.object({ name: z.string().max(4096), mimeType: z.string().max(256), dataBase64: z.string() }).strict().parse(input);
      result = await runtime.uploadAttachment(scope, roomId, new File([new Uint8Array(decodeAttachmentBytes(file.dataBase64))], file.name, { type: file.mimeType })); break;
    }
    case "downloadAttachment": {
      const download = await runtime.downloadAttachment(scope, roomId, z.string().uuid().parse(input));
      result = { attachment: download.attachment, dataBase64: download.bytes.toString("base64") }; break;
    }
    case "transcriptPage": {
      const query = z.object({ threadId: z.string().max(300).optional(), before: z.string().max(1000).optional(), mentionsOnly: z.boolean().optional(), messageId: z.string().min(1).max(300).optional(),
        publishedAfter: z.number().int().min(0).optional() }).strict().refine(value => value.publishedAfter === undefined || (!value.before && !value.messageId && !value.mentionsOnly)).parse(input);
      result = await runtime.transcriptPage(scope, roomId, query); break;
    }
    case "publicDetail": {
      const detail = z.object({ kind: z.enum(["message", "activity"]), itemId: z.string().min(1) }).strict().parse(input);
      result = await runtime.publicDetail(scope, roomId, detail.kind, detail.itemId); break;
    }
    case "saveDefinitionOfDone": {
      const value = z.object({ markdown: z.string().max(20000), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().parse(input);
      result = await runtime.saveDefinitionOfDone(scope, roomId, value); break;
    }
    case "getChat": result = await runtime.getChat(scope, roomId); break;
    case "validateSubmit": result = await runtime.validateSubmit(scope, roomId, input as SendMessageInput); break;
    case "submit": result = await runtime.submit(scope, roomId, input as SendMessageInput); break;
    case "submitAndGetChat": result = await runtime.submitAndGetChat(scope, roomId, input as SendMessageInput); break;
    case "composing": result = await runtime.composing(scope, roomId, input as {clientId: string; sequence: number; active: boolean}); break;
    case "addParticipants": result = await runtime.addParticipants(scope, roomId, input as AddParticipantsInput); break;
    case "stop": result = await runtime.stop(scope, roomId); break;
    case "updateChat": result = await runtime.updateChat(scope, roomId, input as UpdateChatInput); break;
    case "renameChat": result = await runtime.renameChat(scope, roomId, z.string().parse(input)); break;
    case "authorizeAttachmentUpload": result = await runtime.authorizeAttachmentUpload(scope, roomId); break;
  }
  return c.json({ result: result ?? null });
});
app.onError((error, c) => {
  if (error instanceof HistoryCursorError) return c.json({ error: { code: "HISTORY_CHANGED" } }, 409);
  const known = error instanceof RuntimeError || error instanceof CollaborationError || error instanceof ProjectAccessError || error instanceof ProjectArchiveError || error instanceof AttachmentError;
  const status = known && [400, 403, 404, 409, 410, 413].includes(error.status) ? error.status as 400 | 403 | 404 | 409 | 410 | 413 : error instanceof z.ZodError ? 400 : 503;
  return c.json({ error: "Worker operation failed" }, status);
});
const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 8831 }, () => {
  console.info(JSON.stringify({ event: "worker.ready", startup_ms: Math.round(process.uptime() * 1000) }));
});
let closing = false;
let runtimeClosed = false;
let retiredSummary: WorkerSummary | undefined;
let idleRetirement: Promise<boolean> | undefined;
let shutdown: Promise<void> | undefined;
let summaryPending: Promise<void> | undefined;
function publishSummary() {
  if (closing || summaryPending) return;
  summaryPending = admission.run(async () => {
    const summary = await runtime.workerSummary();
    await backend("/summary", summary);
  }).catch(() => {
    // Observations are idempotent; the next poll republishes durable state.
    console.warn("Worker summary publication failed");
  }).finally(() => { summaryPending = undefined; });
}
const summaryTimer = setInterval(publishSummary, 1_000);
summaryTimer.unref();
publishSummary();
function retireIfIdle(minimumIdleMs: number): Promise<boolean> {
  if (runtimeClosed) return Promise.resolve(true);
  if (closing) return Promise.reject(new Error("Worker shutdown is already in progress."));
  return idleRetirement ??= (async () => {
    await admission.quiesce();
    const summary = await runtime.workerSummary();
    if (!await runtime.closeWorkerIfIdle(minimumIdleMs)) {
      // A busy refusal restores RPC admission for the same worker attempt.
      if (!closing) await admission.resume();
      return false;
    }
    closing = true;
    clearInterval(summaryTimer);
    cleanupSessionResources();
    runtimeClosed = true;
    retiredSummary = summary;
    // Retain the authenticated listener until the launcher confirms ECS retirement.
    return true;
  })().catch(error => {
    closing = true;
    clearInterval(summaryTimer);
    throw error; // Never reopen an owner after an uncertain close.
  }).finally(() => { if (!closing) idleRetirement = undefined; });
}
function close(): Promise<void> {
  return shutdown ??= (async () => {
    closing = true; server.close();
    clearInterval(summaryTimer);
    await idleRetirement;
    await admission.quiesce();
    console.info("Worker shutdown: runtime close started");
    if (!runtimeClosed) await runtime.close();
    console.info("Worker shutdown: runtime close completed");
    // This process owns only this conversation. Release provider session sockets
    // after Pi has joined execution and closed durable storage.
    cleanupSessionResources();
    await closeTelemetry();
    if ("closeAllConnections" in server) server.closeAllConnections();
    console.info("Worker shutdown: remaining resources", process.getActiveResourcesInfo());
  })();
}
function requestShutdown() {
  void close().catch(() => { process.exitCode = 1; console.error("Worker shutdown incomplete; recovery may be required."); });
}
process.once("SIGTERM", requestShutdown);
process.once("SIGINT", requestShutdown);
