import type { ChatSnapshot, ChatSummary } from "../shared/contracts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "error";

export interface PendingMessage {
  requestId: string;
  text: string;
  threadId?: string | null;
  mentions?: string[];
  attachmentIds?: string[];
  sending: boolean;
  error?: string;
}

export function mergeChat(chats: ChatSummary[], update: ChatSummary): ChatSummary[] {
  const existing = chats.find(chat => chat.id === update.id);
  if (existing && existing.revision > update.revision) return chats;
  return [update, ...chats.filter(chat => chat.id !== update.id)].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

export const statusLabels = { idle: "Ready", running: "Active", stopped: "Stopped", failed: "Needs attention" } as const;

export function chatStatusLabel(snapshot: ChatSnapshot) {
  if (snapshot.conversation.status !== "running") return statusLabels[snapshot.conversation.status];
  const agents = snapshot.participants.filter(member => member.kind === "agent");
  if (agents.some(member => member.status === "responding")) return "Responding";
  if (agents.some(member => member.status === "working")) return "Working";
  return "Listening";
}
