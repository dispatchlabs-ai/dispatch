import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import type { AuthCheck, AuthResult } from "@earendil-works/pi-ai";

/** The backend remains the sole OAuth-refresh owner. Workers resolve request
 * credentials on demand and never receive refresh tokens or auth.json copies.
 * Revocation prevents subsequent resolutions; already-issued remote requests
 * and short-lived provider access tokens cannot be recalled by this boundary.
 */
export function workerModels(providers: readonly Provider[], resolve: (provider: string, signal: AbortSignal) => Promise<AuthResult | undefined>,
  check?: (provider: string, signal: AbortSignal) => Promise<AuthCheck | undefined>): Models {
  const models = createModels();
  for (const provider of providers) {
    models.setProvider({ ...provider, auth: { apiKey: {
      name: "Dispatch scoped credential broker",
      ...(check ? { check: ({ signal }: { signal: AbortSignal }) => check(provider.id, signal) } : {}),
      resolve: ({ signal }) => resolve(provider.id, signal),
    } } });
  }
  return models;
}
