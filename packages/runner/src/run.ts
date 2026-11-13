import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
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
    if (options.mcpServers !== undefined) {
      const names = options.names?.length ? options.names : (await catalog(root)).filter(agent => agent.runnable).map(agent => agent.id);
      const requested = new Set<string>();
      const collect = (agent: LoadedAgent) => {
        for (const name of agent.mcp ?? []) requested.add(name);
        for (const child of agent.delegateAgents ?? []) collect(child);
        if (agent.handoffAgent) collect(agent.handoffAgent);
      };
      for (const name of names) collect(await loadAgent(root, name));
      mcp = await connectMcpServers(options.mcpServers, { cwd: options.cwd ?? root, names: [...requested] });
    }
    const prepareAgent = (agent: LoadedAgent): LoadedAgent => !agent.mcp?.length ? agent : ({ ...agent,
      extensions: [...(agent.extensions ?? []), ...(agent.mcp ?? []).map(name => {
        const extension = mcp?.extensions[name];
        if (!extension) throw new Error(`Agent ${agent.id} requires MCP server ${name}; configure it in mcpServers.`);
        return extension;
      })],
    });
    for (const adapter of options.adapters ?? []) adapters.push(await adapter.prepare({ root, runner }));
    const extensions = adapters.map(adapter => adapter.extension);
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
        models: options.models, demo: options.demo ?? false, names: options.names,
        prepareAgent,
        updateDefinitions: options.updateDefinitions, initialize: options.initialize,
        resume: options.resume, schedules: options.schedules,
        deferResume: true,
        cwd: options.cwd, env: options.env, storage: options.storage, settings: options.settings,
        definitionResources: options.definitionResources,
        extensions, replySink, artifacts,
      });
    }
    await options.beforeStart?.(service);
    for (const adapter of adapters) await adapter.start(service);
    if (options.resume !== false) await service.start();
    const stateRoot = options.stateRoot ?? (!options.open ? resolve(root, ".state") : undefined);
    const preferredAgent = await defaultAgent(root).catch(() => undefined);
    const client = localClient(service, {
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
