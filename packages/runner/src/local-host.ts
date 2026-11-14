import { createModels } from "@earendil-works/pi-ai/models";
import { catalog, loadAgent } from "./definition.js";
import { localProvider } from "./local-provider.js";
import { localHostPaths } from "./host-config.js";
import type { ServiceConfig } from "./service.js";

export async function localHostConfig(options: { root?: string; state?: string; socket?: string; demo?: boolean }): Promise<ServiceConfig> {
  const paths = await localHostPaths(options);
  const agents = await Promise.all((await catalog(paths.root)).filter(agent => agent.runnable).map(agent => loadAgent(paths.root, agent.id)));
  if (!agents.length) throw new Error("No agent definition found. Create agent.md here, or agents/NAME/agent.md. Run dispatch --help for an example.");
  if (options.demo) return { ...paths, demo: true, schedules: false,
    modelProviders: [{ module: "@dispatch/runner/environment-provider", export: "demoProvider" }] };
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  const providers = [...new Set(agents.map(agent => agent.model.provider))];
  for (const name of providers) models.setProvider(await localProvider(name));
  for (const name of providers) {
    if (!await models.getAuth(name)) throw new Error(`Not signed in to ${name}. Run npx dispatch login ${name}. Use dispatch serve --demo to try synthetic replies without credentials.`);
  }
  await models.refresh({ providers });
  for (const agent of agents) {
    if (!models.getModel(agent.model.provider, agent.model.id)) throw new Error(`Model ${agent.model.provider}/${agent.model.id} is unavailable for ${agent.id}. Check its name and provider access, or configure a custom provider with --config.`);
  }
  return { ...paths, modelProviders: providers.map(name => ({
    module: "@dispatch/runner/local-provider", export: "localProvider", args: [name],
  })) };
}
