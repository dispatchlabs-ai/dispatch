import { isReminder } from "./reminders.js";
import { isMonitor } from "./monitors.js";
import type { PrivateReviewHost } from "./private-review.js";
import { Users } from "./users.js";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Models } from "@earendil-works/pi-ai/models";
import type { StorageFactory, OpenOptions } from "./runtime.js";
import type { Extension } from "@earendil-works/pi-durable";
import { createRunner, type Runner } from "./index.js";
import type { ChatService, ChatInitializer } from "./chat.js";
import type { ReplySink } from "./replies.js";
import { reportError } from "./terminal-output.js";
import type { ArtifactOptions, ArtifactSink } from "./artifacts.js";
import { localClient } from "./client.js";
import { catalog, defaultAgent, loadAgent, type LoadedAgent } from "./definition.js";
import { connectMcpServers, type McpServers } from "./mcp.js";
import { environmentConnections } from "./environments.js";

export type PreparedAdapter = {
  extension: Extension;
  /** Required for explicit multi-transport reply routing. */
  transport?: string;
  queueReply: ReplySink;
  queueArtifact?: ArtifactSink;
  start(service: ChatService): Promise<void>;
  close(): Promise<void>;
  busy?(): Promise<boolean>;
};
export type Adapter = { prepare(options: { root: string; runner: Runner }): Promise<PreparedAdapter> };
export type RunOptions = {
  reviewActions?: OpenOptions["reviewActions"];
  usersFile?: string;
  users?: Users;
  storage?: StorageFactory;
  /** Native host policy, including model retry; not part of agent definitions. */
  settings?: OpenOptions["settings"];
  root?: string;
  stateRoot?: string;
  /** Explicit local working directory for native tools and repository instructions. */
  cwd?: string;
  env?: OpenOptions["env"];
  definitionResources?: OpenOptions["definitionResources"];
  runner?: Runner;
  models?: Models;
  names?: string[];
  agents?: LoadedAgent[];
  /** Installed environment bindings can be shared with a host using a separate conversation store. */
  environmentStateRoot?: string;
  mcpStdioEnv?: Record<string, string>;
  demo?: boolean;
  updateDefinitions?: boolean | "when-idle";
  /** Skip automatic recovery/schedules when inspecting saved conversations. */
  resume?: boolean;
  initialize?: ChatInitializer;
  adapters?: Adapter[];
  /** MCP connections are owned by this host; agents select them by name. */
  mcpServers?: McpServers;
  replySink?: ReplySink;
  schedules?: boolean;
  /** Preview hosts can review real reminders but cannot start timers or deliver them. */
  preview?: boolean;
  artifacts?: ArtifactOptions;
  /** Attach domain workflows to the same host before adapters begin receiving. */
  open?: (options: { extensions: Extension[]; replySink?: ReplySink; settings?: OpenOptions["settings"]; artifacts?: ArtifactOptions;
    prepareAgent: (agent: LoadedAgent) => LoadedAgent }) => Promise<ChatService>;
  beforeStart?: (service: ChatService) => Promise<void>;
};

/** Start a headless service. The caller owns process signals and calls close(). */
export async function run(options: RunOptions = {}) {
  const root = resolve(options.root ?? process.cwd());
  const runner = options.runner ?? createRunner();
  const adapters: PreparedAdapter[] = [];
  let service: ChatService | undefined;
  let mcp: Awaited<ReturnType<typeof connectMcpServers>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const results = await Promise.allSettled(adapters.map(adapter => adapter.close()));
    try { try { await service?.close(); } finally { await mcp?.close(); } }
    finally {
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
  })();
  try {
    const names = options.agents?.map(agent => agent.id) ?? (options.names?.length ? options.names
      : (await catalog(root)).filter(agent => agent.runnable).map(agent => agent.id));
    const users = options.users ?? (options.usersFile === undefined ? undefined : await Users.load(resolve(root, options.usersFile), names));
    const requested = new Set<string>();
    const privateNames = new Set<string>();
    const reviewNames = new Set<string>();
    const definitions: LoadedAgent[] = [];
    const collect = (agent: LoadedAgent) => {
      definitions.push(agent);
      for (const name of agent.mcp ?? []) requested.add(name);
      for (const extension of agent.extensions ?? []) if (isReminder(extension)) {
        privateNames.add(extension.reminderConnections.source);
        if (!options.preview) privateNames.add(extension.reminderConnections.destination);
      }
      for (const extension of agent.extensions ?? []) if (isMonitor(extension)) {
        for (const name of extension.monitorConnections.review) { privateNames.add(name); reviewNames.add(name); }
        if (!options.preview) privateNames.add(extension.monitorConnections.destination);
      }
      for (const child of agent.delegateAgents ?? []) collect(child);
      if (agent.handoffAgent) collect(agent.handoffAgent);
    };
    const agents = options.agents ?? await Promise.all(names.map(name => loadAgent(root, name)));
    for (const agent of agents) collect(agent);
    const environments = await environmentConnections(definitions, resolve(options.environmentStateRoot ?? options.stateRoot ?? resolve(root, ".state")));
    for (const name of Object.keys(environments.servers)) {
      if (options.mcpServers?.[name]) throw new Error(`MCP name ${name} is reserved for the selected environment.`);
      requested.add(name);
    }
    if (requested.size || privateNames.size || options.mcpServers !== undefined) mcp = await connectMcpServers({ ...options.mcpServers, ...environments.servers },
      { cwd: options.cwd ?? root, names: [...requested], privateNames: [...privateNames], reviewNames: [...reviewNames], argumentsByServer: environments.argumentsByServer, stdioEnv: options.mcpStdioEnv });
    const prepareAgent = (agent: LoadedAgent): LoadedAgent => {
      const environment = environments.selected.get(agent.id);
      const connections = [...(agent.mcp ?? []), ...(environment?.server ? [environment.server] : [])];
      const stateRoot = options.stateRoot ?? (!options.open ? resolve(root, ".state") : undefined);
      const bound = stateRoot ? mcp?.bind({ agent: agent.id, stateRoot: resolve(stateRoot) }) : mcp?.extensions;
      const privateHost: PrivateReviewHost = {
        namespace: runner.namespace, agent: agent.id, preview: options.preview === true,
        enrolled: owner => users?.forAgent(agent.id).some(person => person.id === owner) === true,
        profile: async owner => {
          const person = users?.forAgent(agent.id).find(person => person.id === owner);
          return person?.contextFile ? readFile(person.contextFile, "utf8") : undefined;
        },
        call: name => mcp!.reminderCall(name),
        tools: selection => Object.keys(selection).length ? mcp!.privateTools(selection) : [],
      };
      return { ...agent, ...(environment ? {
        instructions: agent.instructions + "\n\n" + environment.instructions,
        fingerprint: createHash("sha256").update(agent.fingerprint).update(environment.identity).digest("hex"),
      } : {}),
        ...(agent.delegateAgents ? { delegateAgents: agent.delegateAgents.map(prepareAgent) } : {}),
        ...(agent.handoffAgent ? { handoffAgent: prepareAgent(agent.handoffAgent) } : {}),
        extensions: [...(agent.extensions ?? []).map(extension => isReminder(extension) ? extension.bindReminder(privateHost)
          : isMonitor(extension) ? extension.bindMonitor(privateHost) : extension), ...connections.map(name => {
          const extension = bound?.[name];
          if (!extension) throw new Error(`Agent ${agent.id} requires MCP server ${name}; configure it in mcpServers.`);
          return extension;
        })] };
    };
    for (const adapter of options.adapters ?? []) adapters.push(await adapter.prepare({ root, runner }));
    const extensions = adapters.map(adapter => adapter.extension);
    if (users) extensions.push(users.extension(runner.namespace));
    // Never broadcast a reply or guess between transports. Legacy destinations
    // without a transport remain supported with exactly one adapter.
    const replySink: ReplySink = options.replySink ?? (async (...args) => {
      const destination = args[2];
      const targets = destination.transport
        ? adapters.filter(adapter => adapter.transport === destination.transport)
        : adapters.length === 1 ? adapters : [];
      if (targets.length !== 1) throw new Error("Reply destination needs exactly one configured transport.");
      await targets[0].queueReply(...args);
    });
    const artifacts: ArtifactOptions = { ...options.artifacts, sink: options.artifacts?.sink ?? (async (tx, id, artifact) =>
      (await Promise.all(adapters.map(adapter => adapter.queueArtifact?.(tx, id, artifact) ?? []))).flat()) };
    if (options.open) service = await options.open({ extensions, replySink, settings: options.settings, artifacts, prepareAgent });
    else {
      if (!options.models) throw new Error("Supply a Pi Models catalog or an open callback.");
      service = await runner.ChatService.open({
        root, stateRoot: resolve(options.stateRoot ?? resolve(root, ".state")),
        models: options.models, demo: options.demo ?? false, agents: agents.map(prepareAgent),
        updateDefinitions: options.updateDefinitions, initialize: options.initialize,
        resume: options.resume, schedules: options.schedules,
        deferResume: true,
        cwd: options.cwd, env: options.env, storage: options.storage, settings: options.settings,
        definitionResources: options.definitionResources, reviewActions: options.preview || options.demo ? undefined : options.reviewActions,
        extensions, replySink, artifacts,
      });
    }
    service.users = users;
    await options.beforeStart?.(service);
    for (const adapter of adapters) await adapter.start(service);
    if (options.resume !== false) await service.start();
    const stateRoot = options.stateRoot ?? (!options.open ? resolve(root, ".state") : undefined);
    const preferredAgent = options.agents?.[0]?.id ?? await defaultAgent(root).catch(() => undefined);
    const client = localClient(service, {
      ...(users ? { usersConfigured: true } : {}),
      ...(stateRoot ? { stateRoot: await realpath(stateRoot) } : {}),
      defaultAgent: preferredAgent ?? (service.agents.length === 1 ? service.agents[0].id : undefined),
    },
      async () => (await Promise.all(adapters.map(adapter => adapter.busy?.() ?? false))).some(Boolean));
    return { runner, service, client, adapters, close: async () => { try { await client.close(); } finally { await close(); } } };
  } catch (error) {
    await close().catch(closeError => reportError("Runner cleanup failed:", closeError));
    throw error;
  }
}
