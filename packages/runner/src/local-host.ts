import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { catalog, loadAgent } from "./definition.js";
import { environmentProvider } from "./environment-provider.js";
import type { ServiceConfig } from "./service.js";

export async function localHostPaths(options: { root?: string; state?: string; socket?: string }) {
  const root = await realpath(resolve(options.root ?? "."));
  const stateRoot = resolve(root, options.state ?? ".state");
  // Unix socket names are short even when the application lives in a deeply nested checkout.
  const key = createHash("sha256").update(stateRoot).digest("hex").slice(0, 24);
  const socket = options.socket ? resolve(options.socket)
    : join(tmpdir(), `dispatch-${process.getuid?.() ?? "local"}-${key}`, "host.sock");
  return { root, stateRoot, cwd: root, socket };
}

export async function localHostConfig(options: { root?: string; state?: string; socket?: string; demo?: boolean }): Promise<ServiceConfig> {
  const paths = await localHostPaths(options);
  const agents = await Promise.all((await catalog(paths.root)).filter(agent => agent.runnable).map(agent => loadAgent(paths.root, agent.id)));
  if (!agents.length) throw new Error("No agent definition found. Create agent.md here, or agents/NAME/agent.md. Run dispatch --help for an example.");
  if (options.demo) return { ...paths, demo: true, schedules: false,
    modelProviders: [{ module: "@dispatch/runner/environment-provider", export: "demoProvider" }] };
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  const providers = [...new Set(agents.map(agent => agent.model.provider))];
  for (const name of providers) models.setProvider(await environmentProvider(name));
  for (const name of providers) {
    if (!await models.getAuth(name)) throw new Error(`No credentials for ${name}. Set this provider's API key in your shell before starting the host. Use dispatch serve --demo to try synthetic replies without credentials.`);
  }
  await models.refresh({ providers });
  for (const agent of agents) {
    if (!models.getModel(agent.model.provider, agent.model.id)) throw new Error(`Model ${agent.model.provider}/${agent.model.id} is unavailable for ${agent.id}. Check its name and provider access, or configure a custom provider with --config.`);
  }
  return { ...paths, modelProviders: providers.map(name => ({
    module: "@dispatch/runner/environment-provider", export: "environmentProvider", args: [name],
  })) };
}
