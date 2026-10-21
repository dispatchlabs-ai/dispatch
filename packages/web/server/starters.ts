import { z } from "zod";
import { encodeBundle } from "./bundles.js";

export const starterSelectionSchema = z.object({
  provider: z.string().min(1).max(100),
  modelId: z.string().min(1).max(200),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
}).strict();

/** Repository-owned template; model selection is explicit, never copied from a live agent. */
export function createDeveloperStarter(input: unknown): { archive: string; filename: string } {
  const selection = starterSelectionSchema.parse(input);
  const archive = encodeBundle({
    formatVersion: 1, id: "dispatch-starter-developer", version: "1.0.0",
    agents: [{
      key: "developer", name: "Developer",
      description: "Builds, debugs, and improves software in a coding workspace.",
      instructions: "Inspect the project and its instructions before changing code. Make focused changes, preserve existing work, and explain what changed and how it was checked. Be clear about anything you could not verify.",
      ...selection, capabilities: ["files-and-commands"], skills: [], omittedConnections: 0,
    }],
    skills: [],
  });
  return { archive: archive.toString("base64"), filename: "dispatch-starter-developer-1.0.0.zip" };
}
