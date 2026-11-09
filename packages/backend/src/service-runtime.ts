import { isAbsolute } from "node:path";
import { serviceRequest, ServiceError } from "@dispatch/runner/service";
import type { ServiceCommand, ServiceResults } from "@dispatch/runner/service";
import type { Chat as NativeChat } from "@dispatch/runner";
import { AdmissionError } from "./config.js";
import type { Runtime } from "./runtime.js";
import type { Chat, Snapshot } from "./contracts.js";

export interface ServiceConnection { socket: string; sourceId?: string; label?: string }

/** Connect to the authorized local native owner; closing this client never stops it. */
export async function openServiceRuntime(config: ServiceConnection): Promise<Runtime> {
  if (!config || typeof config.socket !== "string" || !isAbsolute(config.socket))
    throw new Error("Provide an absolute service.socket in trusted installation configuration.");
  const source = config.sourceId ?? "service", label = config.label ?? "Native service";
  let closed = false;
  const watches = new Set<() => Promise<void>>();
  const call = async <C extends ServiceCommand>(command: C): Promise<ServiceResults[C["method"]]> => {
    if (closed) throw new Error("Service connection is closed.");
    try { return await serviceRequest(config.socket, command); }
    catch (error) {
      if (error instanceof ServiceError && error.status === 409) throw new AdmissionError(error.message);
      // Transport failures remain uncertain: do not resend or change request IDs.
      throw error;
    }
  };
  const agents = await call({ method: "agents" });
  const metadata = await call({ method: "info" });
  const project = (chat: NativeChat): Chat => ({ ...chat, source, sourceLabel: label });
  const snapshot = async (id: string): Promise<Snapshot> => {
    const value = await call({ method: "snapshot", id });
    return { ...value, chat: project(value.chat), messages: value.messages.map(message => ({ ...message,
      provenance: message.provenance ?? "runtime" })) };
  };
  return {
    stateRoot: metadata.stateRoot ?? config.socket,
    service: {
      agents,
      sources: async () => [{ id: source, label, path: config.socket, issues: [] }],
      list: async () => (await call({ method: "chats" })).map(project),
      has: async id => (await call({ method: "chats" })).some(chat => chat.id === id),
      create: async (agent, transport, key, sourceId = source) => {
        if (sourceId !== source) throw new AdmissionError("Choose this service's configured source.");
        return project(await call({ method: "create", agent, source: transport, key }));
      },
      submit: (id, text, requestId, mode, transport, files = []) => call({ method: "send", id, text, requestId, mode, source: transport, files }),
      stop: async id => { await call({ method: "stop", id }); },
      artifact: async (id, artifactId) => {
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
