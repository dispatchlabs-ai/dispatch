import { clampThinkingLevel, type Model, type Provider } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { resolveGoogleThinkingLevel, toGoogleThinkingLevel } from "@earendil-works/pi-ai/api/google-shared";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";

/** Catalog additions until Pi's pinned catalog includes these models. */
export function googleApiProvider(): Provider<"google-generative-ai"> {
  const provider = googleProvider();
  const argon: Model<"google-generative-ai"> = {
    ...provider.getModels().find(model => model.id === "gemini-3.8-flash")!,
    id: "gemini-4-argon", name: "Gemini 4 Argon",
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
  };
  return {
    ...provider,
    getModels: () => [...provider.getModels().filter(model => model.id !== argon.id), argon],
    getAllModels: () => [...(provider.getAllModels?.() ?? provider.getModels()).filter(model => model.id !== argon.id), argon],
    streamSimple(model, context, options) {
      if (model.id !== argon.id) return provider.streamSimple(model, context, options);
      // Pi 1.1.0 recognizes Gemini 3 IDs for thinking levels, but sends a budget
      // for Argon. Use its native stream with the supported level wire format.
      const level = clampThinkingLevel(model, options?.reasoning ?? "medium");
      return provider.stream(model, context, {
        ...buildBaseOptions(model, context, options),
        toolChoice: options?.toolChoice,
        thinking: { enabled: true, level: toGoogleThinkingLevel(resolveGoogleThinkingLevel(model, level === "off" ? "low" : level)) },
      });
    },
  };
}

export function metaApiProvider(): Provider<"openai-responses"> {
  const provider = metaProvider();
  const wonder: Model<"openai-responses"> = {
    ...provider.getModels().find(model => model.id === "muse-spark-1.3")!,
    id: "muse-wonder-1.0", name: "Muse Wonder",
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
  };
  return {
    ...provider,
    getModels: () => [...provider.getModels().filter(model => model.id !== wonder.id), wonder],
    getAllModels: () => [...(provider.getAllModels?.() ?? provider.getModels()).filter(model => model.id !== wonder.id), wonder],
  };
}
