import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@earendil-works/pi-durable";
import { parse } from "yaml";

export type Trigger =
  | { mode: "manual" }
  | { mode: "continuous"; delayMs: number }
  | { mode: "interval"; everyMs: number; runImmediately?: boolean };

export type AgentDefinition = {
  trigger: Trigger;
  /** The input sent for each scheduled iteration. */
  input: string;
  /** Native Pi Durable extensions. No tools are installed by default. */
  extensions?: Extension[];
  /** Native coding tools, with a private checkout selected by the agent. */
  coding?: boolean;
  handoff?: { target: string; progressEveryMs: number };
};

export type LoadedAgent = AgentDefinition & {
  root: string;
  id: string;
  instructions: string;
  description: string;
  model: { provider: string; id: string; thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" };
  fingerprint: string;
  handoffAgent?: LoadedAgent;
};

export const agentName = /^[a-z][a-z0-9-]*$/;

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  if (!definition || typeof definition.input !== "string" || !definition.input.trim()) {
    throw new Error("An agent needs a nonempty input.");
  }
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
  if (ancestors.includes(id)) throw new Error(`Circular handoff: ${[...ancestors, id].join(" → ")}`);
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
    || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(meta.model?.thinking)
    || !match[2].trim()) {
    throw new Error(`${id}/agent.md requires description, model.provider, model.id, model.thinking, and instructions.`);
  }
  // An agent module is trusted application code, loaded once per process.
  const module = await import(pathToFileURL(join(folder, "agent.ts")).href);
  const definition = defineAgent(module.default);
  const handoffAgent = definition.handoff
    ? await loadAgent(root, definition.handoff.target, [...ancestors, id]) : undefined;
  return {
    ...definition, root, id, instructions: match[2].trim(), description: meta.description, model: meta.model,
    ...(handoffAgent ? { handoffAgent } : {}),
    fingerprint: createHash("sha256").update(markdown).update(code).update(handoffAgent?.fingerprint ?? "").digest("hex"),
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
