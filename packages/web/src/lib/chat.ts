import type { AgentState, LiveState, UsageState } from "@earendil-works/pi-durable";
import type { ChatSnapshot, ChatSummary } from "../shared/contracts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "error";

export interface PendingMessage {
  requestId: string;
  text: string;
  sending: boolean;
  error?: string;
}

export function chatAgent(snapshot: ChatSnapshot): AgentState {
  return (snapshot.view.docs["pi.agent"] as AgentState | undefined) || {};
}

export function chatLive(snapshot: ChatSnapshot): LiveState {
  return (snapshot.view.docs["pi.live"] as LiveState | undefined) || {};
}

export function chatUsage(snapshot: ChatSnapshot): UsageState {
  return (snapshot.view.docs["pi.usage"] as UsageState | undefined) || { models: {}, tools: {} };
}

export function mergeChat(chats: ChatSummary[], update: ChatSummary): ChatSummary[] {
  const existing = chats.find(chat => chat.id === update.id);
  if (existing && existing.revision > update.revision) return chats;
  return [update, ...chats.filter(chat => chat.id !== update.id)].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

export const statusLabels = { idle: "Ready", running: "Responding", stopped: "Stopped", failed: "Needs attention" } as const;
