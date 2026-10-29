import type { AgentChange, Extension } from "@earendil-works/pi-durable";
import type { LoadedAgent } from "./definition.js";
import { createCoding } from "./coding.js";
import { createHandoffs } from "./handoff.js";
import type { ReplySink } from "./replies.js";
import { skillExtension, skillInstructions } from "./skills.js";
import { repositoryInstructionsExtension } from "./instructions.js";
import { delegationExtension } from "./delegation.js";

export type AgentSetup = { configuration: AgentChange; installed: Extension[]; delegate?: AgentSetup };

export function createConfiguration(codingExtension: ReturnType<typeof createCoding>["codingExtension"], handoffExtension: ReturnType<typeof createHandoffs>["handoffExtension"], progressInstructions?: (agent: LoadedAgent) => string) {
  async function agentConfiguration(
    agent: LoadedAgent, directory: string, demo: boolean, adapters: Extension[], sink?: ReplySink, cwd?: string,
    shared: Extension[] = [],
  ): Promise<AgentSetup> {
    const repositoryInstructions = repositoryInstructionsExtension();
    const extensions: Extension[] = [repositoryInstructions, ...(agent.extensions ?? [])];
    const installed: Extension[] = [];
    if (agent.skillCatalog?.length) extensions.push(skillExtension(agent.id, agent.skillCatalog));
    let delegate: AgentSetup | undefined;
    const model = demo ? { provider: "faux", modelId: "faux-1" } : { provider: agent.model.provider, modelId: agent.model.id };
    if (agent.coding) extensions.push(...(await codingExtension(agent.root, directory)).extensions);
    if (agent.handoff && agent.handoffAgent) {
      const child = await agentConfiguration(agent.handoffAgent, directory, demo, [], sink, cwd, shared);
      delegate = child;
      installed.push(...child.installed);
      extensions.push(handoffExtension({
        target: agent.handoff.target, supervisorName: agent.id, configuration: child.configuration,
        progressEveryMs: agent.handoff.progressEveryMs, sink,
        supervisor: {
          model, thinkingLevel: agent.model.thinking, extensions: [repositoryInstructions], cwd,
          instructions: agent.instructions + "\n\n" + (progressInstructions?.(agent) ?? `You are ${agent.id}, giving the user a brief progress update about ${agent.handoff.target}'s work. Use only the supplied public milestones and tool status. In one or two clear sentences explain what has been learned, what is being checked next, or what is blocked. Speak to a nontechnical colleague; avoid tool names and implementation jargon. Do not infer completed work, reveal private reasoning, promise a completion time, or ask questions. If there is no meaningful change from the last update, answer exactly NO_UPDATE.`),
        },
      }));
    }
    if (agent.delegateAgents?.length || agent.clones) {
      const delegates = await Promise.all((agent.delegateAgents ?? []).map(async target => {
        const setup = await agentConfiguration(target, directory, demo, [], sink, cwd, shared);
        installed.push(...setup.installed);
        return { name: target.id, description: target.description, configuration: setup.configuration };
      }));
      extensions.push(delegationExtension(agent.id, delegates, agent.clones));
    }
    extensions.push(...shared, ...adapters);
    installed.push(...extensions);
    return {
      configuration: { model, thinkingLevel: agent.model.thinking, instructions: agent.instructions + skillInstructions(agent.skillCatalog ?? []), extensions, ...(cwd ? { cwd } : {}) },
      installed, ...(delegate ? { delegate } : {}),
    };
  }

  return { agentConfiguration };
}
