import { isAbsolute } from "node:path";
import { serviceRequest, ServiceError } from "@dispatch/runner/service";
import type { ServiceCommand, ServiceResults, ServiceExpectation } from "@dispatch/runner/service";
import type { Chat as NativeChat } from "@dispatch/runner";
import { AdmissionError } from "./config.js";
import type { Runtime } from "./runtime.js";
import type { Capabilities, Chat, Snapshot } from "./contracts.js";

export interface ServiceConnection { socket: string; sourceId?: string; label?: string; expectedStateRoot?: string; expectedIdentity?: string; capabilities?: Capabilities }

/** Connect to the authorized local native owner; closing this client never stops it. */
export async function openServiceRuntime(config: ServiceConnection): Promise<Runtime> {
  if (!config || typeof config.socket !== "string" || !isAbsolute(config.socket))
    throw new Error("Provide an absolute service.socket in trusted installation configuration.");
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
  let expected: ServiceExpectation | undefined = (config.expectedStateRoot !== undefined || config.expectedIdentity !== undefined)
    ? { ...(config.expectedStateRoot !== undefined ? {stateRoot: config.expectedStateRoot} : {}),
      ...(config.expectedIdentity !== undefined ? {identity: config.expectedIdentity} : {}) } : undefined;
  const call = async <C extends ServiceCommand>(command: C): Promise<ServiceResults[C["method"]]> => {
    if (closed) throw new Error("Service connection is closed.");
    try { return await serviceRequest(config.socket, command, { expected }); }
    catch (error) {
      if (error instanceof ServiceError && error.status === 409) throw new AdmissionError(error.message);
      // Transport failures remain uncertain: do not resend or change request IDs.
      throw error;
    }
  };
  const metadata = await call({ method: "info" });
  // Bind all later operations, including reads, to this owner selection. Same
  // root/identity survives compatible restarts; socket reuse by another root does not.
  if (!expected) expected = metadata.identity !== undefined ? { identity: metadata.identity }
    : metadata.stateRoot !== undefined ? { stateRoot: metadata.stateRoot } : undefined;
  if (!expected) throw new Error("The service must expose a stable stateRoot or installation identity for safe client binding.");
  const catalog = async () => (await call({ method: "agents" })).map(agent => ({ ...agent, capabilities }));
  const agents = await catalog();
  const project = (chat: NativeChat): Chat => ({ ...chat, source, sourceLabel: label, capabilities });
  const snapshot = async (id: string): Promise<Snapshot> => {
    const value = await call({ method: "snapshot", id });
    return { ...value, chat: project(value.chat), messages: value.messages.map(message => ({ ...message,
      provenance: message.provenance ?? "runtime" })) };
  };
  return {
    stateRoot: metadata.stateRoot ?? config.socket,
    catalog,
    resolveChat: async (id, installation) => {
      if (installation !== undefined) throw new AdmissionError("Native conversation links require a named installation binding.");
      const chat = (await call({ method: "chats" })).find(chat => chat.id === id);
      if (!chat) throw new AdmissionError("Linked conversation is unavailable in this installation.");
      return project(chat);
    },
    service: {
      agents,
      sources: async () => [{ id: source, label, path: config.socket, issues: [] }],
      list: async () => (await call({ method: "chats" })).map(project),
      has: async id => (await call({ method: "chats" })).some(chat => chat.id === id),
      create: async (agent, transport, key, sourceId = source) => {
        requireCapability("create");
        if (sourceId !== source) throw new AdmissionError("Choose this service's configured source.");
        return project(await call({ method: "create", agent, source: transport, key }));
      },
      submit: async (id, text, requestId, mode, transport, files = []) => {
        if (files.length) requireCapability("attachments");
        return call({ method: "send", id, text, requestId, mode, source: transport, files });
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
        let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
        let finish!: () => void;
        const done = new Promise<void>(resolve => { finish = resolve; });
        let pending: Promise<void> = Promise.resolve();
        const stop = async () => {
          stopped = true;
          clearTimeout(timer);
          watches.delete(stop);
          await pending;
          finish();
        };
        const tick = async () => {
          try {
            const value = await snapshot(id);
            if (!stopped) await listener(value);
          } catch { stopped = true; watches.delete(stop); finish(); }
          if (!stopped) timer = setTimeout(() => { pending = tick(); }, 200);
        };
        // Fail initial observation explicitly; later transport loss ends the watch.
        await listener(await snapshot(id));
        watches.add(stop);
        timer = setTimeout(() => { pending = tick(); }, 200);
        return { closed: done, stop };
      },
    },
    close: async () => {
      closed = true;
      await Promise.all([...watches].map(stop => stop()));
    },
  };
}
