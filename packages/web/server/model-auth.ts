import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ModelOption, ThinkingLevel } from "../src/shared/contracts.js";

const defaultsSchema = z.object({
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultThinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
});

/** Use Pi's public credential handling, including its locked OAuth refresh. */
export async function openModels(environment: NodeJS.ProcessEnv = process.env) {
  const agentDir = resolve(environment.DISPATCH_PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  let defaults: z.infer<typeof defaultsSchema> = {};
  try { defaults = defaultsSchema.parse(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const provider = environment.DISPATCH_PROVIDER ?? defaults.defaultProvider ?? "openai";
  const modelId = environment.DISPATCH_MODEL ?? defaults.defaultModel ?? "gpt-6-sol";
  const models = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const model = models.getModel(provider, modelId);
  if (!model) throw new Error(`Configured model ${provider}/${modelId} is unavailable. Check DISPATCH_PROVIDER and DISPATCH_MODEL.`);
  const requestedThinking = environment.DISPATCH_THINKING ?? defaults.defaultThinkingLevel ?? "off";
  const allowedThinking = getSupportedThinkingLevels(model);
  if (!allowedThinking.includes(requestedThinking as ThinkingLevel)) {
    throw new Error(`Model ${provider}/${modelId} does not support thinking level ${requestedThinking}. Choose ${allowedThinking.join(", ")}.`);
  }
  return {
    models, provider, modelId, thinkingLevel: requestedThinking as ThinkingLevel,
    async configuration() {
      const available = await models.getAvailable();
      const choices = available.some((item) => item.provider === provider && item.id === modelId) ? available : [model, ...available];
      return {
        models: choices.map((item): ModelOption => ({ provider: item.provider, id: item.id, name: item.name, reasoning: item.reasoning, thinkingLevels: [...getSupportedThinkingLevels(item)] })),
        providerReady: models.hasConfiguredAuth(provider),
      };
    },
  };
}
