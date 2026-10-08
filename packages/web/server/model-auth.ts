import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentDraft, ModelOption, ThinkingLevel } from "../src/shared/contracts.js";

const defaultsSchema = z.object({
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultThinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
});

/** Use Pi's public credential handling, including its locked OAuth refresh. */
export async function openModels(
  environment: NodeJS.ProcessEnv = process.env,
  credentials?: NonNullable<Parameters<typeof ModelRuntime.create>[0]>["credentials"],
  refreshOnCreate = credentials === undefined,
) {
  const agentDir = resolve(environment.DISPATCH_PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  let defaults: z.infer<typeof defaultsSchema> = {};
  try { defaults = defaultsSchema.parse(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const provider = environment.DISPATCH_PROVIDER ?? defaults.defaultProvider ?? "openai";
  const modelId = environment.DISPATCH_MODEL ?? defaults.defaultModel ?? "gpt-6-sol";
  const models = await ModelRuntime.create({
    ...(credentials ? { credentials, refreshOnCreate: false } : { authPath: join(agentDir, "auth.json") }),
    modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate,
  });
  const thinkingLevel = (environment.DISPATCH_THINKING ?? defaults.defaultThinkingLevel ?? "off") as ThinkingLevel;
  return {
    models, provider, modelId, thinkingLevel,
    async configuration(defaultAgent: Pick<AgentDraft, "provider" | "modelId">) {
      const model = models.getModel(defaultAgent.provider, defaultAgent.modelId);
      const available = await models.getAvailable();
      const choices = !model || available.some((item) => item.provider === model.provider && item.id === model.id) ? available : [model, ...available];
      return {
        models: choices.map((item): ModelOption => ({ provider: item.provider, id: item.id, name: item.name, reasoning: item.reasoning, thinkingLevels: [...getSupportedThinkingLevels(item)] })),
        providerReady: models.hasConfiguredAuth(defaultAgent.provider),
      };
    },
  };
}
