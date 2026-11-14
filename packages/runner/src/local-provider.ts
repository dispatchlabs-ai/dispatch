import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { builtInProvider } from "./environment-provider.js";
import { LocalCredentials } from "./local-credentials.js";
import { withPrivateProviderErrors } from "./private-provider-errors.js";

export async function localModels(name: string, credentials = new LocalCredentials()) {
  const provider = await builtInProvider(name);
  const models = createModels({ credentials,
    authContext: { env: async key => process.env[key], fileExists: async () => false },
  });
  models.setProvider(provider);
  return { models, provider, credentials };
}

/** Bind one provider's saved sign-in (or its API-key environment) to the shared host. */
export async function localProvider(name: string): Promise<Provider> {
  return withLocalCredentials(await builtInProvider(name));
}

/** Apply the native credential store to a provider, including application-supplied providers. */
export async function withLocalCredentials(provider: Provider, credentials = new LocalCredentials()): Promise<Provider> {
  const name = provider.id;
  const models = createModels({ credentials });
  models.setProvider(provider);
  if (!await models.checkAuth(name)) throw new Error(`Not signed in to ${name}. Run npx dispatch login ${name}, or set this provider's API key in the host environment.`);
  const saved = await credentials.read(name);
  return withPrivateProviderErrors({
    ...provider,
    // Resolve through Pi's Models so refresh stays serialized by the credential store.
    // The outer host Models receives only request auth for this selected provider.
    auth: { apiKey: {
      name: "Dispatch sign-in",
      check: ({ signal }) => models.checkAuth(name, { signal }),
      resolve: async ({ signal }) => {
        try { return await models.getAuth(name, { signal }); }
        catch { throw new Error(`Cannot authenticate ${name}. Run npx dispatch login ${name} to reconnect. Raw credential errors were withheld.`); }
      },
    } },
    ...(provider.filterModels ? { filterModels: list => provider.filterModels!(list, saved) } : {}),
    ...(provider.filterAllModels ? { filterAllModels: list => provider.filterAllModels!(list, saved) } : {}),
  });
}
