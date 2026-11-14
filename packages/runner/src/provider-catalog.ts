import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { appleLocalProvider, appleLocalProcess } from "./apple-local-provider.js";
import type { ModelProcessConfig } from "./model-process.js";
import type { Provider } from "@earendil-works/pi-ai/models";

/** Pi owns provider names, login methods, subscription labels and model discovery. */
export function providerCatalog(): { provider: Provider; process?: ModelProcessConfig }[] {
  return [...builtinProviders().map(provider => ({ provider })), { provider: appleLocalProvider(), process: appleLocalProcess }];
}

export function registeredProvider(id: string): Provider {
  const found = providerCatalog().find(entry => entry.provider.id === id);
  if (!found) throw new Error(`Unknown provider ${id}. Run dispatch providers list, or configure a native Pi provider module.`);
  return found.provider;
}
