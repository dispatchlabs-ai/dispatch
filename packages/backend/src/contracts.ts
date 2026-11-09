// Presentation projection of Dispatch's Chat and ChatSnapshot, not an execution model.
export interface Agent {
  id: string;
  description: string;
}
export interface Chat {
  id: string;
  agent: string;
  conversationId: number;
  title: string;
  source: string;
  createdAt: string;
  sourceLabel?: string;
  session?: string;
  parentId?: string;
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
  error?: string;
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
export interface Snapshot {
  observation?: string;
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
