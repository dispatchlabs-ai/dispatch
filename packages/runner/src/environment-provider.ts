import type { AuthContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { withPrivateProviderErrors } from "./private-provider-errors.js";

// The launcher gives providers no ambient environment. This context is handed only to the one
// provider the host names, so no other provider can authenticate from the environment.
const environment: AuthContext = { env: async name => process.env[name], fileExists: async () => false };

/**
 * A host model provider for an installation that holds one provider API key: Pi's built-in
 * provider NAME (such as `openai` or `anthropic`), authenticated from the environment variable
 * that provider defines (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). Bind it under `modelProviders`.
 */
export async function environmentProvider(name: string): Promise<Provider> {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Name one of Pi's built-in providers, such as openai.");
  const module: Record<string, unknown> = await import(`@earendil-works/pi-ai/providers/${name}`).catch(() => ({}));
  const factory = Object.entries(module).find(([key]) => key.toLowerCase() === `${name.replaceAll("-", "")}provider`)?.[1];
  if (typeof factory !== "function") throw new Error(`Pi has no built-in provider named ${name}.`);
  const provider = withPrivateProviderErrors(factory() as Provider);
  const apiKey = provider.auth.apiKey;
  if (!apiKey) throw new Error(`Pi's ${name} provider does not authenticate with an API key.`);
  return { ...provider, auth: { apiKey: {
    name: apiKey.name,
    resolve: input => apiKey.resolve({ ...input, ctx: environment }),
    ...(apiKey.check ? { check: input => apiKey.check!({ ...input, ctx: environment }) } : {}),
  } } };
}
