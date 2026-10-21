import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createModels, defaultProviderAuthContext, type AnyModel, type AssistantMessage, type Context, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { GatewayAuth } from "./auth.js";
import { HttpError, permitted, type ConnectionConfig, type GatewayConfig, type Principal } from "./config.js";
import { SecretsCredentialStore } from "./credentials.js";
import { liveFireworksProvider } from "./fireworks-provider.js";

export type Connection = { config: ConnectionConfig; models: MutableModels; provider: Provider };
export type CatalogConnection = { id: string; name: string; provider: string; models: AnyModel[]; images: boolean; classify: boolean; deferred: boolean };
export type Catalog = { version: 1; connections: CatalogConnection[] };
const noAmbientAuth = { env: async () => undefined, fileExists: async () => false };

export async function createConnections(config: GatewayConfig, secrets: SecretsManagerClient, extraProviders: readonly Provider[] = [], assertOwner?: () => Promise<void>, pendingCredentials?: Set<Promise<unknown>>): Promise<Map<string, Connection>> {
  const result = new Map<string, Connection>();
  for (const item of config.connections) {
    // Providers carry dynamic catalog state, so construct fresh instances for each connection.
    const provider = item.provider === "fireworks" ? liveFireworksProvider() : [...builtinProviders(), ...extraProviders].find((candidate) => candidate.id === item.provider);
    if (!provider) throw new Error(`Unknown Pi provider: ${item.provider}`);
    const models = createModels({ credentials: new SecretsCredentialStore(secrets, item.secretId, provider.id, assertOwner, pendingCredentials), authContext: item.allowAmbientAuth ? defaultProviderAuthContext() : noAmbientAuth });
    models.setProvider(provider);
    const refreshed = await models.refresh();
    if (refreshed.errors.size) throw new Error(`Cannot refresh provider catalog: ${item.id}`);
    result.set(item.id, { config: item, models, provider });
  }
  return result;
}

export function connectionModel(connections: Map<string, Connection>, principal: Principal, connectionId: string, modelId: string, type: "chat" | "image" | "classifier" = "chat") {
  const connection = connections.get(connectionId);
  if (!connection || !permitted(principal, connectionId, modelId)) throw new HttpError(403, "model_not_allowed");
  const model = connection.models.getModelOfType(type, connection.config.provider, modelId);
  if (!model) throw new HttpError(404, "model_not_found");
  return { connection, model };
}

export async function catalog(connections: Map<string, Connection>, principal: Principal, audience: string): Promise<Catalog> {
  const entries: CatalogConnection[] = [];
  for (const connection of connections.values()) {
    if (!(principal.grants[connection.config.id] ?? principal.grants["*"])?.length) continue;
    const refreshed = await connection.models.refresh();
    if (refreshed.errors.size) console.warn(JSON.stringify({ event: "catalog_refresh_failed", connection: connection.config.id }));
    const models = (await connection.models.getAllAvailable()).filter((model) => permitted(principal, connection.config.id, model.id)).map((model) => {
      // Upstream endpoints and headers are private. Catalog metadata remains native Pi metadata.
      const { headers: _headers, baseUrl: _baseUrl, ...publicModel } = model;
      return { ...publicModel, provider: connection.config.id, baseUrl: `${audience}/v1/connections/${connection.config.id}` } as AnyModel;
    });
    entries.push({ id: connection.config.id, provider: connection.config.provider, name: connection.provider.name, models, images: Boolean(connection.provider.generateImages), classify: Boolean(connection.provider.classify), deferred: Boolean(connection.provider.fetchDeferred) });
  }
  return { version: 1, connections: entries };
}

// Native provider options also include endpoints, deployment names and credentials.
// Only reviewed inference controls cross the workload boundary; new Pi controls need review here.
const inferenceOptions = new Set([
  "temperature", "samplingParams", "maxTokens", "transport", "cacheRetention", "sessionId", "websocketConnectTimeoutMs",
  "metadata", "timeoutMs", "maxRetries", "maxRetryDelayMs", "reasoning", "deferred", "thinkingBudgets", "toolChoice",
  "reasoningEffort", "reasoningSummary", "serviceTier", "textVerbosity", "thinkingEnabled", "thinkingBudgetTokens",
  "effort", "thinkingDisplay", "interleavedThinking", "thinking", "promptMode", "requestMetadata", "wait", "vllmPriority",
]);
const samplingOptions = new Set([
  "top_p", "top_k", "min_p", "typical_p", "tfs_z", "temperature", "max_tokens", "max_completion_tokens",
  "presence_penalty", "frequency_penalty", "repetition_penalty", "repeat_penalty", "repeat_last_n", "seed", "stop",
  "logit_bias", "logprobs", "top_logprobs", "n", "best_of", "reasoning_effort", "reasoning", "structured_outputs",
  "response_format", "include_reasoning",
]);

export function requestOptions(input: Record<string, unknown>, principal: Principal, connection: string, signal: AbortSignal): Record<string, unknown> & { signal: AbortSignal } {
  if (Object.keys(input).some((key) => !inferenceOptions.has(key))) throw new HttpError(400, "option_not_allowed");
  if (input.samplingParams !== undefined) {
    if (typeof input.samplingParams !== "object" || !input.samplingParams || Array.isArray(input.samplingParams) || Object.keys(input.samplingParams).some((key) => !samplingOptions.has(key))) throw new HttpError(400, "sampling_option_not_allowed");
  }
  if (input.sessionId !== undefined && typeof input.sessionId !== "string") throw new HttpError(400, "invalid_session_id");
  return { ...input, sessionId: input.sessionId === undefined ? undefined : `${principal.id}:${connection}:${input.sessionId}`, signal };
}

export function nativeContext(context: Context, connection: Connection): Context {
  return { ...context, messages: context.messages.map((message) => message.role === "assistant" && message.provider === connection.config.id ? { ...message, provider: connection.config.provider } : message) };
}

export function publicMessage(message: AssistantMessage, principal: Principal, connection: string, auth: GatewayAuth, requestId: string): AssistantMessage {
  const { diagnostics: _diagnostics, errorMessage: _errorMessage, deferred, ...rest } = message;
  return {
    ...rest, provider: connection,
    ...(deferred ? { deferred: auth.seal(deferred, principal.id, connection) } : {}),
    ...(message.stopReason === "error" || message.stopReason === "aborted" ? { errorMessage: message.stopReason === "aborted" ? "Request aborted" : `Provider request failed (request ${requestId})` } : {}),
  };
}
