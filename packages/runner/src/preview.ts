import { createHash, randomUUID } from "node:crypto";
import { realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { agentName, catalog, loadAgent, loadPreviewAgent } from "./definition.js";
import { configuredClientConnection, localHostPaths, readHostConfig, readProjectHostConfig } from "./host-config.js";
import { hostModels } from "./host-models.js";
import { createRunner } from "./index.js";
import { privateStateDirectory } from "./private-state.js";
import { run } from "./run.js";
import { serveService, type ServiceConfig } from "./service.js";
import { serviceSettings } from "./settings.js";
import { Users } from "./users.js";
import { reportError, terminalText } from "./terminal-output.js";

type Installation = { id: string; label: string; service: { socket: string; expectedStateRoot: string; label: string } };

async function webClient(root: string) {
  let entry: string;
  try { entry = createRequire(join(root, "package.json")).resolve("@dispatch/web/preview.js"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    return undefined;
  }
  return (await import(pathToFileURL(entry).href)).previewWeb as (options: {
    installations: Installation[]; port: number; username: string; signal: AbortSignal;
  }) => Promise<void>;
}

// Roster IDs are arbitrary text. Keep ordinary IDs readable in saved paths and Web links.
function personKey(id: string) {
  return /^[a-z0-9][a-z0-9_-]*$/.test(id) ? id : "_" + createHash("sha256").update(id).digest("hex");
}

export function previewClientFile(root: string, agent: string, person = "local") {
  if (!agentName.test(agent)) throw new Error(`Invalid agent name: ${agent}`);
  return join(root, ".demo", ".clients", agent, personKey(person) + ".json");
}

export async function previewCommand(id: string, options: { root?: string; config?: string; port?: string; noWeb?: boolean }) {
  const port = Number(options.port ?? process.env.DISPATCH_PORT ?? 4330);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The Web port must be an integer from 1 to 65535.");
  const config: ServiceConfig = options.config ? await readHostConfig(options.config)
    : await readProjectHostConfig(options) ?? await localHostPaths(options);
  process.chdir(config.cwd);
  const previewWeb = options.noWeb ? undefined : await webClient(config.root);
  const names = config.names?.length ? config.names : (await catalog(config.root)).filter(item => item.runnable).map(item => item.id);
  if (!names.includes(id)) throw new Error(`Agent ${id} is not served by this host.`);
  const { agent, fixtures, history, includeSelf } = await loadPreviewAgent(config.root, id);
  const agents = [agent];
  for (const sender of agents) for (const target of sender.messages ?? []) {
    if (!names.includes(target)) throw new Error(`${sender.id} messages ${target}; include both agents in this service's names.`);
    if (!agents.some(peer => peer.id === target)) agents.push(await loadAgent(config.root, target));
  }
  const owner = userInfo().username;
  const roster = config.usersFile ? await Users.load(config.usersFile, names) : undefined;
  const operator = roster?.find({ channel: "local", handle: owner }, id);
  const people = roster ? roster.forAgent(id).filter(person => includeSelf || person.id !== operator?.id)
    .sort((a, b) => a.id.localeCompare(b.id)) : [{ id: "local", name: owner, agents: agents.map(peer => peer.id) }];
  if (!people.length) throw new Error(`No enrolled users match this preview for ${id}.`);

  const base = join(await realpath(config.root), ".demo");
  const histories = fixtures ? base : join(base, ".live");
  const directory = join(histories, history);
  const live = await realpath(config.stateRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return resolve(config.stateRoot);
  });
  if (directory === live || directory.startsWith(live + sep) || live.startsWith(directory + sep))
    throw new Error("Preview history overlaps the configured host state. Choose a separate preview history.");
  await privateStateDirectory(base);
  if (!fixtures) await privateStateDirectory(histories);
  await privateStateDirectory(directory);
  const clients = dirname(previewClientFile(config.root, id));
  await privateStateDirectory(dirname(clients));
  await privateStateDirectory(clients);

  const provider = hostModels(config.gateway || config.modelProviders ? config : {
    modelProviders: [...new Set(agents.map(peer => peer.model.provider))].map(provider => ({ provider })),
  }, config.cwd);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const runner = createRunner({ namespace: config.namespace });
  const hosts: Awaited<ReturnType<typeof run>>[] = [];
  const listeners: Awaited<ReturnType<typeof serveService>>[] = [];
  const endpoint = configuredClientConnection(config);
  const source = endpoint?.socket ?? endpoint?.url;
  try {
    const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
    await provider.connect(models, controller.signal);
    const settings = serviceSettings(config, models);
    const installations: Installation[] = [];
    for (const person of people) {
      controller.signal.throwIfAborted();
      const key = personKey(person.id);
      const { stateRoot, socket } = await localHostPaths({ root: config.root, state: join(directory, key) });
      const users = Users.preview(person, id, [{ channel: "local", handle: owner },
        { channel: "web", scope: `http://127.0.0.1:${port}`, handle: owner }]);
      const host = await run({ root: config.root, cwd: fixtures ? directory : config.cwd, stateRoot, agents,
        runner, users, models, settings, demo: config.demo, definitionResources: config.definitionResources,
        mcpServers: fixtures ? undefined : config.mcpServers, environmentStateRoot: config.stateRoot,
        mcpStdioEnv: !fixtures && source ? { DISPATCH_MCP_PREVIEW: JSON.stringify({ source, socket }) } : undefined,
        schedules: false, updateDefinitions: config.updateDefinitions ?? "when-idle",
        beforeStart: async service => { listeners.push(await serveService(service, socket, [], { stateRoot, defaultAgent: id, usersConfigured: true })); } });
      hosts.push(host);
      const label = `Preview as ${person.name}`;
      const chat = await host.service.create(id, previewWeb ? "web" : "cli", history, label);
      installations.push({ id: fixtures ? `preview-${key}` : `live-${id}-${key}`, label, service: { socket, expectedStateRoot: stateRoot, label } });
      const file = previewClientFile(config.root, id, person.id);
      const temporary = file + "." + randomUUID();
      try {
        await writeFile(temporary, JSON.stringify({ root: config.root, stateRoot, socket, conversation: chat.id }) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      const as = /^[A-Za-z0-9_-]+$/.test(person.id) ? person.id : "'" + person.id.replaceAll("'", "'\\''") + "'";
      console.log(terminalText(`${label}: npx dispatch chat --preview ${id} --as ${as}\n  Client config: ${relative(config.root, file)}`));
    }
    controller.signal.throwIfAborted();
    if (previewWeb) {
      try { await previewWeb({ installations, port, username: owner, signal: controller.signal }); }
      catch (error) { if (!controller.signal.aborted) reportError("Preview Web stopped:", error); }
    } else if (!options.noWeb) console.log("Install the matching @dispatch/web package to also open the browser client.");
    if (!controller.signal.aborted) {
      console.log("Preview host ready. Connect from the application directory. Press Ctrl-C to stop.");
      await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    try { await Promise.all(listeners.map(listener => listener.close())); }
    finally {
      try { await Promise.all(hosts.map(host => host.close())); }
      finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await provider.close();
      }
    }
  }
}
