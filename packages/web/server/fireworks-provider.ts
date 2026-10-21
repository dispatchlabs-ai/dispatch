import { isModelType, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { z } from "zod";

const modelList = z.object({ data: z.array(z.object({
  id: z.string().min(1).max(200), kind: z.string().optional(),
  supports_chat: z.boolean().optional(), supports_tools: z.boolean().optional(),
  supports_image_input: z.boolean().optional(), context_length: z.number().int().positive().optional(),
})) });

// Request metadata, not availability: the provider must list this model before it is offered.
// https://dev.meta.ai/docs/muse-spark-open/deploy
const spark: Model<"openai-completions"> = {
  id: "accounts/fireworks/models/muse-spark-open", name: "Muse Spark Open", provider: "fireworks",
  api: "openai-completions", baseUrl: "https://api.fireworks.ai/inference/v1",
  reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 32768,
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
  cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
};

/** Pi owns requests, credentials and cache persistence; Fireworks owns live availability. */
export function liveFireworksProvider(): Provider {
  const base = fireworksProvider();
  const metadata = new Map([...base.getModels(), spark].map(model => [model.id, model]));
  let live: readonly Model<Api>[] | undefined;
  const all = () => [...new Map([...base.getModels(), ...(live ?? [])].map(model => [model.id, model])).values()];
  return {
    ...base,
    getModels: all,
    getAllModels: all,
    filterModels: models => live ? models.filter(model => live!.some(item => item.id === model.id)) : models,
    async refreshModels(context) {
      if (context.stored) {
        const restored = context.stored.models.filter(model => model.provider === base.id && isModelType(model, "chat")) as Model<Api>[];
        if (!await context.publish({ update: () => { live = restored; } })) return;
      }
      if (!context.allowNetwork || context.credential?.type !== "api_key") return;
      const response = await fetch("https://api.fireworks.ai/inference/v1/models", {
        headers: { Authorization: `Bearer ${context.credential.key}` }, signal: context.signal,
      });
      if (!response.ok) throw new Error(`Fireworks model listing failed (${response.status}).`);
      const { data } = modelList.parse(await response.json());
      const models = data.filter(item => item.kind !== "EMBEDDING_MODEL" && (item.supports_chat || item.supports_tools)).map((item): Model<Api> => {
        const known = metadata.get(item.id);
        return {
          ...(known ?? {
            id: item.id, name: item.id.split("/").at(-1)!, provider: base.id,
            api: "openai-completions", baseUrl: "https://api.fireworks.ai/inference/v1",
            reasoning: false, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
          }),
          input: item.supports_image_input === undefined ? known?.input ?? ["text"] : item.supports_image_input ? ["text", "image"] : ["text"],
          contextWindow: item.context_length ?? known?.contextWindow ?? 128000,
        };
      });
      await context.publish({ persist: { models, checkedAt: Date.now() }, update: () => { live = models; } });
    },
  };
}
