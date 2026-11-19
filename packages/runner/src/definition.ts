import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@earendil-works/pi-durable";
import { parse } from "yaml";
import { loadSkills, type Skill } from "./skills.js";
import { formatRepositoryInstructions, loadRepositoryInstructions, type RepositoryInstruction } from "./instructions.js";
import { validateSchedules, type AgentSchedule } from "./schedules.js";
import type { AgentEnvironment } from "./environments.js";
import { loadAgentAvatar, type AgentAvatar } from "./avatars.js";

export type Trigger =
  | { mode: "manual" }
  | { mode: "continuous"; delayMs: number }
  | { mode: "interval"; everyMs: number; runImmediately?: boolean };

export type AgentDefinition = {
  /** Application-owned Nix recipe; optional host-managed execution environment. */
  environment?: AgentEnvironment;
  trigger?: Trigger;
  /** The input sent for each scheduled iteration. */
  input?: string;
  schedules?: AgentSchedule[];
  /** Native Pi Durable extensions. No tools are installed by default. */
  extensions?: Extension[];
  /** Named MCP connections supplied by the host. Also accepted in Markdown frontmatter. */
  mcp?: string[];
  /** Native coding tools, with a private checkout selected by the agent. */
  coding?: boolean;
  /** "chat" runs each chat's shell and file tools in its own disposable workspace, which the host's `workspace` setting supplies. */
  workspace?: "chat";
  /** Company skills and this agent's own: true for the whole catalog, or the skill IDs this agent may read. Opt-in for existing stores. */
  skills?: boolean | string[];
  /** Named agents available for native foreground delegation. */
  delegates?: string[];
  /** Fresh task-owned children inheriting the calling conversation's native agent configuration. */
  clones?: boolean;
  /** Agent types addressable as independent instances in the same ChatService. */
  messages?: string[];
  /** Default true. False keeps messages' permission and delivery but gives the model no native message tools,
   * for an agent that sends through the Dispatch MCP connector instead. */
  messageTools?: boolean;
  /** Post progress notes in this agent's conversation. Defaults to the host setting. */
  progressNotes?: boolean;
  handoff?: { target: string; progressEveryMs: number };
};

export type LoadedAgent = AgentDefinition & {
  trigger: Trigger;
  input: string;
  root: string;
  id: string;
  instructions: string;
  description: string;
  /** Presentation only; never included in model instructions or the definition fingerprint. */
  avatar?: AgentAvatar;
  model: { provider: string; id: string; thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
  fingerprint: string;
  skillCatalog?: Skill[];
  handoffAgent?: LoadedAgent;
  delegateAgents?: LoadedAgent[];
  repositoryInstructions: RepositoryInstruction[];
};

export const agentName = /^[a-z][a-z0-9-]*$/;
const skillId = /^(company|agent)\/[a-z][a-z0-9-]*$/;

/** Optional preview.ts next to agent.md. Explicit tool or skill fixtures replace the live bindings. */
export type AgentPreview = {
  extensions?: Extension[];
  /** Scoped skill IDs, or true to include the whole skill catalog. */
  skills?: true | string[];
  /** Stable directory and conversation key under .demo/. Defaults to the agent ID. */
  history?: string;
  /** Include the current operator when enrolled in the application roster. Defaults to true. */
  includeSelf?: boolean;
};

export function defineAgent(definition: AgentDefinition = {}): AgentDefinition & { trigger: Trigger; input: string } {
  const trigger = definition.trigger ?? { mode: "manual" };
  if (definition.input !== undefined && typeof definition.input !== "string") throw new Error("Agent input must be text.");
  if (trigger.mode !== "manual" && !definition.input?.trim()) throw new Error("A scheduled agent needs a nonempty input.");
  validateSchedules(definition.schedules);
  if (definition.environment !== undefined && (!definition.environment || typeof definition.environment.recipe !== "string"
    || !definition.environment.recipe.endsWith(".nix") || definition.environment.recipe.startsWith("/")
    || definition.environment.recipe.split(/[\\/]/).includes(".."))) throw new Error("environment.recipe must be an application-relative .nix path.");
  if (definition.mcp !== undefined && (!Array.isArray(definition.mcp)
    || definition.mcp.some(name => typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name))
    || new Set(definition.mcp).size !== definition.mcp.length)) throw new Error("mcp must be a list of unique MCP server names.");
  if (definition.delegates && (!Array.isArray(definition.delegates) || definition.delegates.some(id => !agentName.test(id))
    || new Set(definition.delegates).size !== definition.delegates.length)) throw new Error("Delegates must be unique agent names.");
  if (definition.messages && (!Array.isArray(definition.messages) || definition.messages.some(id => !agentName.test(id))
    || new Set(definition.messages).size !== definition.messages.length)) throw new Error("Message recipients must be unique agent names.");
  if (definition.messageTools !== undefined && typeof definition.messageTools !== "boolean") throw new Error("messageTools must be a boolean.");
  if (definition.progressNotes !== undefined && typeof definition.progressNotes !== "boolean") throw new Error("progressNotes must be a boolean.");
  if (definition.messageTools === false && !definition.messages?.length) throw new Error("messageTools: false applies only to an agent with messages.");
  if (!trigger || !["manual", "continuous", "interval"].includes(trigger.mode)) {
    throw new Error("Trigger mode must be manual, continuous, or interval.");
  }
  if (trigger.mode !== "manual") {
    const ms = trigger.mode === "continuous" ? trigger.delayMs : trigger.everyMs;
    if (!Number.isSafeInteger(ms) || ms < (trigger.mode === "continuous" ? 0 : 1)) {
      throw new Error("Trigger delay/interval must be an integer number of milliseconds (interval > 0, delay >= 0).");
    }
  }
  if (trigger.mode === "interval" && trigger.runImmediately !== undefined && typeof trigger.runImmediately !== "boolean") {
    throw new Error("runImmediately must be a boolean.");
  }
  if (definition.coding !== undefined && typeof definition.coding !== "boolean") throw new Error("coding must be a boolean.");
  if (definition.workspace !== undefined && definition.workspace !== "chat") throw new Error('workspace must be "chat".');
  if (definition.skills !== undefined && typeof definition.skills !== "boolean" && !(Array.isArray(definition.skills)
    && definition.skills.length && definition.skills.every(id => typeof id === "string" && skillId.test(id))
    && new Set(definition.skills).size === definition.skills.length)) {
    throw new Error("skills must be a boolean or a list of distinct skill IDs such as company/code-review.");
  }
  if (definition.clones !== undefined && typeof definition.clones !== "boolean") throw new Error("clones must be a boolean.");
  if (definition.handoff && (!agentName.test(definition.handoff.target)
    || !Number.isSafeInteger(definition.handoff.progressEveryMs) || definition.handoff.progressEveryMs <= 0)) {
    throw new Error("A handoff needs a target agent and a positive progressEveryMs.");
  }
  return { ...definition, trigger, input: definition.input ?? "" };
}

const frontmatterKeys = ["description", "model", "mcp", "environment", "progressNotes"];
const modelKeys = ["provider", "id", "thinking"];
const agentModuleKeys = ["trigger", "input", "schedules", "extensions", "coding", "workspace", "skills", "delegates", "clones", "messages", "messageTools", "handoff"];

/** Settings Dispatch does not read must not silently change an agent's fingerprint. */
function validateFrontmatter(meta: unknown, source: string): void {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error(`${source} frontmatter must be a YAML mapping.`);
  const module = source.replace(/\.md$/, ".ts");
  for (const key of Object.keys(meta)) {
    if (frontmatterKeys.includes(key)) continue;
    if (agentModuleKeys.includes(key)) throw new Error(`${source}: ${key} is set in ${module} with defineAgent({ ${key} }), not in frontmatter.`);
    throw new Error(`${source}: unsupported frontmatter key ${key}. Frontmatter accepts ${frontmatterKeys.join(", ")}. Move a descriptive note into the instructions; if your application's code reads ${key}, move it to an application-owned file together with that reader.`);
  }
  const model = (meta as { model?: unknown }).model;
  if (model && typeof model === "object" && !Array.isArray(model)) {
    for (const key of Object.keys(model)) {
      if (!modelKeys.includes(key)) throw new Error(`${source}: unsupported model setting ${key}. model accepts ${modelKeys.join(", ")}.`);
    }
  }
}

async function hasRootAgent(root: string): Promise<boolean> {
  return access(join(root, "agent.md")).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

export async function catalog(root: string): Promise<{ id: string; runnable: boolean }[]> {
  const entries = await readdir(join(root, "agents"), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const agents = await Promise.all(entries.filter((entry) => entry.isDirectory() && agentName.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
      const files = await readdir(join(root, "agents", entry.name));
      return { id: entry.name, runnable: files.includes("agent.md") };
    }));
  if (await hasRootAgent(root)) {
    if (agents.some(agent => agent.id === "agent" && agent.runnable)) throw new Error("Choose either agent.md or agents/agent/agent.md; both define the agent named agent.");
    return [{ id: "agent", runnable: true }, ...agents.filter(agent => agent.id !== "agent")];
  }
  return agents;
}

async function agentFolder(root: string, id: string) {
  if (!agentName.test(id)) throw new Error(`Invalid agent name: ${id}`);
  let folder = join(root, "agents", id);
  if (id === "agent" && await hasRootAgent(root)) {
    await access(join(folder, "agent.md")).then(() => {
      throw new Error("Choose either agent.md or agents/agent/agent.md; both define the agent named agent.");
    }, error => { if (error.code !== "ENOENT") throw error; });
    folder = root;
  }
  return folder;
}

async function agentModule(folder: string, filename: string) {
  const path = join(folder, filename);
  const code = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (code === undefined) return { code: "", value: undefined };
  const module = await import(pathToFileURL(path).href);
  if (!Object.hasOwn(module, "default")) throw new Error(`${path} must export its definition as default.`);
  return { code, value: module.default };
}

export async function loadAgent(root: string, id: string, ancestors: string[] = []): Promise<LoadedAgent> {
  if (ancestors.includes(id)) throw new Error(`Circular agent dependency: ${[...ancestors, id].join(" → ")}`);
  return readDefinition(root, id, await agentFolder(root, id), ancestors);
}

export async function loadPreviewAgent(root: string, id: string) {
  const folder = await agentFolder(root, id);
  const { code, value } = await agentModule(folder, "preview.ts");
  const preview: AgentPreview = value ?? {};
  if (typeof preview !== "object" || Array.isArray(preview) ||
    Object.keys(preview).some(key => !["extensions", "skills", "history", "includeSelf"].includes(key)) ||
    (preview.includeSelf !== undefined && typeof preview.includeSelf !== "boolean") ||
    (preview.extensions !== undefined && !Array.isArray(preview.extensions)) ||
    (preview.skills !== undefined && preview.skills !== true && (!Array.isArray(preview.skills) || preview.skills.some(id => typeof id !== "string"))) ||
    (preview.history !== undefined && (typeof preview.history !== "string" || !agentName.test(preview.history)))) {
    throw new Error("preview.ts accepts extensions, skills (true or scoped skill IDs), a history name and includeSelf.");
  }
  const fixtures = preview.extensions !== undefined || preview.skills !== undefined;
  return { agent: await readDefinition(root, id, folder, [], fixtures ? { ...preview, code } : undefined),
    fixtures, history: preview.history ?? id, includeSelf: preview.includeSelf ?? true };
}

async function readDefinition(root: string, id: string, folder: string, ancestors: string[], preview?: AgentPreview & { code: string }): Promise<LoadedAgent> {
  const source = relative(root, join(folder, "agent.md")).replaceAll("\\", "/");
  const markdown = await readFile(join(folder, "agent.md"), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error(`${source} must contain YAML frontmatter followed by instructions.`);
  const meta = parse(match[1]);
  validateFrontmatter(meta, source);
  if (!meta || typeof meta.description !== "string" || !meta.description.trim()
    || typeof meta.model?.provider !== "string" || !meta.model.provider.trim()
    || typeof meta.model?.id !== "string" || !meta.model.id.trim()
    || (meta.model?.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(meta.model.thinking))
    || !match[2].trim()) {
    throw new Error(`${source} requires description, model.provider, model.id, and instructions.`);
  }
  const { code, value } = preview ? { code: preview.code, value: undefined } : await agentModule(folder, "agent.ts");
  const definition = defineAgent({
    ...(preview ? { extensions: preview.extensions, skills: !!preview.skills } :
      { ...value, ...(meta.mcp !== undefined ? { mcp: meta.mcp } : {}),
        ...(meta.environment !== undefined ? { environment: meta.environment } : {}) }),
    ...(meta.progressNotes !== undefined ? { progressNotes: meta.progressNotes } : {}),
  });
  let skillCatalog = definition.skills ? await loadSkills(root, id) : [];
  const listed = Array.isArray(preview?.skills) ? preview.skills : Array.isArray(definition.skills) ? definition.skills : undefined;
  if (listed) {
    const available = new Map(skillCatalog.map(skill => [skill.id, skill]));
    skillCatalog = listed.map(listedId => {
      const skill = available.get(listedId);
      if (!skill) throw new Error(preview ? `Unknown preview skill: ${listedId}` : `Agent ${id} lists an unknown skill: ${listedId}`);
      return skill;
    });
  }
  const repositoryInstructions = await loadRepositoryInstructions(folder, root);
  const handoffAgent = definition.handoff
    ? await loadAgent(root, definition.handoff.target, [...ancestors, id]) : undefined;
  const delegateAgents = definition.delegates?.length
    ? await Promise.all(definition.delegates.map(name => loadAgent(root, name, [...ancestors, id]))) : undefined;
  const instructions = [formatRepositoryInstructions(repositoryInstructions, root),
    `# Role instructions from ${source}\n${match[2].trim()}`].filter(Boolean).join("\n\n");
  return {
    ...definition, root, id, instructions,
    avatar: await loadAgentAvatar(folder),
    repositoryInstructions, description: meta.description, model: { ...meta.model, thinking: meta.model.thinking ?? "off" },
    ...(handoffAgent ? { handoffAgent } : {}),
    ...(delegateAgents ? { delegateAgents } : {}),
    ...(definition.skills ? { skillCatalog } : {}),
    fingerprint: createHash("sha256").update(markdown).update(code ?? "").update(instructions).update(handoffAgent?.fingerprint ?? "")
      .update(definition.schedules?.length ? JSON.stringify(definition.schedules) : "")
      .update(JSON.stringify(repositoryInstructions.map(({ path, revision }) => ({ path: relative(root, path), revision }))))
      .update(JSON.stringify(delegateAgents?.map(agent => agent.fingerprint) ?? []))
      .update(skillCatalog.length ? JSON.stringify(skillCatalog.map(({ id, revision }) => ({ id, revision }))) : "").digest("hex"),
  };
}

export async function enabledAgents(root: string): Promise<string[]> {
  const text = await readFile(join(root, "factory.yaml"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return [];
  const factory = parse(text);
  if (factory && factory.agents === undefined) return [];
  if (!Array.isArray(factory?.agents) || factory.agents.some((id: unknown) => typeof id !== "string" || !agentName.test(id))) {
    throw new Error("factory.yaml agents must be a list of agent names.");
  }
  if (new Set(factory.agents).size !== factory.agents.length) throw new Error("factory.yaml contains duplicate agents.");
  return factory.agents;
}

/** Default for a new conversation; independent of enabled calendars and loops. */
export async function defaultAgent(root: string): Promise<string> {
  const text = await readFile(join(root, "factory.yaml"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const factory = text === undefined ? undefined : parse(text);
  if (factory?.defaultAgent === undefined) {
    const agents = (await catalog(root)).filter(agent => agent.runnable);
    if (agents.length === 1) return agents[0].id;
    throw new Error("Select an agent for this conversation.");
  }
  if (typeof factory.defaultAgent !== "string" || !agentName.test(factory.defaultAgent)) throw new Error("Invalid factory.yaml defaultAgent.");
  await loadAgent(root, factory.defaultAgent);
  return factory.defaultAgent;
}

/** Fixed cadence for intervals; skip slots missed while busy or offline. */
export function nextDeadline(trigger: Trigger, previous: number, now: number): number {
  if (trigger.mode === "manual") throw new Error("Manual agents have no next deadline.");
  if (trigger.mode === "continuous") return now + trigger.delayMs;
  return previous + Math.max(1, Math.floor((now - previous) / trigger.everyMs) + 1) * trigger.everyMs;
}
