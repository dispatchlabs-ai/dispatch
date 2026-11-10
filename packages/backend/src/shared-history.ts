import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { openServiceRuntime, type ServiceConnection } from "./service-runtime.js";
import { createStores, identity } from "./stores.js";
import * as reader from "@dispatch/runner/watch-reader";
import type { Chat, Snapshot } from "./contracts.js";
import type { Runtime } from "./runtime.js";
import { AdmissionError, type Source } from "./config.js";

export interface SharedHistoryConnection extends ServiceConnection {
  sourceId: string;
  /** Native session directory, for canonical deduplication with saved SQLite history. */
  stateRoot: string;
}

/** Saved observation and live service access share canonical native identities.
 * No mutation can fall back to a local owner, even while the socket is absent. */
export async function openSharedHistory(config: SharedHistoryConnection, sources: Source[]): Promise<Runtime> {
  const source = sources.find(source => source.id === config.sourceId);
  if (!source) throw new Error("service.sourceId must select a configured source.");
  const root = await realpath(config.stateRoot);
  const session = relative(await realpath(source.path), root) || ".";
  if (session === ".." || session.startsWith("../") || isAbsolute(session))
    throw new Error("service.stateRoot must be a native session directory at or within its configured source.");
  const stores = createStores({ sources }, reader);
  const idFor = (chat: Chat) => identity(join(root, chat.agent, "session.sqlite"), chat.conversationId);
  const project = (chat: Chat): Chat => ({ ...chat, capabilities: config.capabilities, id: idFor(chat), source: source.id, sourceLabel: source.label, session,
    ...(chat.parentId ? { parentId: identity(join(root, chat.agent, "session.sqlite"), Number(chat.parentId.split(":").at(-1))) } : {}) });
  let connected: Runtime | undefined;
  let connecting: Promise<Runtime> | undefined;
  let closed = false;
  const watches = new Set<() => Promise<void>>();
  let issue: string | undefined;
  const unavailable = () => {
    issue = "Shared service unavailable. Saved histories remain viewable. Reconnect the configured owner; no message was automatically resent.";
    const previous = connected; connected = undefined;
    void previous?.close().catch(() => {});
  };
  const connection = async () => {
    if (closed) throw new Error("Service connection is closed.");
    if (connected) return connected;
    connecting ??= openServiceRuntime({ ...config, expectedStateRoot: root }).then(async runtime => {
      if (closed) { await runtime.close(); throw new Error("Service connection is closed."); }
      connected = runtime; return runtime;
    }).finally(() => { connecting = undefined; });
    return connecting;
  };
  const read = async <T>(operation: (runtime: Runtime) => Promise<T>): Promise<T | undefined> => {
    try { const value = await operation(await connection()); issue = undefined; return value; }
    catch { unavailable(); return undefined; }
  };
  const chats = async () => await read(runtime => runtime.service.list()) ?? [];
  const nativeId = (id: string, chats: Chat[]) => chats.find(chat => idFor(chat) === id)?.id;
  const mutate = async <T>(operation: (runtime: Runtime) => Promise<T>): Promise<T> => {
    try { return await operation(await connection()); }
    catch (error) { if (!(error instanceof AdmissionError)) unavailable(); throw error; }
  };
  const owned = async (runtime: Runtime, id: string) => {
    const native = nativeId(id, await runtime.service.list());
    if (!native) throw new AdmissionError("This history is not owned by the configured shared service. Use its original owner; saved work was not resumed.");
    return native;
  };
  const snapshot = async (id: string): Promise<Snapshot> => {
    const value = await read(async runtime => {
      const native = nativeId(id, await runtime.service.list());
      return native ? runtime.presentation.snapshot(native) : undefined;
    });
    if (!value) {
      const saved = await stores.snapshot(id);
      return { ...saved, chat: { ...saved.chat, capabilities: config.capabilities } };
    }
    // Older owners may omit optional turn projections. Read the same native
    // records without resuming them; never derive cancellation from idle state.
    const turns = value.turns ?? (await stores.snapshot(id)).turns;
    return { ...value, turns, chat: project(value.chat) };
  };
  const catalog = async () => await read(runtime => runtime.catalog?.() ?? Promise.resolve(runtime.service.agents)) ?? [];
  const agents = await catalog();
  return {
    resolveChat: async id => {
      const chat = (await chats()).find(chat => chat.id === id);
      if (!chat) throw new AdmissionError("Linked conversation is unavailable in this installation.");
      return project(chat);
    },
    stateRoot: root,
    service: {
      // Catalogs are loaded afresh by the service client, not authored by Web.
      agents,
      async sources() {
        await chats();
        return (await stores.statuses()).map(status => status.id === source.id && issue ? { ...status, issues: [...status.issues, issue] } : status);
      },
      async list() {
        const all = new Map<string, Chat>((await stores.list()).map(chat => [chat.id, { ...chat, capabilities: config.capabilities }]));
        for (const chat of await chats()) { const value = project(chat); all.set(value.id, value); }
        return [...all.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },
      has: async id => Boolean(nativeId(id, await chats())) || stores.has(id),
      create: (agent, transport, key, sourceId = source.id) => mutate(async runtime => {
        if (sourceId !== source.id) throw new AdmissionError("Choose the source bound to this shared service.");
        const chat = await runtime.service.create(agent, transport, key, sourceId);
        stores.invalidate();
        return project(chat);
      }),
      submit: (id, text, requestId, _mode, source, files) => mutate(async runtime => runtime.service.submit(await owned(runtime, id), text, requestId, "steer", source, files)),
      stop: id => mutate(async runtime => runtime.service.stop(await owned(runtime, id))),
      async artifact(id, artifactId) {
        if (config.capabilities?.artifacts === false) throw new AdmissionError("This installation does not support artifacts.");
        const value = await read(async runtime => {
          const native = nativeId(id, await runtime.service.list());
          return native ? runtime.service.artifact(native, artifactId) : undefined;
        });
        if (value) return value;
        const item = await stores.get(id);
        const artifact = (await stores.snapshot(id)).messages.flatMap(message => message.artifacts ?? []).find(artifact => artifact.id === artifactId);
        if (!artifact) throw new Error("Unknown artifact.");
        const { ArtifactStore } = await import("@dispatch/runner");
        return { artifact, bytes: await new ArtifactStore(join(dirname(item.store.path), "artifacts")).read(item.chat.conversationId, artifact) };
      },
    },
    catalog,
    presentation: { snapshot, watch: async (id, listener) => {
      const watch = await pollSnapshot(() => snapshot(id), listener);
      const stop = async () => { watches.delete(stop); await watch.stop(); };
      watches.add(stop); void watch.closed.then(() => watches.delete(stop));
      return { ...watch, stop };
    } },
    close: async () => { closed = true; await Promise.all([...watches].map(stop => stop())); await connecting?.catch(() => {}); await connected?.close(); },
  };
}

export async function pollSnapshot(snapshot: () => Promise<Snapshot>, listener: (value: Snapshot) => Promise<void>) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  let pending = Promise.resolve();
  const tick = async () => {
    try { const value = await snapshot(); if (!stopped) await listener(value); }
    catch { stopped = true; finish(); }
    if (!stopped) timer = setTimeout(() => { pending = tick(); }, 1000);
  };
  await listener(await snapshot());
  timer = setTimeout(() => { pending = tick(); }, 1000);
  return { closed, stop: async () => { stopped = true; clearTimeout(timer); await pending; finish(); } };
}
