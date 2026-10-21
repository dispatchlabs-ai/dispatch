import {
  createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError,
  type Api, type AssistantMessage, type AssistantMessageEventStream, type Model,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";

function privateMessage(message: AssistantMessage): AssistantMessage {
  // Upstream partial messages are mutable. Never let a later error mutation
  // put raw provider text into an event that has already crossed this boundary.
  const copy = structuredClone(message);
  if (message.errorMessage === undefined && !["error", "aborted"].includes(message.stopReason)) return copy;
  let reason: string;
  if (message.stopReason === "aborted") reason = "Model request cancelled.";
  else if (isContextOverflow(message)) reason = "Context length exceeded.";
  else if (isRetryableAssistantError(message)) reason = "Service unavailable; retry the model request.";
  else if (/(?:^|\()(401|403)(?:\)|\s)/.test(message.errorMessage ?? "")) reason = "Provider authentication or access was rejected. Check the configured credential and account access.";
  else reason = "Model request failed. Check provider credentials, account limits and request configuration.";
  copy.errorMessage = `${reason} Raw provider error details were withheld.`;
  delete copy.diagnostics;
  delete copy.rawStopReason;
  return copy;
}

function privateStream(model: Model<Api>, source: () => AssistantMessageEventStream, signal?: AbortSignal): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      const input = source();
      for await (const event of input) {
        if (event.type === "error") output.push({ ...event, error: privateMessage(event.error) });
        else if (event.type === "done") output.push({ ...event, message: privateMessage(event.message) });
        else output.push({ ...event, partial: privateMessage(event.partial) });
      }
      output.end(privateMessage(await input.result()));
    } catch (error) {
      const reason = signal?.aborted ? "aborted" : "error";
      const message: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        stopReason: reason, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        errorMessage: error instanceof Error ? error.message : "Model request failed",
      };
      output.push({ type: "error", reason, error: privateMessage(message) });
      output.end();
    }
  })();
  return output;
}

/** Withhold raw chat-provider errors before they can enter durable history.
 * This does not wrap image/classifier operations or application telemetry hooks.
 */
export function withPrivateProviderErrors(provider: Provider): Provider {
  return {
    id: provider.id, name: provider.name, auth: provider.auth,
    baseUrl: provider.baseUrl, headers: provider.headers,
    getModels: provider.getModels.bind(provider),
    ...(provider.getAllModels ? { getAllModels: provider.getAllModels.bind(provider) } : {}),
    ...(provider.refreshModels ? { refreshModels: provider.refreshModels.bind(provider) } : {}),
    ...(provider.filterModels ? { filterModels: provider.filterModels.bind(provider) } : {}),
    ...(provider.filterAllModels ? { filterAllModels: provider.filterAllModels.bind(provider) } : {}),
    ...(provider.generateImages ? { generateImages: provider.generateImages.bind(provider) } : {}),
    ...(provider.classify ? { classify: provider.classify.bind(provider) } : {}),
    ...(provider.cancelDeferred ? { cancelDeferred: provider.cancelDeferred.bind(provider) } : {}),
    stream: (model, context, options) => privateStream(model, () => provider.stream(model, context, options), options?.signal),
    streamSimple: (model, context, options) => privateStream(model, () => provider.streamSimple(model, context, options), options?.signal),
    ...(provider.fetchDeferred ? { fetchDeferred: (model, handle, options) => privateStream(model, () => provider.fetchDeferred!(model, handle, options), options?.signal) } : {}),
  };
}
