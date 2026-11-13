import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { catalog, loadAgent } from "./definition.js";
import { environmentProvider } from "./environment-provider.js";
import type { ServiceConfig } from "./service.js";

function hostPaths(root: string, stateRoot = join(root, ".state")) {
  // Unix socket names are short even when the application lives in a deeply nested checkout.
  const key = createHash("sha256").update(stateRoot).digest("hex").slice(0, 24);
  const socket = join(tmpdir(), `dispatch-${process.getuid?.() ?? "local"}-${key}`, "host.sock");
  return { root, cwd: root, stateRoot, socket };
}

export async function localHostPaths(options: { root?: string; state?: string; socket?: string }) {
  const root = await realpath(resolve(options.root ?? "."));
  const paths = hostPaths(root, resolve(root, options.state ?? ".state"));
  if (options.socket) paths.socket = resolve(options.socket);
  return paths;
}

function settingPath(directory: string, value: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Configured paths must be nonempty strings.");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(directory, value);
}

type FileConfig = ServiceConfig & { url?: string; tokenFile?: string };

/** Resolve CLI file settings before changing directories or connecting a client. */
export async function readHostConfig(filename: string): Promise<FileConfig> {
  const input: Partial<FileConfig> = JSON.parse(await readFile(filename, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Host settings must be a JSON object.");
  const directory = await realpath(dirname(resolve(filename)));
  const root = input.root === undefined ? directory : settingPath(directory, input.root);
  const paths = hostPaths(root, input.stateRoot === undefined ? undefined : settingPath(directory, input.stateRoot));
  const config: FileConfig = { ...input, ...paths };
  if (input.cwd !== undefined) config.cwd = settingPath(directory, input.cwd);
  if (input.socket !== undefined) config.socket = settingPath(directory, input.socket);
  else if (input.http || input.url) delete config.socket;
  if (input.gateway) config.gateway = { ...input.gateway, credentialFile: settingPath(directory, input.gateway.credentialFile) };
  // Relative HTTP tokens keep the working directory of their original reader.
  if (input.http) config.http = { ...input.http, tokenFile: settingPath(config.cwd, input.http.tokenFile) };
  if (input.tokenFile !== undefined) config.tokenFile = settingPath(process.cwd(), input.tokenFile);
  return config;
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
