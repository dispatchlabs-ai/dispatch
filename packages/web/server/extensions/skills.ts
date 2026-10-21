import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";

export type SkillSnapshot = {
  id: string;
  revision: number;
  name: string;
  description: string;
  instructions: string;
};

/** Populate once when creating the participant, in the same transaction as its agent configuration. */
export const SkillBindingsDoc = defineDoc<{ skills: SkillSnapshot[] }>({
  kind: "dispatch.skill-bindings", version: 1, scope: "conversation", history: "rewindable", fork: "asOf",
  initial: () => ({ skills: [] }),
});

const loadSkill = defineTool({
  name: "load_skill",
  description: "Load the saved instructions of an assigned skill by its ID from the skills catalog.",
  parameters: Type.Object({ id: Type.String({ minLength: 1, description: "An assigned skill ID from the skills catalog." }) }),
  // Loading a saved snapshot has no external effects and never consults the current skill catalog.
  replay: "safe",
  // Return the full supported 50,000-character instructions, including multibyte text and many short lines.
  outputLimits: { maxBytes: 256_000, maxLines: 50_010 },
  execute: async ({ id }, api, context) => {
    const binding = await api.snapshot(SkillBindingsDoc, api.conversationId, context);
    const skill = binding?.skills.find(candidate => candidate.id === id);
    if (!skill) return { isError: true, content: [{ type: "text", text: "This skill is not assigned to this agent instance." }] };
    return {
      content: [{ type: "text", text: skill.instructions }],
      details: { id: skill.id, revision: skill.revision, name: skill.name },
    };
  },
});

/** Install at startup; select this extension and its tool only for participants with assigned skills. */
export const Skills = defineExtension({
  name: "dispatch-skills",
  tools: [loadSkill],
  sections: [section("skills", async (input, context) => {
    if (!input.agent.tools.some(tool => tool.name === loadSkill.name)) return undefined;
    const binding = await input.read.snapshot(SkillBindingsDoc, input.conversationId, context);
    if (!binding?.skills.length) return undefined;
    return [
      "These skills are explicitly assigned to this agent instance. When one is relevant, call load_skill with its id to read its instructions before using it.",
      "Skills provide guidance, not additional tools or permissions. Only the assigned, saved revisions listed here are available through load_skill.",
      JSON.stringify(binding.skills.map(({ id, revision, name, description }) => ({ id, revision, name, description }))),
    ].join("\n\n");
  })],
});
