import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { getSupportedThinkingLevels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { refreshGatewayModels, type GatewayAliases } from "./gateway.js";

export type HostModelsConfig = {
  gateway?: { origin: string; credentialFile: string; aliases?: GatewayAliases };
  /** Trusted host modules returning native Pi providers; applied after gateway bindings. */
  modelProviders?: { module: string; export: string; id?: string; args?: unknown[]; closeSessionExport?: string }[];
};

export async function connectHostModels(config: HostModelsConfig, models: MutableModels) {
  let choices: import("./gateway.js").ModelChoice[] = [];
  if (config.gateway) {
    if (!config.gateway.origin || !isAbsolute(config.gateway.credentialFile)) throw new Error("Supply gateway.origin and an absolute gateway.credentialFile.");
    const { key } = JSON.parse(await readFile(config.gateway.credentialFile, "utf8"));
    choices = await refreshGatewayModels(config.gateway.origin, models, key, config.gateway.aliases);
  } else if (!config.modelProviders?.length) throw new Error("Supply a gateway or trusted modelProviders.");
  const cleanups: (() => Promise<void>)[] = [];
  for (const binding of config.modelProviders ?? []) {
    if (!isAbsolute(binding.module) || !binding.export || (binding.id !== undefined && !binding.id.trim()) || !Array.isArray(binding.args ?? [])) {
      throw new Error("Supply an absolute modelProviders.module, its factory export, and optional id and args.");
    }
    const module = await import(pathToFileURL(binding.module).href);
    const factory = module[binding.export];
    if (typeof factory !== "function") throw new Error("The configured model provider factory is unavailable.");
    const provider: Provider = await factory(...(binding.args ?? []));
    const id = binding.id ?? provider.id;
    const closeSession = binding.closeSessionExport ? module[binding.closeSessionExport] : undefined;
    if (binding.closeSessionExport && typeof closeSession !== "function") throw new Error("The configured model provider cleanup is unavailable.");
    const sessions = new Set<string>();
    const remember = (options?: { sessionId?: string }) => { if (options?.sessionId) sessions.add(options.sessionId); };
    if (closeSession) cleanups.push(async () => {
      const results = await Promise.allSettled([...sessions].map(id => closeSession(id)));
      sessions.clear();
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Could not close model provider sessions.");
    });
    // Keep authored provider identities stable while the host selects their transport.
    models.setProvider({
      ...provider, id,
      getModels: () => provider.getModels().map(model => ({ ...model, provider: id })),
      ...(provider.getAllModels ? { getAllModels: () => provider.getAllModels!().map(model => ({ ...model, provider: id })) } : {}),
      stream: (model, context, options) => { remember(options); return provider.stream(model, context, options); },
      streamSimple: (model, context, options) => { remember(options); return provider.streamSimple(model, context, options); },
    });
    await models.refresh({ providers: [id] });
    choices = choices.filter(choice => choice.provider !== id);
    choices.push(...models.getModels(id).map(model => ({
      provider: id, providerName: provider.name, id: model.id, name: model.name,
      levels: getSupportedThinkingLevels(model), images: model.input.includes("image"),
    })));
  }
  return { choices, close: async () => {
    const results = await Promise.allSettled(cleanups.map(cleanup => cleanup()));
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "Could not close host model providers.");
  } };
}
