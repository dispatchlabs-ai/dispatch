import type { ConversationView, EntryRecord, LiveState, SubmissionRecord, UsageState } from "@earendil-works/pi-durable";

export interface RuntimeScope {
  companyId: string;
  userId: string;
}

export type ChatStatus = "idle" | "running" | "stopped" | "failed";

export interface ChatSummary {
  id: string;
  projectId: string | null;
  /** Native Pi commit sequence used to order all derived observations. */
  revision: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  agentDefinitionId: string;
  agentRevision: number;
  /** Display name captured with the conversation's immutable agent revision. */
  agentName: string;
  pinned: boolean;
  archived: boolean;
  status: ChatStatus;
  error?: string;
}

export interface ChatSnapshot {
  conversation: ChatSummary;
  participants: ConversationParticipant[];
  messages: ConversationMessage[];
  activities: ParticipantActivity[];
  /** Compatibility projection; private participant context is never returned. */
  view: ConversationView;
  submissions: readonly SubmissionRecord[];
}

export interface CompanyPerson {
  id: string;
  name: string;
}

export type ParticipantStatus = "idle" | "working" | "silent" | "stopped" | "failed";

interface ParticipantIdentity {
  id: string;
  name: string;
  joinedAt: number;
}

export interface HumanParticipant extends ParticipantIdentity {
  kind: "human";
  userId: string;
  status: "idle";
}

export interface AgentParticipant extends ParticipantIdentity {
  kind: "agent";
  agentDefinitionId: string;
  agentRevision: number;
  status: ParticipantStatus;
  error?: string;
  usage: UsageState;
  /** Configuration saved for this instance, not the definition's latest revision. */
  agent: AgentDraft & { extensions: string[]; tools: string[]; cwd?: string };
}

export type ConversationParticipant = HumanParticipant | AgentParticipant;

export interface ConversationMessage {
  id: string;
  kind: "message" | "membership";
  authorId: string;
  text: string;
  createdAt: number;
  /** Root public-message ID; replies remain visible to all conversation members. */
  threadId: string | null;
  mentions: string[];
}

export interface ParticipantActivity {
  id: string;
  participantId: string;
  threadId: string | null;
  createdAt: number;
  /** Public answer associated with this activity, when one has been committed. */
  messageId?: string;
  /** Public native tool activity only; excludes private input and thinking. */
  entries: readonly EntryRecord[];
  live: LiveState;
  submissions: readonly SubmissionRecord[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  /** Operator-registered Pi capabilities, preserved when editing the basic fields. */
  extensions: string[];
  tools: string[];
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
  agentDefinitionIds?: string[];
  projectId?: string | null;
}

export interface UpdateChatInput {
  pinned?: boolean;
  archived?: boolean;
  projectId?: string | null;
}

export type Project = {
  id: string;
  name: string;
  createdAt: number;
};

export interface CreateProjectInput {
  requestId: string;
  name: string;
}

export interface SendMessageInput {
  requestId: string;
  text: string;
  threadId?: string | null;
  mentions?: string[];
}

export interface AddParticipantsInput {
  requestId: string;
  agentDefinitionIds?: string[];
  userIds?: string[];
}

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
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
