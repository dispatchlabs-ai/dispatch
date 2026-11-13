import type { AttachmentFile, ChatToolCall, ChatTurn } from "@dispatch/runner";
export type { AttachmentFile, ChatToolCall as ToolCall } from "@dispatch/runner";
// Presentation projection of Dispatch's Chat and ChatSnapshot, not an execution model.
export interface Capabilities { create?: boolean; attachments?: boolean; artifacts?: boolean }
export interface Agent {
  capabilities?: Capabilities;
  id: string;
  description: string;
}
export interface Chat {
  activity?: "working" | "waiting" | "idle" | "unanswered" | "unavailable";
  capabilities?: Capabilities;
  id: string;
  agent: string;
  conversationId: number;
  title: string;
  nativeTitle?: string;
  source: string;
  createdAt: string;
  sourceLabel?: string;
  session?: string;
  /** Owning conversation of a task-run worker. Workers are observable, not steerable. */
  parentId?: string;
  /** Native transport that started an indexed chat; absent for unindexed conversations. */
  transport?: string;
  /** Whether this Web installation can currently send to the conversation. */
  addressable?: boolean;
}
export interface ChatMessage {
  provenance: "user" | "agent" | "runtime";
  id: string;
  role: string;
  text: string;
  at?: number;
  commentary?: string;
  author?: string;
  background?: boolean;
  /** A background reply's supporting material, shown collapsed under its text. */
  details?: { label: string; text: string };
  error?: string;
  attachments?: AttachmentFile[];
  artifacts?: {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    createdAt: string;
  }[];
}
export interface SourceStatus {
  id: string;
  label: string;
  path?: string;
  issues: string[];
}
export interface SidebarSnapshot { avatars?: string[]; agents: Agent[]; chats: Chat[]; sources: SourceStatus[] }
export interface Snapshot {
  activity?: Chat["activity"];
  turns?: ChatTurn[];
  toolCalls?: ChatToolCall[];
  observation?: string;
  /** Why sending is unavailable; readOnlyReason carries the display sentence. */
  readOnly?: "worker" | "internal" | "owner" | "unavailable";
  readOnlyReason?: string;
  chat: Chat;
  messages: ChatMessage[];
  running: boolean;
  queued: number;
  partial: string;
  tools: string[];
  error: string | null;
  demo: boolean;
  background: boolean;
  retry?: { attempt: number; at: number; error: string };
}
