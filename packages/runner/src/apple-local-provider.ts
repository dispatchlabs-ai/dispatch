import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelProcessConfig } from "./model-process.js";

export const appleLocalProcess: ModelProcessConfig = {
  command: "fm", args: ["serve", "--host", "127.0.0.1", "--port", "{port}"],
  baseUrl: "http://127.0.0.1:{port}/v1", readyUrl: "http://127.0.0.1:{port}/health",
};

/** Native Pi provider; only Apple's on-device model is offered by this connection. */
export function appleLocalProvider(options: { contextWindow?: number } = {}) {
  // AFM 3 reports 8192 through SystemLanguageModel.contextSize; fm does not include it in /models.
  const contextWindow = options.contextWindow ?? 8192;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error("Apple contextWindow must be a positive integer.");
  return createProvider({
    id: "apple-local", name: "Apple local",
    auth: { apiKey: { name: "Local server", resolve: async () => ({ auth: { apiKey: "local" }, source: "local server" }) } },
    models: [], api: openAICompletionsApi(),
    fetchModels: async ({ baseUrl, signal }) => {
      if (!baseUrl) throw new Error("Configure an Apple local endpoint or managed fm serve.");
      const health = await fetch(new URL("../health", `${baseUrl.replace(/\/$/, "")}/`), { signal });
      if (!health.ok) throw new Error("Apple local health check failed.");
      const status = await health.json() as { models?: { name: string; available: boolean; reason?: string }[] };
      const local = Array.isArray(status.models) ? status.models.find(model => model?.name === "system") : undefined;
      if (!local?.available) throw new Error("Apple's on-device model is unavailable. Check fm models on this Mac and complete Apple's setup.");
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal });
      if (!response.ok) throw new Error("Apple local model discovery failed.");
      const catalog = await response.json() as { data?: { id: string }[] };
      if (!Array.isArray(catalog.data) || !catalog.data.some(model => model?.id === "system")) throw new Error("Apple local did not advertise its system model.");
      return [{
        id: "system", name: "Apple on-device", provider: "apple-local", api: "openai-completions", baseUrl,
        reasoning: false, input: ["text"], contextWindow, maxTokens: contextWindow,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
          supportsStrictMode: false, maxTokensField: "max_tokens" },
      } satisfies Model<"openai-completions">];
    },
  });
}
