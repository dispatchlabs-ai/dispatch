import { createProvider, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/** Independent API credentials; Pi keeps ownership of OpenAI requests and model metadata. */
export function openaiApiProvider(): Provider<"openai-responses"> {
  const provider = openaiProvider();
  return createProvider({
    id: "openai-api",
    name: "OpenAI API",
    baseUrl: provider.baseUrl,
    auth: { apiKey: provider.auth.apiKey! },
    models: provider.getModels().map(model => ({ ...model, provider: "openai-api" })),
    api: { stream: provider.stream, streamSimple: provider.streamSimple },
  });
}
