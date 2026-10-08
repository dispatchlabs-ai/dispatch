import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { mkdir } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { DispatchRuntime, RuntimeError, type ConversationWorkerBootstrap, type WorkerCatalogSnapshot } from "../runtime.js";
import { openModels } from "../model-auth.js";
import { workerModels } from "./models.js";
import { ATTACHMENT_RPC_MAX_BYTES, decodeAttachmentBytes, RemoteAttachmentStore } from "./attachments.js";
import type { WorkerStoreConfig } from "./postgres-stores.js";
import { tokenMatches } from "./identity.js";
import { workerRequest } from "./transport.js";
import type { AuthResult } from "@earendil-works/pi-ai";
import type { RuntimeScope, SendMessageInput, AddParticipantsInput, UpdateChatInput } from "../../src/shared/contracts.js";

const env = z.object({
  DISPATCH_BACKEND_INTERNAL_URL: z.url(), DISPATCH_WORKER_TOKEN: z.string().min(43),
  DISPATCH_WORKER_ATTEMPT_ID: z.string().min(1), DISPATCH_CONVERSATION_ID: z.string().min(1),
  DISPATCH_POSTGRES_STORE_ID: z.string().min(1),
}).parse(process.env);
const path = `/internal/workers/${encodeURIComponent(env.DISPATCH_CONVERSATION_ID)}/${encodeURIComponent(env.DISPATCH_WORKER_ATTEMPT_ID)}`;
const backend = <T>(suffix: string, body?: unknown, signal?: AbortSignal) => workerRequest<T>(env.DISPATCH_BACKEND_INTERNAL_URL, env.DISPATCH_WORKER_TOKEN, path + suffix, body, signal);
const bootstrap = await backend<ConversationWorkerBootstrap & { storage: WorkerStoreConfig }>("/bootstrap");
if (bootstrap.conversationKey !== env.DISPATCH_CONVERSATION_ID || bootstrap.storeId !== env.DISPATCH_POSTGRES_STORE_ID || bootstrap.storage.storeId !== bootstrap.storeId || bootstrap.storage.access !== "worker") throw new Error("Worker bootstrap identity mismatch.");
await mkdir("/workspace/state", { recursive: true, mode: 0o700 });
const providers = await openModels({ DISPATCH_PI_AGENT_DIR: "/workspace/provider-catalog" });
const models = workerModels(providers.models.getProviders(), (provider, signal) => backend<AuthResult | undefined>("/model-auth", { provider }, signal));
const runtime = await DispatchRuntime.openConversation({
  stateDir: "/workspace/state", workspaceDir: "/workspace", companyId: bootstrap.scope.companyId,
  piStorage: bootstrap.storage, models,
  peopleDirectory: { list: companyId => backend("/people", { companyId }), get: (companyId, userId) => backend("/person", { companyId, userId }) },
  attachmentStore: new RemoteAttachmentStore((operation, input) => backend(`/attachment/${operation}`, input)),
  workerInvitations: { invite: (actor, requestId, definitionIds) => backend("/invitation", { actor, requestId, definitionIds }) },
  workerManagement: {
    read: (actor, input) => backend("/management/read", { actor, input }),
    save: (actor, callId, input) => backend("/management/save", { actor, callId, input }),
  },
}, bootstrap);
const binding = await runtime.workerBinding();
if (!binding?.roomId) throw new Error("Worker room binding missing.");
const roomId = String(binding.roomId);
const app = new Hono();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") || !tokenMatches(env.DISPATCH_WORKER_TOKEN, c.req.header("Authorization"))) return c.json({ error: "Unauthorized" }, 401);
  await next();
});
app.use("*", bodyLimit({ maxSize: ATTACHMENT_RPC_MAX_BYTES, onError: c => c.json({ error: "Request too large" }, 413) }));
app.get("/ready", c => c.json({ roomId, conversationId: env.DISPATCH_CONVERSATION_ID, attemptId: env.DISPATCH_WORKER_ATTEMPT_ID }));
const rpcSchema = z.object({
  scope: z.object({ companyId: z.string(), userId: z.string() }).strict(),
  method: z.enum(["getChat", "submit", "composing", "addParticipants", "stop", "updateChat", "renameChat", "authorizeAttachmentUpload", "uploadAttachment", "downloadAttachment"]),
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
  const { catalog } = z.object({ catalog: z.custom<WorkerCatalogSnapshot>() }).strict().parse(await c.req.json());
  await runtime.applyWorkerCatalog(catalog);
  return c.json({ revision: catalog.revision });
});
app.post("/rpc", async c => {
  const { method, scope, input, catalog, membership } = rpcSchema.parse(await c.req.json());
  if (scope.companyId !== bootstrap.scope.companyId) return c.json({ error: "Forbidden" }, 403);
  await runtime.applyWorkerCatalog(catalog);
  await runtime.applyWorkerMembership(membership);
  let result: unknown;
  switch (method) {
    case "uploadAttachment": {
      const file = z.object({ name: z.string().max(4096), mimeType: z.string().max(256), dataBase64: z.string() }).strict().parse(input);
      result = await runtime.uploadAttachment(scope, roomId, new File([new Uint8Array(decodeAttachmentBytes(file.dataBase64))], file.name, { type: file.mimeType })); break;
    }
    case "downloadAttachment": {
      const download = await runtime.downloadAttachment(scope, roomId, z.string().uuid().parse(input));
      result = { attachment: download.attachment, dataBase64: download.bytes.toString("base64") }; break;
    }
    case "getChat": result = await runtime.getChat(scope, roomId); break;
    case "submit": result = await runtime.submit(scope, roomId, input as SendMessageInput); break;
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
  const status = error instanceof RuntimeError && [400, 403, 404, 409].includes(error.status) ? error.status as 400 | 403 | 404 | 409 : error instanceof z.ZodError ? 400 : 503;
  return c.json({ error: "Worker operation failed" }, status);
});
const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 8831 });
let closing = false;
async function close() {
  if (closing) return; closing = true; server.close();
  console.info("Worker shutdown: runtime close started");
  await runtime.close();
  console.info("Worker shutdown: runtime close completed");
  // This process owns only this conversation. Release provider session sockets
  // after Pi has joined execution and closed durable storage.
  cleanupSessionResources();
  if ("closeAllConnections" in server) server.closeAllConnections();
  console.info("Worker shutdown: remaining resources", process.getActiveResourcesInfo());
}
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
