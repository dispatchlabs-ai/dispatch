import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { catalog, loadPreviewAgent } from "./definition.js";
import { localHostPaths, readHostConfig, readProjectHostConfig } from "./host-config.js";
import { hostModels } from "./host-models.js";
import { createRunner } from "./index.js";
import { privateStateDirectory } from "./private-state.js";
import { serveService, type ServiceConfig } from "./service.js";
import { serviceSettings } from "./settings.js";
import { Users } from "./users.js";

type Installation = { id: string; label: string; service: { socket: string; expectedStateRoot: string; label: string } };

async function webClient(root: string) {
  let entry: string;
  try { entry = createRequire(join(root, "package.json")).resolve("@dispatch/web/preview.js"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    throw new Error("Preview needs the matching @dispatch/web package installed in this application.");
  }
  return (await import(pathToFileURL(entry).href)).previewWeb as (options: {
    installations: Installation[]; port: number; username: string; signal: AbortSignal;
  }) => Promise<void>;
}

// Roster IDs are arbitrary text. Keep ordinary IDs readable in saved paths and Web links.
function personKey(id: string) {
  return /^[a-z0-9][a-z0-9_-]*$/.test(id) ? id : "_" + createHash("sha256").update(id).digest("hex");
}

export async function previewCommand(id: string, options: { root?: string; config?: string; port?: string }) {
  const port = Number(options.port ?? process.env.DISPATCH_PORT ?? 4330);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The Web port must be an integer from 1 to 65535.");
  const config: ServiceConfig = options.config ? await readHostConfig(options.config)
    : await readProjectHostConfig(options) ?? await localHostPaths(options);
  const previewWeb = await webClient(config.root);
  const { agent, history, includeSelf } = await loadPreviewAgent(config.root, id);
  const owner = userInfo().username;
  const roster = config.usersFile ? await Users.load(config.usersFile, (await catalog(config.root)).filter(item => item.runnable).map(item => item.id)) : undefined;
  const operator = roster?.find({ channel: "local", handle: owner }, id);
  const people = roster ? roster.forAgent(id).filter(person => includeSelf || person.id !== operator?.id)
    .sort((a, b) => a.id.localeCompare(b.id)) : [{ id: "local", name: owner }];
  if (!people.length) throw new Error(`No enrolled users match this preview for ${id}.`);

  const base = join(await realpath(config.root), ".demo");
  const directory = join(base, history);
  const live = await realpath(config.stateRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return resolve(config.stateRoot);
  });
  if (directory === live || directory.startsWith(live + sep) || live.startsWith(directory + sep))
    throw new Error("Preview history overlaps the configured host state. Choose a separate preview history.");
  await privateStateDirectory(base);
  await privateStateDirectory(directory);

  const provider = hostModels(config.gateway || config.modelProviders ? config : {
    modelProviders: [{ provider: agent.model.provider }],
  }, config.cwd);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const runner = createRunner({ namespace: config.namespace });
  const services: Awaited<ReturnType<typeof runner.ChatService.open>>[] = [];
  const listeners: Awaited<ReturnType<typeof serveService>>[] = [];
  try {
    const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
    await provider.connect(models, controller.signal);
    const settings = serviceSettings(config, models);
    const installations: Installation[] = [];
    for (const person of people) {
      controller.signal.throwIfAborted();
      const key = personKey(person.id);
      const { stateRoot, socket } = await localHostPaths({ root: config.root, state: join(directory, key) });
      const users = Users.preview(person, id, { channel: "web", scope: `http://127.0.0.1:${port}`, handle: owner });
      const service = await runner.ChatService.open({ root: config.root, cwd: directory, stateRoot, agents: [agent],
        extensions: [users.extension(runner.namespace)], models, settings, demo: config.demo ?? false,
        deferResume: true, schedules: false, updateDefinitions: "when-idle" });
      services.push(service);
      service.users = users;
      await service.start();
      const label = `Preview as ${person.name}`;
      await service.create(id, "web", history, label);
      listeners.push(await serveService(service, socket, [], { stateRoot, defaultAgent: id, usersConfigured: true }));
      installations.push({ id: `preview-${key}`, label, service: { socket, expectedStateRoot: stateRoot, label } });
    }
    controller.signal.throwIfAborted();
    await previewWeb({ installations, port, username: owner, signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    try { await Promise.all(listeners.map(listener => listener.close())); }
    finally {
      try { await Promise.all(services.map(service => service.close())); }
      finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await provider.close();
      }
    }
  }
}
