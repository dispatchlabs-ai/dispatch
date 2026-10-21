import type { Model, Provider } from "@earendil-works/pi-ai";

export const MUSE_PROVIDER = "muse-code";
/** Selection metadata only: native Muse owns model requests and account authentication. */
export function museProvider(): Provider<"openai-completions"> {
  const models = [
    ["muse-wonder-full-1.0", "Muse Wonder Full"],
    ["muse-wonder-1.0", "Muse Wonder"],
    ["muse-spark-1.3", "Muse Spark"],
  ] as const;
  const catalog = models.map(([id, name]): Model<"openai-completions"> => ({
    id, name, provider: MUSE_PROVIDER, api: "openai-completions", baseUrl: "",
    reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  }));
  const nativeOnly = () => { throw new Error("Muse Code models require the Muse Code execution backend, not Pi model inference."); };
  return { id: MUSE_PROVIDER, name: "Muse Code", auth: { apiKey: { name: "Native Muse login", resolve: async () => undefined } },
    getModels: () => catalog, stream: nativeOnly, streamSimple: nativeOnly };
}
