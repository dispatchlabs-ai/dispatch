import { runtimeSummary } from "./summary.js";
import type { Agent, Chat, Snapshot, AttachmentFile } from "./contracts.js";
import { readConfig, AdmissionError, type Config } from "./config.js";
import { openServiceRuntime } from "./service-runtime.js";
import { openSharedHistory } from "./shared-history.js";
import type * as runner from "@dispatch/runner";

interface NativeService {
  has(id: string): Promise<boolean>;
  sources(): Promise<import("./contracts.js").SourceStatus[]>;
  list(): Promise<Chat[]>;
  artifact(id: string, artifactId: string): Promise<{ artifact: NonNullable<import("./contracts.js").ChatMessage["artifacts"]>[number]; bytes: Uint8Array }>;
  create(
    agent: string,
    source: runner.Chat["source"],
    key: string,
    sourceId?: string,
  ): Promise<Chat>;
  resolve(id: string): Promise<unknown>;
  submit(
    id: string,
    text: string,
    requestId: string,
    mode: "steer",
    source: runner.Chat["source"],
    files?: AttachmentFile[],
  ): Promise<{ submissionId: number }>;
  snapshot(id: string): Promise<Snapshot>;
  stop(id: string): Promise<void>;
  close(): Promise<void>;
}
export interface Runtime {
  stateRoot: string;
  summary?(): Promise<import("./contracts.js").SidebarSnapshot>;
  /** Refresh a connected owner's current catalog without creating a writer. */
  catalog?(): Promise<Agent[]>;
  /** Open only explicitly opted-in native keyed conversations, without submitting input. */
  openKeyedChat?(key: string, title: string, installation?: string): Promise<Chat>;
  /** Resolve an exact native ID within a named installation, without creating work. */
  resolveChat?(nativeId: string, installation?: string): Promise<Chat>;
  service: Omit<NativeService, "resolve" | "snapshot" | "close"> & { agents: Agent[] };
  presentation: {
    snapshot(id: string): Promise<Snapshot>;
    watch(id: string, listener: (value: Snapshot) => Promise<void>): Promise<{ closed: Promise<void>; stop(): Promise<void> }>;
  };
  close(): Promise<void>;
}
export async function openRuntime(options?: Config): Promise<Runtime> {
  const config = options ?? await readConfig();
  if (config.service) return openServiceRuntime(config.service);

  const contexts = new Map<string, Runtime>();
  try {
    for (const binding of config.installations ?? []) {
      const sources = (config.sources ?? []).filter(source => source.installation === binding.id);
      const runtime = binding.service.stateRoot && sources.length
        ? await openSharedHistory({ ...binding.service, stateRoot: binding.service.stateRoot, sourceId: binding.service.sourceId ?? binding.id }, sources)
        : await openServiceRuntime(binding.service);
      contexts.set(binding.id, runtime);
    }
  } catch (error) { await Promise.allSettled([...contexts.values()].map(runtime => runtime.close())); throw error; }
  const qualify = (name: string, id: string) => `${name}~${id}`;
  const context = (id: string) => {
    const at = id.indexOf("~"), name = at > 0 ? id.slice(0, at) : undefined, local = id.slice(at + 1);
    const runtime = name && contexts.get(name);
    if (!runtime || !local || local.includes("~")) throw new AdmissionError("Unknown installation-qualified identity.");
    return { name: name!, local, runtime };
  };
  const chatId = qualify;
  const project = (name: string, chat: Chat): Chat => ({ ...chat, id: chatId(name, chat.id), agent: qualify(name, chat.agent),
    ...(chat.parentId ? { parentId: chatId(name, chat.parentId) } : {}) });
  const catalog = async () => (await Promise.all([...contexts].map(async ([name, runtime]) =>
    (await (runtime.catalog?.() ?? Promise.resolve(runtime.service.agents))).map(agent => ({ ...agent, id: qualify(name, agent.id),
      description: `${config.installations!.find(binding => binding.id === name)!.label}: ${agent.description}` }))))).flat();
  return {
    stateRoot: [...contexts.values()].map(runtime => runtime.stateRoot).join(", "),
    summary: async () => {
      const values = await Promise.all([...contexts].map(async ([name, runtime]) => {
        const value = await runtimeSummary(runtime);
        return { ...value, agents: value.agents.map(agent => ({ ...agent, id: qualify(name, agent.id), description: `${config.installations!.find(binding => binding.id === name)!.label}: ${agent.description}` })), chats: value.chats.map(chat => project(name, chat)) };
      }));
      return { agents: values.flatMap(value => value.agents), chats: values.flatMap(value => value.chats), sources: values.flatMap(value => value.sources) };
    },
    catalog,
    openKeyedChat: async (key, title, installation) => {
      const runtime = installation && contexts.get(installation);
      if (!runtime) throw new AdmissionError("Unknown linked installation.");
      if (!runtime.openKeyedChat) throw new AdmissionError("This installation does not allow keyed conversation links.");
      return project(installation!, await runtime.openKeyedChat(key, title));
    },
    resolveChat: async (id, installation) => {
      const runtime = installation && contexts.get(installation);
      if (!runtime) throw new AdmissionError("Unknown linked installation.");
      if (!runtime.resolveChat) throw new AdmissionError("This installation does not support native conversation links.");
      return project(installation!, await runtime.resolveChat(id));
    },
    service: {
      agents: [...contexts].flatMap(([name, runtime]) => runtime.service.agents.map(agent => ({ ...agent, id: qualify(name, agent.id),
        description: `${config.installations!.find(binding => binding.id === name)!.label}: ${agent.description}` }))),
      sources: async () => (await Promise.all([...contexts.values()].map(runtime => runtime.service.sources()))).flat(),
      list: async () => (await Promise.all([...contexts].map(async ([name, runtime]) => (await runtime.service.list()).map(chat => project(name, chat))))).flat()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      has: async (id: string) => {
        try { const { local, runtime } = context(id); return runtime.service.has(local); }
        catch (error) { if (error instanceof AdmissionError) return false; throw error; }
      },
      create: async (id, source, key, sourceId) => {
        const { name, local, runtime } = context(id);
        const binding = config.installations!.find(binding => binding.id === name)!;
        const target = sourceId ?? binding.service.sourceId;
        return project(name, await runtime.service.create(local, source, key, target));
      },
      submit: (id, text, requestId, _mode, source, files) => { const { local, runtime } = context(id); return runtime.service.submit(local, text, requestId, "steer", source, files); },
      stop: id => { const { local, runtime } = context(id); return runtime.service.stop(local); },
      artifact: (id, artifactId) => { const { local, runtime } = context(id); return runtime.service.artifact(local, artifactId); },
    },
    presentation: {
      snapshot: async id => { const { name, local, runtime } = context(id); const value = await runtime.presentation.snapshot(local); return { ...value, chat: project(name, value.chat) }; },
      watch: async (id, listener) => { const { name, local, runtime } = context(id); return runtime.presentation.watch(local, async value => listener({ ...value, chat: project(name, value.chat) })); },
    },
    close: async () => { await Promise.all([...contexts.values()].map(runtime => runtime.close())); },
  };
}

export { openServiceRuntime } from "./service-runtime.js";
export type { ServiceConnection } from "./service-runtime.js";
