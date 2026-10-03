import type { ConversationView, SubmissionRecord } from "@earendil-works/pi-durable";

export interface RuntimeScope {
  companyId: string;
  userId: string;
}

export type ChatStatus = "idle" | "running" | "stopped" | "failed";

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agentDefinitionId: string;
  agentRevision: number;
  status: ChatStatus;
  error?: string;
}

export interface ChatSnapshot {
  conversation: ChatSummary;
  view: ConversationView;
  submissions: readonly SubmissionRecord[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentDraft {
  name: string;
  description: string;
  instructions: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

export interface AgentDefinition extends AgentDraft {
  id: string;
  revision: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SaveAgentInput extends AgentDraft {
  id?: string;
  expectedRevision?: number;
}

export interface CreateChatInput {
  requestId: string;
  title?: string;
  agentDefinitionId?: string;
}

export interface SendMessageInput {
  requestId: string;
  text: string;
}

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export interface ApplicationConfig {
  company: { id: string; name: string };
  defaultAgentId: string;
  models: ModelOption[];
  providerReady: boolean;
}

export interface ApiErrorResponse {
  error: { code: string; message: string };
}
