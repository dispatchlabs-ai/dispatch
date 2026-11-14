import type { AuthContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { withPrivateProviderErrors } from "./private-provider-errors.js";

// The launcher gives providers no ambient environment. This context is handed only to the one
// provider the host names, so no other provider can authenticate from the environment.
const environment: AuthContext = { env: async name => process.env[name], fileExists: async () => false };

/** Load only the named provider from the pinned Pi package. */
export async function builtInProvider(name: string): Promise<Provider> {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Name one of Pi's built-in providers, such as openai.");
  const module: Record<string, unknown> = await import(`@earendil-works/pi-ai/providers/${name}`).catch(() => ({}));
  const factory = Object.entries(module).find(([key]) => key.toLowerCase() === `${name.replaceAll("-", "")}provider`)?.[1];
  if (typeof factory !== "function") throw new Error(`Pi has no built-in provider named ${name}.`);
  return factory() as Provider;
}

/** API-key-only host binding using the named Pi provider's environment variables. */
export async function environmentProvider(name: string): Promise<Provider> {
  const provider = withPrivateProviderErrors(await builtInProvider(name));
  const apiKey = provider.auth.apiKey;
  if (!apiKey) throw new Error(`Pi's ${name} provider does not authenticate with an API key.`);
  return { ...provider, auth: { apiKey: {
    name: apiKey.name,
    resolve: input => apiKey.resolve({ ...input, ctx: environment }),
    ...(apiKey.check ? { check: input => apiKey.check!({ ...input, ctx: environment }) } : {}),
  } } };
}

/** Explicit synthetic inference for trying the host without provider credentials. */
export async function demoProvider(): Promise<Provider> {
  const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
  const faux = fauxProvider({ tokensPerSecond: 12 });
  const reply: import("@earendil-works/pi-ai/providers/faux").FauxResponseFactory = context => {
    faux.appendResponses([reply]);
    const message = context.messages.filter(message => message.role === "user").at(-1);
    const text = typeof message?.content === "string" ? message.content
      : message?.content?.filter(part => part.type === "text").map(part => part.text).join("\n");
    return fauxAssistantMessage(`Demo reply: ${text ?? "Hello"}`);
  };
  faux.setResponses([reply]);
  return faux.provider;
}
