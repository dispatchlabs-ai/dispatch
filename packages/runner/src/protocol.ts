import type { ChatService, Chat, ChatSnapshot } from "./chat.js";
import type { AttachmentFile } from "./chat-content.js";
import type { InstanceMessage } from "./messages.js";

export type ServiceOperations = Pick<ChatService, "list" | "create" | "snapshot" | "watch" | "submit" | "stop" | "artifact"> &
  Partial<Pick<ChatService, "find" | "activity" | "schedules" | "compact" | "receipt" | "wait" | "message" | "messageStatus" | "agentInstances" | "waitForAgent" | "waitForIdle">> & {
    agents: { id: string; description: string; model?: import("./definition.js").LoadedAgent["model"] }[];
  };
export type ServiceMetadata = { stateRoot?: string; defaultAgent?: string;
  /** Stable trusted installation identity for opaque/custom facades without one native root. */
  identity?: string;
};
export type ServiceExpectation = { stateRoot?: string; identity?: string };
export type ServiceCommand =
  | { method: "agents" | "chats" | "status" | "schedules" | "info" }
  | { method: "create"; agent: string; key: string; title?: string; source?: Chat["source"]; origin?: Chat["origin"] }
  | { method: "snapshot" | "stop"; id: string }
  | { method: "drain" }
  | { method: "find"; key: string; agent?: string }
  | { method: "compact"; id: string; instructions?: string }
  | { method: "artifact"; id: string; artifactId: string }
  | { method: "send"; id: string; text: string; requestId: string; mode?: "followUp" | "steer"; source?: Chat["source"]; files?: AttachmentFile[] }
  | { method: "message"; from: string; message: InstanceMessage; requestId: string }
  | { method: "message-status"; from: string; taskId: number }
  | { method: "agent-instances"; from: string }
  | { method: "message-wait"; from: string; taskId: number }
  | { method: "receipt" | "wait"; id: string; submissionId: number };

export async function dispatchCommand(service: ServiceOperations, command: ServiceCommand, signal?: AbortSignal) {
  switch (command.method) {
    case "agents": return service.agents.map(({ id, description, model }) => ({ id, description, model }));
    case "chats": return service.list();
    case "schedules": return service.schedules?.() ?? [];
    case "create":
      if (typeof command.key !== "string" || !command.key.trim()) throw new Error("A stable conversation key is required.");
      return service.create(command.agent, command.source ?? "cli", command.key, command.title, command.origin);
    case "find": {
      if (!service.find) throw new ServiceError("This service does not support key lookup.", 409);
      if (command.agent) return await service.find(command.agent, command.key) ?? null;
      const found = (await Promise.all(service.agents.map(agent => service.find!(agent.id, command.key)))).filter(chat => chat !== undefined);
      if (found.length > 1) throw new Error("This session key selects multiple agents. Supply its original agent.");
      return found[0] ?? null;
    }
    case "snapshot": return service.snapshot(command.id);
    case "compact": if (!service.compact) throw new ServiceError("Unsupported service operation.", 409); return service.compact(command.id, command.instructions);
    case "artifact": {
      const { artifact, bytes } = await service.artifact(command.id, command.artifactId);
      return { artifact, dataBase64: bytes.toString("base64") };
    }
    case "drain": if (!service.waitForIdle) throw new ServiceError("This owner does not support drain.", 409); await service.waitForIdle(signal); return {};
    case "stop": await service.stop(command.id); return {};
    case "send": {
      const source = command.source ?? "cli";
      const mode = source === "agent" || source === "schedule" ? command.mode ?? "followUp" : "steer";
      return service.submit(command.id, command.text, command.requestId, mode, source, command.files);
    }
    case "wait": if (!service.wait) throw new ServiceError("Unsupported service operation.", 409); return service.wait(command.id, command.submissionId, signal);
    case "receipt": if (!service.receipt) throw new ServiceError("Unsupported service operation.", 409); return service.receipt(command.id, command.submissionId);
    case "message": if (!service.message) throw new ServiceError("Unsupported service operation.", 409); return service.message(command.from, command.message, command.requestId);
    case "message-status": if (!service.messageStatus) throw new ServiceError("Unsupported service operation.", 409); return service.messageStatus(command.from, command.taskId);
    case "agent-instances": if (!service.agentInstances) throw new ServiceError("Unsupported service operation.", 409); return service.agentInstances(command.from);
    case "message-wait": if (!service.waitForAgent) throw new ServiceError("Unsupported service operation.", 409); return service.waitForAgent(command.from, command.taskId, signal);
    default: throw new Error("Unknown service command.");
  }
}

export type ServiceResults = {
  info: ServiceMetadata;
  drain: Record<string, never>;
  agents: { id: string; description: string; model?: import("./definition.js").LoadedAgent["model"] }[];
  chats: Chat[];
  find: Chat | null;
  create: Chat;
  snapshot: ChatSnapshot;
  send: { submissionId: number };
  stop: Record<string, never>;
  receipt: Awaited<ReturnType<ChatService["receipt"]>>;
  wait: Awaited<ReturnType<ChatService["wait"]>>;
  artifact: { artifact: import("./artifacts.js").Artifact; dataBase64: string };
  status: Awaited<ReturnType<ChatService["activity"]>> & { adapterBusy: boolean };
  schedules: Awaited<ReturnType<ChatService["schedules"]>>;
  compact: Awaited<ReturnType<ChatService["compact"]>>;
  message: Awaited<ReturnType<ChatService["message"]>>;
  "message-status": Awaited<ReturnType<ChatService["messageStatus"]>>;
  "agent-instances": Awaited<ReturnType<ChatService["agentInstances"]>>;
  "message-wait": Awaited<ReturnType<ChatService["waitForAgent"]>>;
};

export class ServiceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
