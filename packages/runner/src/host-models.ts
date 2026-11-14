import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels, getSupportedThinkingLevels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { refreshGatewayModels, type GatewayAliases, type ModelChoice } from "./gateway.js";
import { registeredProvider } from "./provider-catalog.js";
import { withLocalCredentials } from "./local-provider.js";
import { modelProcess, type ModelProcessConfig } from "./model-process.js";

export type ModelProviderBinding = {
  /** A registered native Pi provider, or a trusted module/factory below. */
  provider?: string;
  module?: string;
  export?: string;
  id?: string;
  args?: unknown[];
  closeSessionExport?: string;
  /** Opt custom factories into Dispatch's native CredentialStore. Registered providers always use it. */
  credentials?: "local";
  baseUrl?: string;
  process?: ModelProcessConfig;
};
export type HostModelsConfig = {
  gateway?: { origin: string; credentialFile: string; aliases?: GatewayAliases };
  modelProviders?: ModelProviderBinding[];
};

/** Load trusted host code; its factory returns a native Pi Provider. */
export async function loadModelProvider(binding: ModelProviderBinding) {
  if (!binding || typeof binding !== "object") throw new Error("Each model provider binding must be an object.");
  if (binding.credentials !== undefined && binding.credentials !== "local") throw new Error("Use credentials: local, or let the provider factory own credentials.");
  if (binding.provider) {
    if (binding.module || binding.export || binding.args) throw new Error("Choose a provider ID or a module factory.");
    return { provider: registeredProvider(binding.provider), closeSession: undefined as ((id: string) => Promise<void>) | undefined };
  }
  const own = typeof binding.module === "string" && /^@dispatch\/runner\/[a-z][a-z0-9-]*$/.test(binding.module);
  if (!binding.module || (!own && !isAbsolute(binding.module)) || !binding.export || !Array.isArray(binding.args ?? []))
    throw new Error("Supply a provider ID, or an absolute modelProviders.module and factory export.");
  const module = await import(own ? binding.module : pathToFileURL(binding.module).href);
  const factory = module[binding.export];
  if (typeof factory !== "function") throw new Error("The configured model provider factory is unavailable.");
  const provider: Provider = await factory(...(binding.args ?? []));
  const closeSession: ((id: string) => Promise<void>) | undefined = binding.closeSessionExport ? module[binding.closeSessionExport] : undefined;
  if (binding.closeSessionExport && typeof closeSession !== "function") throw new Error("The configured model provider cleanup is unavailable.");
  return { provider, closeSession };
}

async function openBinding(binding: ModelProviderBinding, cwd: string, signal?: AbortSignal) {
  if (binding.baseUrl && binding.process) throw new Error("Choose an existing baseUrl or a managed process.");
  const runtime = binding.process ? await modelProcess(binding.process, cwd) : undefined;
  try {
    await runtime?.ensure(signal);
    const loaded = await loadModelProvider(binding);
    const id = binding.id ?? loaded.provider.id;
    if (typeof id !== "string" || !id.trim()) throw new Error("A model provider ID must be nonempty.");
    const baseUrl = runtime?.baseUrl ?? binding.baseUrl;
    if (baseUrl) {
      const url = new URL(baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error("Use a model endpoint without embedded credentials, query or fragment.");
    }
    const native = loaded.provider;
    let provider: Provider = {
      ...native, id, ...(baseUrl ? { baseUrl } : {}),
      getModels: () => native.getModels().map(model => ({ ...model, provider: id, ...(baseUrl ? { baseUrl } : {}) })),
      ...(native.getAllModels ? { getAllModels: () => native.getAllModels!().map(model => ({ ...model, provider: id, ...(baseUrl ? { baseUrl } : {}) })) } : {}),
    };
    if (binding.provider || binding.credentials === "local") provider = await withLocalCredentials(provider);
    const requestModels = createModels();
    requestModels.setProvider(provider);
    const connected = provider;
    const sessions = new Set<string>();
    const remember = (options?: { sessionId?: string }) => { if (options?.sessionId) sessions.add(options.sessionId); };
    provider = {
      ...connected,
      // A request checks its process first; Pi's existing retry owns any request replay after a crash.
      ...(runtime ? { auth: { apiKey: {
        name: "Managed provider",
        check: input => requestModels.checkAuth(id, { signal: input.signal }),
        resolve: async input => { await runtime.ensure(input.signal); return requestModels.getAuth(id, { signal: input.signal }); },
      } } } : {}),
      stream: (model, context, options) => { remember(options); return connected.stream(model, context, options); },
      streamSimple: (model, context, options) => { remember(options); return connected.streamSimple(model, context, options); },
    };
    return {
      provider,
      close: async () => {
        try {
          const results = await Promise.allSettled([...sessions].map(id => loaded.closeSession?.(id)));
          const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
          if (errors.length) throw new AggregateError(errors, "Could not close model provider sessions.");
        } finally { sessions.clear(); await runtime?.close(); }
      },
    };
  } catch (error) { await runtime?.close(); throw error; }
}

/** One set of provider/process resources shared by every Models consumer of this host. */
export function hostModels(config: HostModelsConfig, cwd = process.cwd()) {
  const opened: Awaited<ReturnType<typeof openBinding>>[] = [];
  const shutdown = new AbortController();
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const next = chain.catch(() => {}).then(action); chain = next; return next;
  };
  const choices = (models: MutableModels): ModelChoice[] => models.getProviders().flatMap(provider => provider.getModels().map(model => ({
    provider: provider.id, providerName: provider.name, id: model.id, name: model.name,
    levels: getSupportedThinkingLevels(model), images: model.input.includes("image"),
  })));
  return {
    connect: (models: MutableModels, signal?: AbortSignal) => serialize(async () => {
      if (closed) throw new Error("Host model connections are closed.");
      signal = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
      if (!opened.length) {
        try {
          for (const binding of config.modelProviders ?? []) {
            const entry = await openBinding(binding, cwd, signal);
            opened.push(entry);
            if (opened.slice(0, -1).some(other => other.provider.id === entry.provider.id)) throw new Error(`Duplicate provider connection: ${entry.provider.id}`);
          }
        }
        catch (error) { await Promise.allSettled(opened.splice(0).map(entry => entry.close())); throw error; }
      }
      if (config.gateway) {
        if (!config.gateway.origin || !isAbsolute(config.gateway.credentialFile)) throw new Error("Supply gateway.origin and an absolute gateway.credentialFile.");
        const { key } = JSON.parse(await readFile(config.gateway.credentialFile, "utf8"));
        await refreshGatewayModels(config.gateway.origin, models, key, config.gateway.aliases);
      } else if (!opened.length) throw new Error("Supply a gateway or modelProviders.");
      for (const entry of opened) models.setProvider(entry.provider);
      const result = await models.refresh({ providers: opened.map(entry => entry.provider.id), signal });
      signal?.throwIfAborted();
      if (result.errors.size) throw new Error(`Model discovery failed for ${[...result.errors.keys()].join(", ")}. Check provider access and endpoint availability.`);
      return choices(models);
    }),
    close: async () => {
      closed = true; shutdown.abort(); await chain.catch(() => {});
      const results = await Promise.allSettled(opened.splice(0).map(entry => entry.close()));
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Could not close host model providers.");
    },
  };
}

/** Standalone hosts own the returned connection; service hosts share one hostModels owner. */
export async function connectHostModels(config: HostModelsConfig, models: MutableModels) {
  const owner = hostModels(config);
  try { return { choices: await owner.connect(models), close: () => owner.close() }; }
  catch (error) { await owner.close(); throw error; }
}

export { appleLocalProvider } from "./apple-local-provider.js";
export { providerCatalog } from "./provider-catalog.js";
export type { ModelProcessConfig } from "./model-process.js";
