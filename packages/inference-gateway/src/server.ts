import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { type AssistantMessageEvent, type ClassifierContext, type ClassifierModel, type Context, type DeferredHandle, type ImageModel, type ImagesContext, type Model, type Provider } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { EcsOwnership } from "./ownership.js";
import { forward } from "./forward.js";
import { GatewayAuth } from "./auth.js";
import { HttpError, parseConfig, permitted } from "./config.js";
import { catalog, connectionModel, createConnections, nativeContext, publicMessage, requestOptions, type Connection } from "./engine.js";
import { GatewayAccess } from "./access.js";
import { AccessStore, tokenHash } from "./access-store.js";
import { json, readBody, readJson } from "./http.js";
import { responsesRequest, serveResponses, supportsResponses } from "./responses.js";
import { RequestUsage } from "./usage.js";

const requestSchema = z.object({
  model: z.string().min(1),
  operation: z.enum(["stream", "streamSimple", "fetchDeferred", "cancelDeferred", "generateImages", "classify"]).default("streamSimple"),
  context: z.unknown().optional(), handle: z.unknown().optional(),
  options: z.record(z.string(), z.unknown()).default({}),
}).strict();
const contextSchema = z.object({ messages: z.array(z.object({ role: z.enum(["system", "user", "assistant", "toolResult"]) }).passthrough()) }).passthrough();
const handleSchema = z.object({ id: z.string(), provider: z.string(), modelId: z.string(), api: z.string() }).passthrough();

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
  const accessStore = config.access ? new AccessStore(config) : undefined;
  const auth = new GatewayAuth(config, Buffer.from(signing.SecretString!, "hex"), accessStore);
  const access = accessStore ? new GatewayAccess(config, accessStore, auth, secrets) : undefined;
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
      const url = new URL(request.url ?? "/", "http://gateway.invalid");
      const path = url.pathname;
      if (request.method === "GET" && path === "/healthz") { json(response, 200, { status: "ok" }); return; }
      if (request.method === "POST" && path === "/v1/auth/aws") { json(response, 200, await auth.exchange(await readJson(request), controller.signal)); return; }
      if (await access?.publicRoute(request, response, url, controller.signal)) return;
      const principal = await auth.verify(request.headers.authorization);
      if (await access?.authenticatedRoute(request, response, url, principal)) return;
      const isCatalog = request.method === "GET" && ["/v1/catalog", "/v1/models"].includes(path);
      const isResponses = request.method === "POST" && path === "/v1/responses";
      const match = /^\/v1\/connections\/([a-z0-9][a-z0-9_-]*)\/(messages|operations)$/.exec(path);
      if (!isCatalog && !isResponses && (request.method !== "POST" || !match)) throw new HttpError(404, "not_found");
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
      if (isCatalog) {
        const available = await catalog(connections, principal, config.audience);
        const routes = available.connections.flatMap((connection) => connection.models.filter((model) => (model.type === undefined || model.type === "chat") && supportsResponses(model.api)).map((model) => ({ id: `${connection.id}/${model.id}`, object: "model", created: 0, owned_by: connection.id })));
        const aliases = Object.entries(config.responsesAliases).filter(([, route]) => permitted(principal, route.connection, route.model) && routes.some((model) => model.id === `${route.connection}/${route.model}`)).map(([id, route]) => ({ id, object: "model", created: 0, owned_by: route.connection }));
        json(response, 200, path === "/v1/catalog" ? available : { object: "list", data: [...aliases, ...routes] });
        return;
      }
      if (isResponses) {
        const resolved = responsesRequest(await readJson(request), connections, principal, config.responsesAliases);
        const accounting = new RequestUsage(accessStore, requestId, principal, resolved.connectionId, resolved.model.id, "responses");
        const warnings = await accounting.admit(principal);
        await serveResponses(request, response, resolved, principal, requestId, controller, accounting, warnings);
        return;
      }
      if (!match) throw new HttpError(404, "not_found");
      const parsed = requestSchema.safeParse(await readJson(request));
      if (!parsed.success) throw new HttpError(400, "invalid_request");
      const body = parsed.data;
      const streams = body.operation === "stream" || body.operation === "streamSimple" || body.operation === "fetchDeferred";
      if (streams !== (match[2] === "messages")) throw new HttpError(400, "operation_not_allowed");
      const type = body.operation === "generateImages" ? "image" : body.operation === "classify" ? "classifier" : "chat";
      const { connection, model } = connectionModel(connections, principal, match[1], body.model, type);
      const options = requestOptions(body.options, principal, match[1], controller.signal);
      const accounting = new RequestUsage(accessStore, requestId, principal, match[1], model.id, body.operation);
      const warnings = await accounting.admit(principal, !["fetchDeferred", "cancelDeferred"].includes(body.operation));
      if (warnings.length) response.setHeader("x-dispatch-budget-warning", warnings.join(","));
      try {
        if (body.operation === "generateImages" || body.operation === "classify") {
          const result = body.operation === "generateImages"
            ? await connection.models.generateImages(model as ImageModel<string>, body.context as ImagesContext, options)
            : await connection.models.classify(model as ClassifierModel<string>, body.context as ClassifierContext, options);
          const { errorMessage: _errorMessage, ...safe } = result;
          if ("diagnostics" in safe) delete safe.diagnostics;
          await accounting.finish(_errorMessage ? "error" : "done", result.usage);
          json(response, 200, { ...safe, provider: match[1], ...(_errorMessage ? { errorMessage: `Provider request failed (request ${requestId})` } : {}) });
          return;
        }
        let stream;
        let deferredUsageKey: string | undefined;
        if (body.operation === "fetchDeferred" || body.operation === "cancelDeferred") {
          const parsedHandle = handleSchema.safeParse(body.handle);
          if (!parsedHandle.success) throw new HttpError(400, "invalid_deferred_handle");
          const handle = auth.unseal(parsedHandle.data as DeferredHandle, principal.id, match[1], model.id);
          deferredUsageKey = tokenHash(`${principal.id}:${match[1]}:${model.id}:${handle.id}`);
          if (body.operation === "cancelDeferred") {
            await connection.models.cancelDeferred(model as Model<string>, handle, options);
            await accounting.finish("cancelled"); json(response, 200, { cancelled: true }); return;
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
              const native = event.type === "done" ? event.message : event.error;
              const billingKey = deferredUsageKey ?? (native.deferred ? tokenHash(`${principal.id}:${match[1]}:${model.id}:${native.deferred.id}`) : undefined);
              await accounting.finish(event.type === "done" ? event.reason : "error", native.stopReason === "deferred" ? undefined : message.usage, native.stopReason === "deferred" ? undefined : billingKey);
            } else wire = compactEvent(event);
            if (!response.write(`data: ${JSON.stringify(wire)}\n\n`)) await once(response, "drain", { signal: controller.signal });
          }
          response.end();
        } finally { clearInterval(heartbeat); controller.abort(); }
      } finally { await accounting.finish(controller.signal.aborted ? "aborted" : "error"); }
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
    accessStore?.close();
  })();
  server.on("close", () => { void closeCredentials(); });
  return { server, config, connections, closeCredentials };
}
