import { createModels, normalizeContext, type AnyModel, type AssistantMessage, type DeferredHandle, type Model, type Provider, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { stream as piMessagesStream } from "@earendil-works/pi-ai/api/pi-messages";
import { gatewayOrigin } from "./config.js";
import type { Catalog, CatalogConnection } from "./engine.js";

export type GatewayAuthorization = (options?: { forceRefresh?: boolean; signal?: AbortSignal }) => Promise<string>;
export type GatewayClientOptions = { url: string; authorize: GatewayAuthorization };
const localOptions = new Set(["apiKey", "headers", "env", "signal", "fetch", "onPayload", "onResponse", "onProviderStreamEvent", "telemetryContext", "transformHeaders"]);

function inferenceOptions(options: object | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(options ?? {}).filter(([key, value]) => !localOptions.has(key) && value !== undefined));
}

function failedMessage(model: Model<string>, error: unknown, signal?: AbortSignal): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(),
    stopReason: signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : "Gateway request failed",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

/** Returns native Pi Models. Provider IDs are gateway connection IDs, so API and OAuth connections can coexist. */
export async function createGatewayModels(options: GatewayClientOptions) {
  const origin = gatewayOrigin(options.url);
  const authorizedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== origin || !url.pathname.startsWith("/v1/")) throw new Error("Gateway transport cannot access another origin");
    const signal = init?.signal ?? undefined;
    const send = async (forceRefresh: boolean) => {
      const token = await options.authorize({ forceRefresh, signal: signal ?? undefined });
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers, redirect: "error" });
    };
    const response = await send(false);
    // A 401 is returned before admission. Never replay an admitted inference request.
    if (response.status !== 401) return response;
    await response.body?.cancel();
    return send(true);
  };
  const response = await authorizedFetch(`${origin}/v1/catalog`);
  if (!response.ok) throw new Error(`Cannot load gateway models (${response.status})`);
  const catalog = await response.json() as Catalog;
  if (catalog.version !== 1 || !Array.isArray(catalog.connections)) throw new Error("Unsupported gateway catalog");
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });

  function remoteStream(connection: CatalogConnection, model: Model<string>, context: TranscriptContext | undefined, operation: string, requestOptions?: StreamOptions, handle?: DeferredHandle) {
    const result = new AssistantMessageEventStream();
    void (async () => {
      try {
        let terminal: AssistantMessage | undefined;
        const transportModel: Model<"pi-messages"> = { ...model, api: "pi-messages", baseUrl: `${origin}/v1/connections/${connection.id}`, headers: undefined };
        const stream = piMessagesStream(transportModel, context ?? normalizeContext({ messages: [] }), {
          apiKey: "gateway", signal: requestOptions?.signal, fetch: authorizedFetch,
          onPayload: async () => {
            const payload = { model: model.id, context, operation, handle, options: inferenceOptions(requestOptions) };
            return await requestOptions?.onPayload?.(payload, model) ?? payload;
          },
          onResponse: (value) => requestOptions?.onResponse?.(value, model),
          onProviderStreamEvent: async (value) => {
            const event = value as { type?: string; message?: AssistantMessage };
            if ((event.type === "done" || event.type === "error") && event.message) terminal = event.message;
            await requestOptions?.onProviderStreamEvent?.(value, model);
          },
        });
        for await (const event of stream) {
          const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
          message.api = model.api;
          message.provider = connection.id;
          if ((event.type === "done" || event.type === "error") && terminal) Object.assign(message, terminal);
          result.push(event);
        }
      } catch (error) {
        const message = failedMessage(model, error, requestOptions?.signal);
        result.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
      }
    })();
    return result;
  }

  async function operation(connection: CatalogConnection, model: AnyModel, operation: string, context: unknown, requestOptions?: { signal?: AbortSignal }, handle?: DeferredHandle) {
    const response = await authorizedFetch(`${origin}/v1/connections/${connection.id}/operations`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: requestOptions?.signal,
      body: JSON.stringify({ model: model.id, operation, context, handle, options: inferenceOptions(requestOptions) }),
    });
    if (!response.ok) throw new Error(`Gateway ${operation} failed (${response.status})`);
    return response.json();
  }

  for (const connection of catalog.connections) {
    const provider: Provider = {
      id: connection.id, name: connection.name,
      auth: { apiKey: { name: "Dispatch gateway", resolve: async () => ({ auth: { apiKey: "gateway" }, source: "Dispatch workload identity" }) } },
      getModels: () => connection.models.filter((model): model is Model<string> => model.type === undefined || model.type === "chat"),
      getAllModels: () => connection.models,
      stream: (model, context, requestOptions) => remoteStream(connection, model, context, "stream", requestOptions),
      streamSimple: (model, context, requestOptions) => remoteStream(connection, model, context, "streamSimple", requestOptions),
      ...(connection.deferred ? {
        fetchDeferred: (model, handle, requestOptions) => remoteStream(connection, model, undefined, "fetchDeferred", requestOptions, handle),
        cancelDeferred: async (model, handle, requestOptions) => { await operation(connection, model, "cancelDeferred", undefined, requestOptions, handle); },
      } satisfies Partial<Provider> : {}),
      ...(connection.images ? { generateImages: (model, context, requestOptions) => operation(connection, model, "generateImages", context, requestOptions) } satisfies Partial<Provider> : {}),
      ...(connection.classify ? { classify: (model, context, requestOptions) => operation(connection, model, "classify", context, requestOptions) } satisfies Partial<Provider> : {}),
    };
    models.setProvider(provider);
  }
  return models;
}
