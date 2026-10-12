import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { codexImageProvider } from "./codex-image-provider.js";
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
  // Pi lazily loads OAuth implementations, some of which capture this value.
  // Browser setup must never open a public callback listener, even on remote hosts.
  if (process.env.PI_OAUTH_CALLBACK_HOST && process.env.PI_OAUTH_CALLBACK_HOST !== "127.0.0.1")
    throw new Error("Provider OAuth callbacks require PI_OAUTH_CALLBACK_HOST=127.0.0.1; remote browsers use the manual redirect flow.");
  process.env.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";
  const agentDir = resolve(environment.DISPATCH_PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  let defaults: z.infer<typeof defaultsSchema> = {};
  try { defaults = defaultsSchema.parse(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const inheritedProvider = defaults.defaultProvider === "openai-codex" ? undefined : defaults.defaultProvider;
  const provider = environment.DISPATCH_PROVIDER ?? inheritedProvider ?? "openai";
  const modelId = environment.DISPATCH_MODEL ?? defaults.defaultModel ?? "gpt-6-sol";
  const models = await ModelRuntime.create({
    ...(credentials ? { credentials, refreshOnCreate: false } : { authPath: join(agentDir, "auth.json") }),
    modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate,
  });
  models.registerNativeProvider(codexImageProvider());
  const thinkingLevel = (environment.DISPATCH_THINKING ?? defaults.defaultThinkingLevel ?? "off") as ThinkingLevel;
  return {
    models, provider, modelId, thinkingLevel,
    async configuration(defaultAgent: Pick<AgentDraft, "provider" | "modelId">) {
      const model = defaultAgent.provider === "openai-codex" ? undefined : models.getModel(defaultAgent.provider, defaultAgent.modelId);
      // A pending/invalid credential must not prevent opening Settings to repair
      // it. Pi's global enumeration rejects if any provider's auth check fails.
      const available = (await Promise.all(models.getProviders().filter(provider => provider.id !== "openai-codex").map(async provider => {
        try { return await models.getAvailable(provider.id); }
        catch { return []; } // Provider setup reports the unavailable credential without exposing its error.
      }))).flat();
      const choices = !model || available.some((item) => item.provider === model.provider && item.id === model.id) ? available : [model, ...available];
      return {
        sdkModels: models.getModels().filter(item => item.provider === "anthropic").map((item): ModelOption => ({ provider: item.provider, id: item.id, name: item.name, reasoning: item.reasoning, thinkingLevels: [...getSupportedThinkingLevels(item)] })),
        models: choices.map((item): ModelOption => ({ provider: item.provider, id: item.id, name: item.name, reasoning: item.reasoning, thinkingLevels: [...getSupportedThinkingLevels(item)] })),
        providerReady: available.some(item => item.provider === defaultAgent.provider),
      };
    },
  };
}
