import { isAbsolute } from "node:path";
import { connectClient, type ClientConnection } from "@dispatch/runner/client";
import { ServiceError } from "@dispatch/runner/client";
import type { ServiceCommand, ServiceResults, ServiceExpectation } from "@dispatch/runner/client";
import type { Chat as NativeChat } from "@dispatch/runner";
import { AdmissionError } from "./config.js";
import type { Runtime } from "./runtime.js";
import type { Capabilities, Chat, Snapshot } from "./contracts.js";

export type ServiceConnection = ClientConnection & { sourceId?: string; label?: string; expectedStateRoot?: string; expectedIdentity?: string; capabilities?: Capabilities; keyedCreation?: { agent: string; keyPrefix: string } }

/** Connect to the authorized local native owner; closing this client never stops it. */
export async function openServiceRuntime(config: ServiceConnection): Promise<Runtime> {
  if (!config || config.socket && !isAbsolute(config.socket)) throw new Error("Provide an absolute service socket or a service URL.");
  const keyed = config.keyedCreation;
  if (keyed && (!/^[a-zA-Z0-9_-]+$/.test(keyed.agent) || !/^[a-z][a-z0-9-]*:$/.test(keyed.keyPrefix)))
    throw new Error("Provide keyedCreation agent and keyPrefix in trusted service configuration.");
  const capabilities = config.capabilities;
  if (capabilities && (typeof capabilities !== "object" || Object.entries(capabilities).some(([key, value]) =>
    !["create", "attachments", "artifacts"].includes(key) || typeof value !== "boolean")))
    throw new Error("Service capabilities must contain boolean create, attachments or artifacts fields.");
  const requireCapability = (key: keyof Capabilities) => {
    if (capabilities?.[key] === false) throw new AdmissionError(`This installation does not support ${key}.`);
  };
  const source = config.sourceId ?? "service", label = config.label ?? "Native service";
  let closed = false;
  const watches = new Set<() => Promise<void>>();
  const expected: ServiceExpectation | undefined = (config.expectedStateRoot !== undefined || config.expectedIdentity !== undefined)
    ? { ...(config.expectedStateRoot !== undefined ? {stateRoot: config.expectedStateRoot} : {}),
      ...(config.expectedIdentity !== undefined ? {identity: config.expectedIdentity} : {}) } : undefined;
  const client = await connectClient({ ...config, expected });
  const call = async <C extends ServiceCommand>(command: C): Promise<ServiceResults[C["method"]]> => {
    if (closed) throw new Error("Service connection is closed.");
    try { return await client.command(command); }
    catch (error) {
      if (error instanceof ServiceError && error.status === 409) throw new AdmissionError(error.message);
      // Transport failures remain uncertain: do not resend or change request IDs.
      throw error;
    }
  };
  const metadata = await call({ method: "info" });
  const catalog = async () => (await call({ method: "agents" })).map(agent => ({ ...agent, capabilities }));
  const agents = await catalog();
  let lastChats: Chat[] = [];
  // Chat.source names the configured source; the native value is the starting transport.
  const project = (chat: NativeChat): Chat => ({ ...chat, transport: chat.source, source, sourceLabel: label, capabilities, addressable: true });
  const snapshot = async (id: string): Promise<Snapshot> => {
    const value = await call({ method: "snapshot", id });
    return { ...value, chat: project(value.chat), messages: value.messages.map(message => ({ ...message,
      provenance: message.provenance ?? "runtime" })) };
  };
  return {
    stateRoot: metadata.stateRoot ?? config.socket ?? config.url!,
    catalog,
    summary: async () => {
      let currentAgents, chats;
      try { [currentAgents, chats] = await Promise.all([catalog(), call({ method: "chats" })]); lastChats = chats.map(project); }
      catch { return { agents, chats: lastChats.map(chat => ({ ...chat, activity: "unavailable" as const })), sources: [{ id: source, label, issues: ["Native service unavailable. Reconnect its original owner."] }] }; }
      // A healthy service is not evidence of active work. Native task states are.
      let activity: Awaited<ReturnType<typeof call<{method: "status"}>>> | undefined;
      try { activity = await call({ method: "status" }); } catch { /* Older trusted facades may not expose status. */ }
      return { agents: currentAgents, sources: [{ id: source, label, path: config.socket ?? config.url, issues: [] }], chats: await Promise.all(chats.map(async chat => {
        const work = activity?.hosts.flatMap(host => host.conversations).find(item => item.id === chat.id);
        const host = activity?.hosts.find(host => host.conversations.some(item => item.id === chat.id));
        let state = !activity || host?.scheduling === "paused" || work?.tasks.some(task => task.state === "blocked") ? "unavailable" : work?.held ? "unavailable" : work?.tasks.some(task => ["running", "pending"].includes(task.state)) ? "working" : work?.tasks.length || work?.queued ? "waiting" : "idle";
        if (state === "working" && work?.tasks.some(task => task.kind === "pi.tool")) {
          try {
            const live = await snapshot(chat.id);
            const calls = live.toolCalls?.filter(call => ["running", "pending", "waiting"].includes(call.status)) ?? [];
            if (calls.length && calls.every(call => ["delegate", "clone_agent", "wait_for_agent"].includes(call.name))) state = "waiting";
          } catch { state = "unavailable"; }
        }
        return { ...project(chat), activity: state as Chat["activity"] };
      })) };
    },
    openKeyedChat: async (key, title, installation) => {
      if (installation !== undefined) throw new AdmissionError("Keyed conversation links require a named installation binding.");
      if (!keyed) throw new AdmissionError("This installation does not allow keyed conversation links.");
      if (!key.startsWith(keyed.keyPrefix) || key.length === keyed.keyPrefix.length || /[\u0000-\u001f\u007f-\u009f]/.test(key))
        throw new AdmissionError("Invalid conversation link key.");
      if (!title.trim()) throw new AdmissionError("A conversation link title is required.");
      return project(await call({ method: "create", agent: keyed.agent, key, title, source: "web" }));
    },
    resolveChat: async (id, installation) => {
      if (installation !== undefined) throw new AdmissionError("Native conversation links require a named installation binding.");
      const chat = (await call({ method: "chats" })).find(chat => chat.id === id);
      if (!chat) throw new AdmissionError("Linked conversation is unavailable in this installation.");
      return project(chat);
    },
    service: {
      agents,
      sources: async () => [{ id: source, label, path: config.socket ?? config.url, issues: [] }],
      list: async () => (await call({ method: "chats" })).map(project),
      has: async id => (await call({ method: "chats" })).some(chat => chat.id === id),
      create: async (agent, transport, key, sourceId = source) => {
        requireCapability("create");
        if (sourceId !== source) throw new AdmissionError("Choose this service's configured source.");
        return project(await call({ method: "create", agent, source: transport, key }));
      },
      submit: async (id, text, requestId, _mode, transport, files = []) => {
        if (files.length) requireCapability("attachments");
        return call({ method: "send", id, text, requestId, mode: "steer", source: transport, files });
      },
      stop: async id => { await call({ method: "stop", id }); },
      artifact: async (id, artifactId) => {
        requireCapability("artifacts");
        const value = await call({ method: "artifact", id, artifactId });
        return { artifact: value.artifact, bytes: Buffer.from(value.dataBase64, "base64") };
      },
    },
    presentation: {
      snapshot,
      watch: async (id, listener) => {
        const watch = await client.watch(id, async value => listener({ ...value,
          chat: project(value.chat), messages: value.messages.map(message => ({ ...message, provenance: message.provenance ?? "runtime" })),
        }));
        const stop = async () => { watches.delete(stop); await watch.stop(); };
        watches.add(stop);
        void watch.closed.then(() => watches.delete(stop), () => watches.delete(stop));
        return { closed: watch.closed, stop };
      },
    },
    close: async () => {
      closed = true;
      await Promise.all([...watches].map(stop => stop()));
      await client.close();
    },
  };
}
