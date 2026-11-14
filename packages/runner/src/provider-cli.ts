import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { parseDocument } from "yaml";
import { createModels, getSupportedThinkingLevels, type Provider } from "@earendil-works/pi-ai/models";
import type { AuthInteraction, AuthType, Model, Api } from "@earendil-works/pi-ai";
import { catalog } from "./definition.js";
import { hostModels, loadModelProvider, type HostModelsConfig, type ModelProviderBinding } from "./host-models.js";
import { readHostConfig } from "./host-config.js";
import { LocalCredentials } from "./local-credentials.js";
import { terminalInteraction } from "./login-cli.js";
import { providerCatalog } from "./provider-catalog.js";
import { terminalText } from "./terminal-output.js";

type Options = {
  config?: string; root?: string; agent?: string; provider?: string; model?: string;
  module?: string; export?: string; baseUrl?: string; apiKey?: boolean; noBrowser?: boolean; json?: boolean;
};

const readOptional = (path: string) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});

/** Preserve edits made during an interactive login. Serialize Dispatch's own writers. */
async function saveFile(path: string, original: string | undefined, text: string) {
  const release = await lockfile.lock(path, { realpath: false });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (await readOptional(path) !== original) throw new Error(`${path} changed during setup. Run the command again; those edits were kept.`);
    const mode = original === undefined ? 0o600 : (await stat(path)).mode & 0o777;
    await writeFile(temporary, text, { flag: "wx", mode });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); await release(); }
}

async function settings(options: Options) {
  if (options.config && options.root) throw new Error("Use --config HOST.json or --root DIRECTORY; set root inside the configuration file.");
  let path = resolve(options.config ?? join(options.root ?? ".", "host.json"));
  const original = await readOptional(path);
  if (original !== undefined) path = await realpath(path);
  const input = original === undefined ? {} : JSON.parse(original);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Host settings must be a JSON object.");
  if (input.modelProviders !== undefined && !Array.isArray(input.modelProviders)) throw new Error("modelProviders must be a list.");
  const config: HostModelsConfig & { root: string; cwd: string } = original === undefined ? { root: await realpath(options.root ?? dirname(path)), cwd: await realpath(options.root ?? dirname(path)), modelProviders: [] }
    : await readHostConfig(path);
  return { path, original, input, config };
}

async function authenticate(provider: Provider, interaction: AuthInteraction, forceApiKey = false) {
  if (forceApiKey && !provider.auth.apiKey?.login) throw new Error(`${provider.name} does not offer interactive API-key setup.`);
  const credentials = new LocalCredentials();
  const models = createModels({ credentials });
  models.setProvider(provider);
  if (!provider.auth.oauth && !provider.auth.apiKey?.login) {
    if (await models.checkAuth(provider.id, { signal: interaction.signal })) return;
    throw new Error(`${provider.name} needs access configured in the host environment.`);
  }
  if (!forceApiKey && await models.checkAuth(provider.id, { signal: interaction.signal })) {
    const answer = await interaction.prompt({ type: "select", message: `Access is configured for ${provider.name}.`, options: [
      { id: "keep", label: "Use existing access" }, { id: "login", label: "Sign in again" },
    ] });
    if (answer === "keep") return;
  }
  const methods: { id: AuthType; label: string }[] = [];
  if (provider.auth.oauth && !forceApiKey) methods.push({ id: "oauth", label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name });
  if (provider.auth.apiKey?.login) methods.push({ id: "api_key", label: provider.auth.apiKey.name });
  const type = methods.length === 1 ? methods[0].id
    : await interaction.prompt({ type: "select", message: `Connect ${provider.name}`, options: methods }) as AuthType;
  const hostId = await credentials.hostId();
  try { await models.login(provider.id, type, interaction, { getDeviceId: () => hostId, agentName: "Dispatch" }); }
  catch { throw new Error(interaction.signal?.aborted ? "Setup cancelled."
    : `Could not sign in to ${provider.name}. Check the browser result and account eligibility, then retry. Raw credential errors were withheld.`); }
}

async function chooseModel(models: readonly Model<Api>[], interaction: AuthInteraction, id?: string) {
  if (!models.length) throw new Error("This connection returned no models for your access.");
  if (id) {
    const matches = models.filter(model => model.id === id);
    if (matches.length > 1) throw new Error(`Model ${id} is offered by several providers. Select one with --provider.`);
    const found = matches[0];
    if (!found) throw new Error(`Model ${id} is unavailable through this connection.`);
    return found;
  }
  if (models.length === 1) return models[0];
  const selected = await interaction.prompt({ type: "select", message: "Choose a model", options: models.map(model => ({
    id: `${model.provider}/${model.id}`, label: model.name, description: `${model.provider}/${model.id}`,
  })) });
  return models.find(model => `${model.provider}/${model.id}` === selected)!;
}

async function useModel(root: string, model: Model<Api>, interaction: AuthInteraction, agent?: string) {
  const agents = (await catalog(root)).filter(item => item.runnable);
  if (!agents.length) throw new Error("Create agent.md or agents/NAME/agent.md first, then run dispatch models use.");
  const id = agent ?? await interaction.prompt({ type: "select", message: "Use this model for which agent?", options: agents.map(item => ({ id: item.id, label: item.id })) });
  if (!agents.some(item => item.id === id)) throw new Error(`Unknown agent: ${id}`);
  const rootAgent = id === "agent" ? await readOptional(join(root, "agent.md")) : undefined;
  const path = await realpath(rootAgent === undefined ? join(root, "agents", id, "agent.md") : join(root, "agent.md"));
  const original = await readFile(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(original);
  if (!match) throw new Error("Agent instructions need YAML frontmatter.");
  const meta = parseDocument(match[1]);
  if (meta.errors.length || !meta.contents) throw new Error("Cannot edit invalid agent frontmatter.");
  const thinking = meta.getIn(["model", "thinking"]);
  meta.setIn(["model", "provider"], model.provider);
  meta.setIn(["model", "id"], model.id);
  if (typeof thinking === "string" && !getSupportedThinkingLevels(model).some(level => level === thinking)) meta.setIn(["model", "thinking"], "off");
  await saveFile(path, original, `---\n${meta.toString()}---\n${original.slice(match[0].length)}`);
  console.log(terminalText(`Saved ${model.provider}/${model.id} for ${id}. Restart the host to load the definition; existing conversations retain their model.`));
}

export async function providerCommand(action: "list" | "add", id: string | undefined, options: Options) {
  if (action === "list" && (id || options.module || options.export || options.baseUrl || options.apiKey)) throw new Error("Use providers add to configure a connection.");
  if ((options.module && id) || (options.export && !options.module)) throw new Error("Choose a provider ID, or --module with an optional --export.");
  const file = await settings(options);
  const entries = providerCatalog();
  if (action === "list") {
    const saved = await new LocalCredentials().list();
    const configured = await Promise.all((file.config.modelProviders ?? []).map(async binding => ({ binding, ...(await loadModelProvider(binding)) })));
    const rows = entries.map(entry => ({ id: entry.provider.id, name: entry.provider.name,
      login: entry.provider.auth.oauth?.loginLabel ?? entry.provider.auth.oauth?.name ?? entry.provider.auth.apiKey?.name,
      configured: configured.some(item => (item.binding.id ?? item.provider.id) === entry.provider.id),
      credential: saved.find(item => item.providerId === entry.provider.id)?.type,
    }));
    for (const item of configured) if (!rows.some(row => row.id === (item.binding.id ?? item.provider.id))) rows.push({
      id: item.binding.id ?? item.provider.id, name: item.provider.name, login: undefined, configured: true,
      credential: saved.find(saved => saved.providerId === (item.binding.id ?? item.provider.id))?.type,
    });
    if (options.json) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) console.log(terminalText(`${row.id}\t${row.name}\t${row.configured ? "configured" : "not configured"}${row.credential ? ` · ${row.credential}` : ""}${row.login ? ` · ${row.login}` : ""}`));
    return;
  }
  const interaction = terminalInteraction(options);
  let owner: ReturnType<typeof hostModels> | undefined;
  try {
    const chosen = options.module ? undefined : id ?? await interaction.prompt({ type: "select", message: "Add a provider", options: entries.map(entry => ({
      id: entry.provider.id, label: entry.provider.name, description: entry.provider.auth.oauth?.loginLabel ?? entry.provider.id,
    })) });
    const entry = entries.find(entry => entry.provider.id === chosen);
    const binding: ModelProviderBinding = options.module
      ? { module: resolve(options.module), export: options.export ?? "default", credentials: "local" }
      : { provider: chosen };
    const { provider } = await loadModelProvider(binding);
    if (options.baseUrl) binding.baseUrl = options.baseUrl;
    else if (entry?.process) {
      const mode = await interaction.prompt({ type: "select", message: `${provider.name} server`, options: [
        { id: "managed", label: "Let Dispatch start and stop it" }, { id: "external", label: "Connect to a server I manage" },
      ] });
      if (mode === "managed") binding.process = entry.process;
      else binding.baseUrl = await interaction.prompt({ type: "text", message: "Server base URL (including its API path)" });
    }
    await authenticate(provider, interaction, options.apiKey);
    owner = hostModels({ modelProviders: [binding] }, file.config.cwd);
    const models = createModels();
    console.log(terminalText(`Discovering models from ${provider.name}…`));
    await owner.connect(models, interaction.signal);
    const model = await chooseModel(await models.getAvailable(undefined, { signal: interaction.signal }), interaction, options.model);
    console.log(terminalText(`Checking a live response from ${model.provider}/${model.id}…`));
    const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Reply with one short greeting.", timestamp: Date.now() }] }, { signal: interaction.signal });
    interaction.signal.throwIfAborted();
    if (result.stopReason === "error" || result.stopReason === "aborted" || !result.content.some(part => part.type === "text" && part.text.trim()))
      throw new Error(`No successful response from ${model.provider}/${model.id}. Check provider access; host settings were kept. Raw provider errors were withheld.`);
    console.log(terminalText(`Verified: ${result.content.filter(part => part.type === "text").map(part => part.text).join("\n")}`));
    // Keep unrelated settings and factory bindings; a matching provider is replaced only by an explicit setup command.
    const bindings: ModelProviderBinding[] = file.input.modelProviders ?? [];
    const keep: ModelProviderBinding[] = [];
    for (let index = 0; index < bindings.length; index++) {
      const existing = file.config.modelProviders![index];
      const loaded = await loadModelProvider(existing);
      if ((existing.id ?? loaded.provider.id) !== provider.id) keep.push(bindings[index]);
    }
    const saved = { ...binding, ...(binding.module ? { module: `./${relative(dirname(file.path), binding.module)}` } : {}) };
    await saveFile(file.path, file.original, `${JSON.stringify({ ...file.input, modelProviders: [...keep, saved] }, null, 2)}\n`);
    console.log(terminalText(`Saved ${provider.name} in ${file.path}. Start or restart dispatch serve to use it.`));
    if (options.agent || await interaction.prompt({ type: "select", message: "Use this model for an agent?", options: [
      { id: "later", label: "Choose later with dispatch models use" }, { id: "use", label: "Choose an agent now" },
    ] }) === "use") await useModel(file.config.root, model, interaction, options.agent);
  } finally { try { await owner?.close(); } finally { interaction.close(); } }
}

export async function modelCommand(action: "list" | "use", options: Options) {
  const file = await settings(options);
  if (!file.original) throw new Error("Run dispatch providers add first, or supply --config HOST.json.");
  const selected: ModelProviderBinding[] = [];
  for (const binding of file.config.modelProviders ?? []) {
    const { provider } = await loadModelProvider(binding);
    if (!options.provider || (binding.id ?? provider.id) === options.provider) selected.push(binding);
  }
  if (options.provider && !selected.length && !file.config.gateway) throw new Error(`Provider ${options.provider} is not configured.`);
  const interaction = action === "use" ? terminalInteraction(options) : undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (!interaction) { process.once("SIGINT", cancel); process.once("SIGTERM", cancel); }
  const owner = hostModels({ ...file.config, modelProviders: selected }, file.config.cwd);
  try {
    const models = createModels();
    await owner.connect(models, interaction?.signal ?? controller.signal);
    const available = await models.getAvailable(options.provider, { signal: interaction?.signal ?? controller.signal });
    if (action === "list") {
      if (options.json) console.log(JSON.stringify(available.map(({ provider, id, name, contextWindow }) => ({ provider, id, name, contextWindow })), null, 2));
      else for (const model of available) console.log(terminalText(`${model.provider}/${model.id}\t${model.name}`));
    } else await useModel(file.config.root, await chooseModel(available, interaction!, options.model), interaction!, options.agent);
  } finally {
    try { await owner.close(); } finally {
      interaction?.close(); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    }
  }
}
