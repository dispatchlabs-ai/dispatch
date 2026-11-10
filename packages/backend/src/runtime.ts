import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import type { Agent, Chat, Snapshot, AttachmentFile } from "./contracts.js";
import { readConfig, AdmissionError, type LocalConfig } from "./config.js";
import { discoverSessionService } from "@dispatch/runner/service";
import { openServiceRuntime } from "./service-runtime.js";
import { openSharedHistory } from "./shared-history.js";
import * as runner from "@dispatch/runner";
import * as reader from "@dispatch/runner/watch-reader";
import { createStores, identity, readStore, sessionDocument, type Selection } from "./stores.js";

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
async function startOwner(
  path: string,
  namespace: string,
  names: string[],
  config: LocalConfig,
): Promise<NativeService> {
  return connectWorker("./owner.js", { path, namespace, names, config });
}
async function connectWorker(entrypoint: string, workerData: unknown): Promise<NativeService & { agents: Agent[]; catalog(): Promise<Agent[]>; resolveChat(id: string): Promise<Chat> }> {
  const worker = new Worker(new URL(entrypoint, import.meta.url), { workerData });
  let agents: Agent[] = [];
  const calls = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  let sequence = 0;
  let exited = false;
  const ready = new Promise<void>((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.ready) { agents = message.agents ?? []; resolve(); }
      else if (message.failed)
        reject(
          new AdmissionError(
            "Native ownership/compatibility admission failed. Use the original release/host configuration; saved work was not resumed.",
          ),
        );
      else {
        const call = calls.get(message.id);
        calls.delete(message.id);
        if (message.error)
          call?.reject(
            message.status === 409
              ? new AdmissionError(message.error)
              : new Error(message.error),
          );
        else call?.resolve(message.result);
      }
    });
    worker.on("error", () => {
      reject(
        new AdmissionError(
          "Native owner worker failed. Inspect the installed runtime.",
        ),
      );
    });
    worker.on("exit", () => {
      exited = true;
      reject(new AdmissionError("Native owner exited before admission."));
      for (const call of calls.values())
        call.reject(
          new Error(
            "Native owner exited; delivery may be uncertain. Preserve the request ID and retry.",
          ),
        );
      calls.clear();
    });
  });
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  const call = (method: string, args: unknown[]) =>
    new Promise<any>((resolve, reject) => {
      if (exited) {
        reject(
          new Error(
            "Native owner has exited. Restart Web with the same configuration and preserve the request identity.",
          ),
        );
        return;
      }
      const id = ++sequence;
      calls.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });
  return {
    agents,
    catalog: () => call("agents", []),
    resolveChat: id => call("resolveChat", [id]),
    has: (id: string) => call("has", [id]),
    sources: () => call("sources", []),
    list: () => call("list", []),
    artifact: (...args: unknown[]) => call("artifact", args),
    create: (...args) => call("create", args),
    resolve: (...args) => call("resolve", args),
    submit: (id, text, requestId, _mode, source, files) => call("submit", [id, text, requestId, "steer", source, files]),
    snapshot: (...args) => call("snapshot", args),
    stop: (...args) => call("stop", args),
    close: async () => {
      try {
        await call("close", []);
      } finally {
        await worker.terminate();
      }
    },
  };
}
async function openLocalRuntime(config: LocalConfig) {
  const { definitionsRoot, host } = config;
  const stores = createStores(config, reader);
  let configuredServiceRoot: string | undefined;
  if (config.service) {
    const source = config.sources.find(source => source.id === config.service!.sourceId);
    if (!source) throw new Error("service.sourceId must select a configured source.");
    configuredServiceRoot = await realpath(config.service.stateRoot);
    const session = relative(await realpath(source.path), configuredServiceRoot);
    if (session === ".." || session.startsWith("../") || isAbsolute(session))
      throw new Error("service.stateRoot must be a native session directory at or within its configured source.");
  }
  // Catalog loading does not open any native storage or connect a provider.
  const definitions = new Map<string, any>();
  const agents: Agent[] = [];
  for (const entry of await runner.catalog(definitionsRoot))
    if (entry.runnable) {
      const definition = await runner.loadAgent(definitionsRoot, entry.id);
      definitions.set(entry.id, definition);
      agents.push({ id: entry.id, description: definition.description,
        ...(config.defaultSource === config.service?.sourceId ? { capabilities: config.service.capabilities } : {}) });
    }
  const owners = new Map<
    string,
    { service: NativeService; namespace: string }
  >();
  const connections = new Map<string, { endpoint: string; service: NativeService }>();
  async function discovered(path: string) {
    const configured = config.service && configuredServiceRoot === path ? config.service : undefined;
    const endpoint = configured ?? await discoverSessionService(path);
    if (!endpoint) return;
    const key = JSON.stringify(endpoint);
    const previous = connections.get(path);
    if (previous?.endpoint === key) return previous.service;
    const runtime = await openServiceRuntime({ socket: endpoint.socket, expectedStateRoot: endpoint.stateRoot,
      expectedIdentity: "identity" in endpoint ? endpoint.identity : configured?.expectedIdentity, capabilities: configured?.capabilities });
    // The socket exposes the original native IDs. Projection happens only at
    // this Backend boundary; no new host, Harness or writable store is opened.
    const service: NativeService = {
      ...runtime.service,
      resolve: async id => {
        if (!(await runtime.service.list()).some(chat => chat.id === id))
          throw new AdmissionError("This is not an independently addressable chat. Use its native parent.");
      },
      snapshot: runtime.presentation.snapshot,
      close: runtime.close,
    };
    await previous?.service.close();
    connections.set(path, { endpoint: key, service });
    return service;
  }
  const claiming = new Set<string>();
  const opening = new Map<
    string,
    Promise<{ service: NativeService; namespace: string }>
  >();
  async function own(
    path: string,
    namespace: string,
    agent: string,
    create = false,
  ) {
    // A retained endpoint is a routing commitment, including when disconnected.
    // Never fall back to a second writer after an uncertain transport failure.
    const shared = await discovered(path);
    if (shared) return { service: shared, namespace };
    const ownerKey = join(path, agent);
    if (owners.has(ownerKey)) return owners.get(ownerKey)!;
    if (opening.has(ownerKey)) return opening.get(ownerKey)!;
    const operation = (async () => {
      if (!definitions.has(agent))
        throw new AdmissionError(
          `Agent ${agent} is not in this installed release. Use its original release to send; history is still available.`,
        );
      if (host.workspace?.agents?.includes(agent) || host.artifacts)
        throw new AdmissionError(
          "This session requires a workspace/artifact host binding. Use its configured native CLI; history remains available.",
        );
      if (namespace !== (host.namespace ?? "dispatch"))
        throw new AdmissionError(
          `This store uses namespace ${namespace}, not the configured host namespace. Use its original host configuration, or choose a compatible source.`,
        );
      const names = new Set<string>();
      async function include(id: string) {
        if (names.has(id)) return;
        const definition = definitions.get(id);
        if (!definition)
          throw new AdmissionError(
            `Required authored recipient ${id} is unavailable in this release.`,
          );
        names.add(id);
        for (const recipient of definition.messages ?? [])
          await include(recipient);
      }
      await include(agent);
      const overlaps = [...names].filter(
        (id) => owners.has(join(path, id)) || claiming.has(join(path, id)),
      );
      if (overlaps.length)
        throw new AdmissionError(
          `This session's ${overlaps.join(", ")} recipient is already owned by another chat worker. Restart Web to release it, then select the intended primary agent. Viewing stays available.`,
        );
      const claims = [...names].map((id) => join(path, id));
      for (const claim of claims) claiming.add(claim);
      try {
        // A harness resumes all unfinished tasks in its store. Validate the entire
        // message closure before opening any of it, not just the selected chat.
        for (const id of names) {
          if (host.workspace?.agents?.includes(id))
            throw new AdmissionError(
              `${id} requires its native workspace CLI.`,
            );
          const folder = join(path, id),
            file = join(folder, "session.sqlite");
          const exists = await stat(file).then(
            () => true,
            () => false,
          );
          if (!exists) {
            if (create) continue;
            throw new AdmissionError(
              `Required recipient store ${id} is missing. Recover the session in its original CLI; no replacement DB was created.`,
            );
          }
          if (
            await lockfile.check(folder, {
              lockfilePath: join(folder, ".owner.lock"),
            })
          )
            throw new AdmissionError(
              `${id} has a native owner lock. Finish/suspend the original CLI/service, wait for its lock to release, then retry. Do not delete live locks.`,
            );
          const found = await reader.discoverWatchRuns({
            stateRoot: dirname(path),
            session: path.split("/").at(-1)!,
          });
          const store = found.runs
            .flatMap((run) => run.stores)
            .find((store) => store.path === file);
          if (!store || store.namespace !== namespace)
            throw new AdmissionError(
              `Cannot verify ${id}'s native store: ${found.issues.join("; ")}. Use its original runtime.`,
            );
          if (store.pids.length)
            throw new AdmissionError(
              `${id} is owned by native process ${store.pids.join(", ")}. Suspend that owner before retrying.`,
            );
          readStore(file, (db) => {
            const schema = db
              .prepare("SELECT version FROM durable_schema WHERE singleton=1")
              .get();
            if (schema?.version !== 2)
              throw new AdmissionError(
                "This store needs a native schema migration. Use its original CLI deliberately; observation never migrates.",
              );
            const tasks = db
              .prepare("SELECT kind FROM tasks WHERE status<>'terminal'")
              .all();
            if (
              tasks.some(
                (task) =>
                  String(task.kind).includes("agent-loop") ||
                  String(task.kind).includes("schedule"),
              )
            )
              throw new AdmissionError(
                "This session has saved loop/calendar work. Stop or finish it in its original native owner before using web chat. Viewing does not resume it.",
              );
          });
          const saved = sessionDocument(file, `${namespace}.runner`);
          const definition = definitions.get(id);
          const extensions = [
            `${namespace}.schedules`,
            "dispatch.definition-resources",
            ...(definition.messages?.length
              ? [`${namespace}.instance-messages.${id}`]
              : []),
          ];
          // Mirror installed ChatService host adapters; never migrate definitions.
          if (
            saved?.fingerprint !== definition.fingerprint ||
            saved.execution !== "live" ||
            saved.artifactVersion !== 1 ||
            saved.cwd !== (await realpath(host.cwd))
          )
            throw new AdmissionError(
              `${id}'s saved definition, working directory or execution mode differs from the installed host. Restart with its original release/configuration, or explicitly migrate idle work in the native CLI. History remains available.`,
            );
          const missing = (saved.hostExtensions ?? []).filter(
            (name: string) => !extensions.includes(name),
          );
          if (missing.length)
            throw new AdmissionError(
              `${id} requires original host adapters: ${missing.join(", ")}. Use its original CLI/service.`,
            );
        }
        const service = await startOwner(path, namespace, [...names], config);
        const owner = { service, namespace };
        for (const name of names) owners.set(join(path, name), owner);
        return owner;
      } finally {
        for (const claim of claims) claiming.delete(claim);
      }
    })();
    opening.set(ownerKey, operation);
    try {
      return await operation;
    } finally {
      opening.delete(ownerKey);
    }
  }
  const nativeId = (item: Selection) =>
    `${item.chat.agent}:${item.chat.conversationId}`;
  async function admitted(id: string) {
    const item = await stores.get(id);
    const indexed = sessionDocument(
      item.store.path,
      `${item.store.namespace}.chats`,
    );
    if (!indexed?.byId?.[nativeId(item)])
      throw new AdmissionError(
        "This is a native child/workflow conversation. Send or stop through its original parent/CLI; history remains available.",
      );
    const owner = await own(
      item.run.path,
      item.store.namespace,
      item.chat.agent,
    );
    // Only a real native Chats record admits ChatService operations; children
    // remain viewable, but must be directed through their owning parent.
    try {
      await owner.service.resolve(nativeId(item));
    } catch {
      throw new AdmissionError(
        "This is a native child/workflow conversation, not an independently addressable chat. Send or stop through its original parent/CLI; history remains available.",
      );
    }
    return { item, owner };
  }
  const projectChat = (item: Selection): Chat => ({ ...item.chat,
    ...(item.run.path === configuredServiceRoot ? { capabilities: config.service?.capabilities } : {}) });
  const requireCapability = (path: string, key: keyof import("./contracts.js").Capabilities) => {
    if (path === configuredServiceRoot && config.service?.capabilities?.[key] === false)
      throw new AdmissionError(`This installation does not support ${key}.`);
  };
  const savedSnapshot = async (id: string): Promise<Snapshot> => {
    const item = await stores.get(id);
    return { ...await stores.snapshot(id), chat: projectChat(item) };
  };
  const service = {
    agents,
    sources: stores.statuses,
    list: async () => Promise.all((await stores.list()).map(async chat => projectChat(await stores.get(chat.id)))),
    has: stores.has,
    async create(
      agent: string,
      _source: runner.Chat["source"],
      key: string,
      sourceId = config.defaultSource,
    ): Promise<Chat> {
      const source = config.sources.find((value) => value.id === sourceId);
      if (!source)
        throw new AdmissionError("Choose a configured source for creation.");
      let root;
      try {
        root = await realpath(source.path);
        if (!(await stat(root)).isDirectory()) throw new Error();
      } catch {
        throw new AdmissionError(
          "Creation source is unavailable. Fix its configured directory and restart; no DB was created.",
        );
      }
      const session = sourceId === config.service?.sourceId && configuredServiceRoot
        ? relative(root, configuredServiceRoot)
        : `web-${createHash("sha256").update(`${agent}\0${key}`).digest("hex")}`;
      const path = join(root, session);
      requireCapability(path, "create");
      const owner = await own(path, host.namespace ?? "dispatch", agent, true);
      const chat = await owner.service.create(agent, _source, key);
      stores.invalidate();
      return {
        ...chat,
        id: identity(join(path, agent, "session.sqlite"), chat.conversationId),
        source: source.id,
        sourceLabel: source.label,
        session: session || ".",
        ...(path === configuredServiceRoot ? { capabilities: config.service?.capabilities } : {}),
      };
    },
    async submit(
      id: string,
      text: string,
      requestId: string,
      _mode: "steer",
      source: runner.Chat["source"],
      files: AttachmentFile[] = [],
    ) {
      runner.prepareContent(text, files);
      if (files.length) requireCapability((await stores.get(id)).run.path, "attachments");
      const { item, owner } = await admitted(id);
      // Resume only on explicit admission, never on observation/startup/restart.
      return owner.service.submit(
        nativeId(item),
        text,
        requestId,
        "steer",
        source,
        files,
      );
    },
    async stop(id: string) {
      const { item, owner } = await admitted(id);
      await owner.service.stop(nativeId(item));
    },
    async artifact(id: string, artifactId: string) {
      const item = await stores.get(id);
      requireCapability(item.run.path, "artifacts");
      const snapshot = await stores.snapshot(id);
      const artifact = snapshot.messages
        .flatMap((message) => message.artifacts ?? [])
        .find((value) => value.id === artifactId);
      if (!artifact) throw new Error("Unknown artifact.");
      const store = new runner.ArtifactStore(
        join(dirname(item.store.path), "artifacts"),
      );
      return {
        artifact,
        bytes: await store.read(item.chat.conversationId, artifact),
      };
    },
  };
  async function snapshot(id: string) {
    const item = await stores.get(id);
    let shared: NativeService | undefined;
    try { shared = await discovered(item.run.path); }
    catch {
      return { ...await savedSnapshot(id), readOnlyReason: "Native service unavailable. Reconnect its original launcher; no work was resent or resumed." };
    }
    const owner = shared ? { service: shared } : owners.get(join(item.run.path, item.chat.agent));
    if (owner) {
      try {
        const snapshot = await owner.service.snapshot(nativeId(item));
        return {
          ...snapshot,
          chat: { ...projectChat(item), title: snapshot.chat.title },
        };
      } catch {
        // A disconnected native chat stays observational; never create a writer.
        if (shared && sessionDocument(item.store.path, `${item.store.namespace}.chats`)?.byId?.[nativeId(item)])
          return { ...await savedSnapshot(id), readOnlyReason: "Native service unavailable. Reconnect its original launcher; no work was resent or resumed." };
        /* Non-index children still use the native read-only reader. */
      }
    }
    return savedSnapshot(id);
  }
  const presentation = {
    snapshot,
    async watch(id: string, listener: (value: Snapshot) => Promise<void>) {
      // Poll native committed history for external owners; never attach an owning
      // harness merely to observe. Owned live partials come from native snapshot.
      let stopped = false,
        timer: ReturnType<typeof setTimeout>;
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const tick = async () => {
        try {
          if (!stopped) await listener(await snapshot(id));
        } catch {
          stopped = true;
          finish();
        }
        if (!stopped)
          timer = setTimeout(() => {
            void tick();
          }, 1000);
      };
      await listener(await snapshot(id));
      timer = setTimeout(() => {
        void tick();
      }, 1000);
      return {
        closed,
        stop: async () => {
          stopped = true;
          clearTimeout(timer);
          finish();
        },
      };
    },
  };
  return {
    openKeyedChat: config.service ? async (key: string, title: string, installation?: string) => {
      if (installation !== undefined) throw new AdmissionError("Keyed conversation links require a named installation binding.");
      const runtime = await openServiceRuntime({ ...config.service!, expectedStateRoot: configuredServiceRoot });
      try {
        const chat = await runtime.openKeyedChat!(key, title);
        stores.invalidate();
        const source = config.sources.find(source => source.id === config.service!.sourceId)!;
        return { ...chat, id: identity(join(configuredServiceRoot!, chat.agent, "session.sqlite"), chat.conversationId),
          source: source.id, sourceLabel: source.label, session: relative(await realpath(source.path), configuredServiceRoot!) || "." };
      } finally { await runtime.close(); }
    } : undefined,
    resolveChat: async (id: string, installation?: string) => {
      if (installation !== undefined) throw new AdmissionError("Native conversation links require a named installation binding.");
      const matches = (await stores.list()).filter(chat => `${chat.agent}:${chat.conversationId}` === id);
      if (matches.length !== 1) throw new AdmissionError("Linked conversation is unavailable or ambiguous in this installation.");
      return projectChat(await stores.get(matches[0].id));
    },
    service,
    presentation,
    stateRoot: config.sources.map((source) => source.path).join(", "),
    close: async () => {
      await Promise.allSettled([...opening.values()]);
      await Promise.all(
        [...new Set([...owners.values(), ...connections.values()])].map((owner) => owner.service.close()),
      );
    },
  };
}

async function openAdapter(config: { sources: LocalConfig["sources"]; defaultSource: string; module: string; configFile: string; export?: string; options?: Record<string, unknown> }): Promise<Runtime> {
  const service = await connectWorker("./adapter-owner.js", config);
  const snapshot = service.snapshot;
  return {
    service,
    catalog: service.catalog,
    resolveChat: service.resolveChat,
    stateRoot: config.sources.map(source => source.path).join(", "),
    presentation: { snapshot, watch: async (id, listener) => {
      let stopped = false, timer: ReturnType<typeof setTimeout>;
      let finish!: () => void;
      const closed = new Promise<void>(resolve => { finish = resolve; });
      const tick = async () => {
        try { if (!stopped) await listener(await snapshot(id)); } catch { stopped = true; finish(); }
        if (!stopped) timer = setTimeout(() => { void tick(); }, 1000);
      };
      await listener(await snapshot(id));
      timer = setTimeout(() => { void tick(); }, 1000);
      return { closed, stop: async () => { stopped = true; clearTimeout(timer); finish(); } };
    } },
    close: service.close,
  };
}

/** A consumer adapter must implement these same operations and read-only observations.
 * It owns its native configuration/authority, never a second transcript or loop. */
export interface Runtime {
  stateRoot: string;
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
export async function openRuntime(): Promise<Runtime> {
  const config = await readConfig();
  if (config.service) return openServiceRuntime(config.service);
  if (!config.installations) return openLocalRuntime(config as LocalConfig);
  const contexts = new Map<string, Runtime>();
  try {
    for (const binding of config.installations) {
      const sources = config.sources.filter(source => source.installation === binding.id);
      if (!sources.length) continue;
      const defaultSource = sources.some(source => source.id === config.defaultSource) ? config.defaultSource
        : (binding.service && binding.definitionsRoot ? sources.find(source => source.id !== binding.service!.sourceId) : undefined)?.id ?? sources[0].id;
      const selected = { sources, defaultSource };
      const runtime: Runtime = binding.service
        ? binding.definitionsRoot && binding.host
          ? await openLocalRuntime({ ...selected, definitionsRoot: binding.definitionsRoot, host: binding.host, service: binding.service })
          : await openSharedHistory(binding.service, sources)
        : binding.adapter
        ? await openAdapter({ ...selected, ...binding.adapter })
        : await openLocalRuntime({ ...selected, definitionsRoot: binding.definitionsRoot!, host: binding.host! });
      contexts.set(binding.id, runtime);
    }
  } catch (error) { await Promise.allSettled([...contexts.values()].map(runtime => runtime.close())); throw error; }
  const qualify = (name: string, id: string) => `${name}~${id}`;
  const context = (id: string) => {
    const at = id.indexOf("~"), name = at > 0 ? id.slice(0, at) : config.installations!.find(binding => binding.unqualifiedChats)?.id, local = at > 0 ? id.slice(at + 1) : id;
    const runtime = name && contexts.get(name);
    if (!runtime || !local || local.includes("~")) throw new AdmissionError("Unknown installation-qualified identity.");
    return { name: name!, local, runtime };
  };
  const chatId = (name: string, id: string) => config.installations!.find(binding => binding.id === name)!.unqualifiedChats ? id : qualify(name, id);
  const project = (name: string, chat: Chat): Chat => ({ ...chat, id: chatId(name, chat.id), agent: qualify(name, chat.agent),
    ...(chat.parentId ? { parentId: chatId(name, chat.parentId) } : {}) });
  const catalog = async () => (await Promise.all([...contexts].map(async ([name, runtime]) =>
    (await (runtime.catalog?.() ?? Promise.resolve(runtime.service.agents))).map(agent => ({ ...agent, id: qualify(name, agent.id),
      description: `${config.installations!.find(binding => binding.id === name)!.label}: ${agent.description}` }))))).flat();
  return {
    stateRoot: config.sources.map(source => source.path).join(", "),
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
        const target = sourceId ?? (binding.service && !binding.definitionsRoot ? binding.service.sourceId : undefined) ?? (config.sources.find(item => item.id === config.defaultSource && item.installation === name)
          ?? config.sources.find(item => item.installation === name && item.id !== binding.service?.sourceId)
          ?? config.sources.find(item => item.installation === name))?.id;
        if (!target || !config.sources.some(item => item.id === target && item.installation === name))
          throw new AdmissionError("Choose a source bound to the selected installation.");
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
