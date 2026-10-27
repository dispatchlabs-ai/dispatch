import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@earendil-works/pi-durable";
import { parse } from "yaml";
import { loadSkills, type Skill } from "./skills.js";
import { formatRepositoryInstructions, loadRepositoryInstructions, type RepositoryInstruction } from "./instructions.js";
import { validateSchedules, type AgentSchedule } from "./schedules.js";

export type Trigger =
  | { mode: "manual" }
  | { mode: "continuous"; delayMs: number }
  | { mode: "interval"; everyMs: number; runImmediately?: boolean };

export type AgentDefinition = {
  trigger: Trigger;
  /** The input sent for each scheduled iteration. */
  input: string;
  schedules?: AgentSchedule[];
  /** Native Pi Durable extensions. No tools are installed by default. */
  extensions?: Extension[];
  /** Native coding tools, with a private checkout selected by the agent. */
  coding?: boolean;
  /** Discover company skills and this agent's own skills. Opt-in for existing stores. */
  skills?: boolean;
  /** Named agents available for native foreground delegation. */
  delegates?: string[];
  /** Fresh task-owned children inheriting the calling conversation's native agent configuration. */
  clones?: boolean;
  /** Agent types addressable as independent instances in the same ChatService. */
  messages?: string[];
  handoff?: { target: string; progressEveryMs: number };
};

export type LoadedAgent = AgentDefinition & {
  root: string;
  id: string;
  instructions: string;
  description: string;
  model: { provider: string; id: string; thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
  fingerprint: string;
  skillCatalog?: Skill[];
  handoffAgent?: LoadedAgent;
  delegateAgents?: LoadedAgent[];
  repositoryInstructions: RepositoryInstruction[];
};

export const agentName = /^[a-z][a-z0-9-]*$/;

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  if (!definition || typeof definition.input !== "string" || !definition.input.trim()) {
    throw new Error("An agent needs a nonempty input.");
  }
  validateSchedules(definition.schedules);
  if (definition.delegates && (!Array.isArray(definition.delegates) || definition.delegates.some(id => !agentName.test(id))
    || new Set(definition.delegates).size !== definition.delegates.length)) throw new Error("Delegates must be unique agent names.");
  if (definition.messages && (!Array.isArray(definition.messages) || definition.messages.some(id => !agentName.test(id))
    || new Set(definition.messages).size !== definition.messages.length)) throw new Error("Message recipients must be unique agent names.");
  const trigger = definition.trigger;
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
  if (definition.skills !== undefined && typeof definition.skills !== "boolean") throw new Error("skills must be a boolean.");
  if (definition.clones !== undefined && typeof definition.clones !== "boolean") throw new Error("clones must be a boolean.");
  if (definition.handoff && (!agentName.test(definition.handoff.target)
    || !Number.isSafeInteger(definition.handoff.progressEveryMs) || definition.handoff.progressEveryMs <= 0)) {
    throw new Error("A handoff needs a target agent and a positive progressEveryMs.");
  }
  return definition;
}

export async function catalog(root: string): Promise<{ id: string; runnable: boolean }[]> {
  const entries = await readdir(join(root, "agents"), { withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isDirectory() && agentName.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
      const files = await readdir(join(root, "agents", entry.name));
      return { id: entry.name, runnable: files.includes("agent.ts") };
    }));
}

export async function loadAgent(root: string, id: string, ancestors: string[] = []): Promise<LoadedAgent> {
  if (!agentName.test(id)) throw new Error(`Invalid agent name: ${id}`);
  if (ancestors.includes(id)) throw new Error(`Circular agent dependency: ${[...ancestors, id].join(" → ")}`);
  const folder = join(root, "agents", id);
  const [markdown, code] = await Promise.all([
    readFile(join(folder, "agent.md"), "utf8"),
    readFile(join(folder, "agent.ts"), "utf8").catch((error) => {
      if (error.code === "ENOENT") throw new Error(`${id} is a draft: implement agents/${id}/agent.ts first.`);
      throw error;
    }),
  ]);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error(`${id}/agent.md must contain YAML frontmatter followed by instructions.`);
  const meta = parse(match[1]);
  if (!meta || typeof meta.description !== "string" || !meta.description.trim()
    || typeof meta.model?.provider !== "string" || !meta.model.provider.trim()
    || typeof meta.model?.id !== "string" || !meta.model.id.trim()
    || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(meta.model?.thinking)
    || !match[2].trim()) {
    throw new Error(`${id}/agent.md requires description, model.provider, model.id, model.thinking, and instructions.`);
  }
  // An agent module is trusted application code, loaded once per process.
  const module = await import(pathToFileURL(join(folder, "agent.ts")).href);
  const definition = defineAgent(module.default);
  const skillCatalog = definition.skills ? await loadSkills(root, id) : [];
  const repositoryInstructions = await loadRepositoryInstructions(folder, root);
  const handoffAgent = definition.handoff
    ? await loadAgent(root, definition.handoff.target, [...ancestors, id]) : undefined;
  const delegateAgents = definition.delegates?.length
    ? await Promise.all(definition.delegates.map(name => loadAgent(root, name, [...ancestors, id]))) : undefined;
  const instructions = [formatRepositoryInstructions(repositoryInstructions, "agent"),
    `# Role instructions from agents/${id}/agent.md\n${match[2].trim()}`].filter(Boolean).join("\n\n");
  return {
    ...definition, root, id, instructions,
    repositoryInstructions, description: meta.description, model: meta.model,
    ...(handoffAgent ? { handoffAgent } : {}),
    ...(delegateAgents ? { delegateAgents } : {}),
    ...(definition.skills ? { skillCatalog } : {}),
    fingerprint: createHash("sha256").update(markdown).update(code).update(instructions).update(handoffAgent?.fingerprint ?? "")
      .update(definition.schedules?.length ? JSON.stringify(definition.schedules) : "")
      .update(JSON.stringify(repositoryInstructions.map(({ path, revision }) => ({ path: relative(root, path), revision }))))
      .update(JSON.stringify(delegateAgents?.map(agent => agent.fingerprint) ?? []))
      .update(skillCatalog.length ? JSON.stringify(skillCatalog.map(({ id, revision }) => ({ id, revision }))) : "").digest("hex"),
  };
}

export async function enabledAgents(root: string): Promise<string[]> {
  const factory = parse(await readFile(join(root, "factory.yaml"), "utf8"));
  if (!Array.isArray(factory?.agents) || factory.agents.some((id: unknown) => typeof id !== "string" || !agentName.test(id))) {
    throw new Error("factory.yaml agents must be a list of agent names.");
  }
  if (new Set(factory.agents).size !== factory.agents.length) throw new Error("factory.yaml contains duplicate agents.");
  return factory.agents;
}

/** Fixed cadence for intervals; skip slots missed while busy or offline. */
export function nextDeadline(trigger: Trigger, previous: number, now: number): number {
  if (trigger.mode === "manual") throw new Error("Manual agents have no next deadline.");
  if (trigger.mode === "continuous") return now + trigger.delayMs;
  return previous + Math.max(1, Math.floor((now - previous) / trigger.everyMs) + 1) * trigger.everyMs;
}
