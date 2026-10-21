import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { type AssistantMessageEvent, type ClassifierContext, type ClassifierModel, type Context, type DeferredHandle, type ImageModel, type ImagesContext, type Model, type Provider } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { EcsOwnership } from "./ownership.js";
import { forward } from "./forward.js";
import { GatewayAuth } from "./auth.js";
import { HttpError, parseConfig } from "./config.js";
import { catalog, connectionModel, createConnections, nativeContext, publicMessage, requestOptions, type Connection } from "./engine.js";

const requestSchema = z.object({
  model: z.string().min(1),
  operation: z.enum(["stream", "streamSimple", "fetchDeferred", "cancelDeferred", "generateImages", "classify"]).default("streamSimple"),
  context: z.unknown().optional(), handle: z.unknown().optional(),
  options: z.record(z.string(), z.unknown()).default({}),
}).strict();
const contextSchema = z.object({ messages: z.array(z.object({ role: z.enum(["system", "user", "assistant", "toolResult"]) }).passthrough()) }).passthrough();
const handleSchema = z.object({ id: z.string(), provider: z.string(), modelId: z.string(), api: z.string() }).passthrough();

async function readBody(request: IncomingMessage): Promise<Buffer> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "json_required");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32 * 1024 * 1024) throw new HttpError(413, "request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  try { return JSON.parse(body.toString()); } catch { throw new HttpError(400, "invalid_json"); }
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function compactEvent(event: AssistantMessageEvent): Record<string, unknown> {
  if (event.type === "done" || event.type === "error") throw new Error("Terminal events need public metadata");
  const { partial, ...wire } = event;
  if (event.type === "toolcall_start") {
    const block = partial.content[event.contentIndex];
    if (block?.type === "toolCall") return { ...wire, id: block.id, toolName: block.name };
  }
  if (event.type === "text_end" || event.type === "thinking_end") {
    const block = partial.content[event.contentIndex];
    if (block?.type === "text") return { ...wire, contentSignature: block.textSignature };
    if (block?.type === "thinking") return { ...wire, contentSignature: block.thinkingSignature, redacted: block.redacted };
  }
  return wire;
}

export async function createGatewayServer(configuration: unknown, extraProviders: readonly Provider[] = [], ownership?: EcsOwnership) {
  const config = parseConfig(configuration);
  const secrets = new SecretsManagerClient({ region: config.region });
  const signing = await secrets.send(new GetSecretValueCommand({ SecretId: config.sessionSecretId }));
  if (!/^[a-f0-9]{64}$/.test(signing.SecretString ?? "")) throw new Error("Invalid session signing secret");
  const auth = new GatewayAuth(config, Buffer.from(signing.SecretString!, "hex"));
  const pendingCredentials = new Set<Promise<unknown>>();
  const pendingRequests = new Set<Promise<unknown>>();
  const connections = new Map<string, Connection>();
  let initialization: Promise<void> | undefined;
  const initialize = () => initialization ??= createConnections(config, secrets, extraProviders, ownership ? () => ownership.assertOwner() : undefined, pendingCredentials).then((items) => {
    for (const [id, item] of items) connections.set(id, item);
  }).catch((error) => { initialization = undefined; throw error; });
  if (!ownership) await initialize();

  const server = createServer((request, response) => {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    const controller = new AbortController();
    response.on("close", () => { if (!response.writableFinished) controller.abort(); });
    request.on("aborted", () => controller.abort());
    const pending = (async () => {
      const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
      if (request.method === "GET" && path === "/healthz") { json(response, 200, { status: "ok" }); return; }
      if (request.method === "POST" && path === "/v1/auth/aws") { json(response, 200, await auth.exchange(await readJson(request), controller.signal)); return; }
      const principal = auth.verify(request.headers.authorization);
      const isCatalog = request.method === "GET" && path === "/v1/catalog";
      const match = /^\/v1\/connections\/([a-z0-9][a-z0-9_-]*)\/(messages|operations)$/.exec(path);
      if (!isCatalog && (request.method !== "POST" || !match)) throw new HttpError(404, "not_found");
      if (ownership) {
        const target = ownership.route();
        if (!target.local) {
          await forward(request, response, target.address, config.port, path, isCatalog ? undefined : await readBody(request), controller.signal);
          return;
        }
        await ownership.assertOwner();
        await initialize();
        ownership.route();
      }
      if (isCatalog) { json(response, 200, await catalog(connections, principal, config.audience)); return; }
      if (!match) throw new HttpError(404, "not_found");
      const parsed = requestSchema.safeParse(await readJson(request));
      if (!parsed.success) throw new HttpError(400, "invalid_request");
      const body = parsed.data;
      const streams = body.operation === "stream" || body.operation === "streamSimple" || body.operation === "fetchDeferred";
      if (streams !== (match[2] === "messages")) throw new HttpError(400, "operation_not_allowed");
      const type = body.operation === "generateImages" ? "image" : body.operation === "classify" ? "classifier" : "chat";
      const { connection, model } = connectionModel(connections, principal, match[1], body.model, type);
      const options = requestOptions(body.options, principal, match[1], controller.signal);
      const startedAt = Date.now();
      const audit = (status: string, usage?: unknown) => process.stdout.write(`${JSON.stringify({ requestId, principal: principal.id, connection: match[1], model: model.id, operation: body.operation, status, durationMs: Date.now() - startedAt, ...(usage ? { usage } : {}) })}\n`);

      if (body.operation === "generateImages" || body.operation === "classify") {
        const result = body.operation === "generateImages"
          ? await connection.models.generateImages(model as ImageModel<string>, body.context as ImagesContext, options)
          : await connection.models.classify(model as ClassifierModel<string>, body.context as ClassifierContext, options);
        const { errorMessage: _errorMessage, ...safe } = result;
        if ("diagnostics" in safe) delete safe.diagnostics;
        json(response, 200, { ...safe, provider: match[1], ...(_errorMessage ? { errorMessage: `Provider request failed (request ${requestId})` } : {}) });
        audit(_errorMessage ? "error" : "done");
        return;
      }
      let stream;
      if (body.operation === "fetchDeferred" || body.operation === "cancelDeferred") {
        const parsedHandle = handleSchema.safeParse(body.handle);
        if (!parsedHandle.success) throw new HttpError(400, "invalid_deferred_handle");
        const handle = auth.unseal(parsedHandle.data as DeferredHandle, principal.id, match[1], model.id);
        if (body.operation === "cancelDeferred") {
          await connection.models.cancelDeferred(model as Model<string>, handle, options);
          json(response, 200, { cancelled: true }); audit("cancelled"); return;
        }
        stream = connection.models.streamDeferred(model as Model<string>, handle, options);
      } else {
        if (!contextSchema.safeParse(body.context).success) throw new HttpError(400, "invalid_context");
        const context = nativeContext(body.context as Context, connection);
        stream = body.operation === "stream" ? connection.models.stream(model as Model<string>, context, options) : connection.models.streamSimple(model as Model<string>, context, options);
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
      response.flushHeaders();
      const heartbeat = setInterval(() => { if (!response.writableNeedDrain) response.write(": heartbeat\n\n"); }, 15_000);
      try {
        for await (const event of stream) {
          controller.signal.throwIfAborted();
          let wire: Record<string, unknown>;
          if (event.type === "done" || event.type === "error") {
            const message = publicMessage(event.type === "done" ? event.message : event.error, principal, match[1], auth, requestId);
            wire = { type: event.type, reason: event.reason, usage: message.usage, responseId: message.responseId, providerThinkingLevel: message.providerThinkingLevel, errorMessage: message.errorMessage, message };
            audit(event.type === "done" ? event.reason : "error", message.usage);
          } else wire = compactEvent(event);
          if (!response.write(`data: ${JSON.stringify(wire)}\n\n`)) await once(response, "drain", { signal: controller.signal });
        }
        response.end();
      } finally { clearInterval(heartbeat); controller.abort(); }
    })().catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 502;
      const code = error instanceof HttpError ? error.code : controller.signal.aborted ? "request_aborted" : "gateway_request_failed";
      // Never log provider errors, bodies, prompts, credentials, or authentication headers.
      process.stdout.write(`${JSON.stringify({ requestId, status, code })}\n`);
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else json(response, status, { error: { code, message: `${code} (request ${requestId})` } });
    });
    pendingRequests.add(pending);
    void pending.finally(() => pendingRequests.delete(pending));
  });
  server.requestTimeout = 120_000;
  let closing: Promise<void> | undefined;
  const closeCredentials = () => closing ??= (async () => {
    await Promise.allSettled([...pendingRequests]);
    await initialization?.catch(() => undefined);
    // Native Pi may continue a refresh after its caller disconnects.
    while (pendingCredentials.size) await Promise.allSettled([...pendingCredentials]);
    secrets.destroy();
  })();
  server.on("close", () => { void closeCredentials(); });
  return { server, config, connections, closeCredentials };
}
