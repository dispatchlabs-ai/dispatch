import type { ConversationView, EntryRecord, LiveState, SubmissionRecord, UsageState } from "@earendil-works/pi-durable";

export interface RuntimeScope {
  companyId: string;
  userId: string;
}

export type ChatStatus = "idle" | "running" | "stopped" | "failed";

export interface ChatSummary {
  sharedProjectId?: string | null;
  canParticipate?: boolean;
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

export type ParticipantStatus = "idle" | "working" | "listening" | "responding" | "silent" | "stopped" | "failed";

interface ParticipantIdentity {
  id: string;
  name: string;
  joinedAt: number;
}

export interface HumanParticipant extends ParticipantIdentity {
  kind: "human";
  userId: string;
  status: "idle" | "typing";
}

export interface AgentParticipant extends ParticipantIdentity {
  kind: "agent";
  agentDefinitionId: string;
  agentRevision: number;
  membership: "active" | "removing" | "removed";
  removalError?: string;
  /** Creation-time supplement; agent.instructions retains the base definition snapshot. */
  instanceInstructions?: string;
  status: ParticipantStatus;
  error?: string;
  usage: UsageState;
  /** Configuration saved for this instance, not the definition's latest revision. */
  agent: AgentDraft & { extensions: string[]; tools: string[]; cwd?: string };
}

export type ConversationParticipant = HumanParticipant | AgentParticipant;

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_TOTAL_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;
/** Raw-byte budgets for native model content; original downloads retain the upload limit. */
export const ATTACHMENT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const ATTACHMENT_IMAGE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "text" | "file";
  /** Authenticated, conversation-authorized download/preview route. */
  url: string;
};

export interface ConversationMessage {
  id: string;
  /** Prior IDs of the same native reply; preserved for thread and history references. */
  aliases?: string[];
  kind: "message" | "membership";
  authorId: string;
  text: string;
  createdAt: number;
  attachments?: Attachment[];
  /** Native image content retained when projecting existing public messages. */
  images?: { mimeType: string; data: string }[];
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

export type SkillSelection = { id: string; revision: number };
export type SkillDefinition = SkillSelection & {
  name: string; description: string; instructions: string; createdAt: number; updatedAt: number;
};
export interface SaveSkillInput {
  id?: string; expectedRevision?: number; requestId: string;
  name: string; description: string; instructions: string;
}

export interface AgentDraft {
  name: string;
  description: string;
  instructions: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Selections from the capabilities installed by this application. */
  capabilities?: ("files-and-commands" | "image-generation")[];
  skills?: SkillSelection[];
}

export interface AgentDefinition extends AgentDraft {
  id: string;
  /** Native extension selections stored with this revision. */
  extensions: string[];
  tools: string[];
  connections?: AgentConnection[];
  revision: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AgentConnection = {
  id: string;
  name: string;
  endpoint: string;
  identity: string;
  extension: string;
  /** oauth is retained when reading older saved definitions. */
  source?: "operator" | "managed" | "oauth";
  serverName?: string;
};

export interface AgentConnectionStatus extends AgentConnection {
  status: "connected" | "disconnected" | "unavailable";
  checkedAt: number | null;
  tools: { name: string; title?: string; description: string }[];
  error?: string;
  scopes?: string[];
  authentication?: ConnectionAuthentication;
  authorization?: ConnectionAuthorizationState;
  disconnectNotice?: string;
}

export type ConnectionAuthentication = "oauth" | "bearer" | "headers" | "none";
export type ConnectionAuthorizationState = "pending" | "authorized" | "reauthorize" | "revoking" | "revoked" | "error";

export interface ManagedConnection extends AgentConnectionStatus {
  createdAt: number;
  canManage: boolean;
  usedBy: { id: string; name: string }[];
}

export type ConnectMcpInput = {
  requestId: string;
  name: string;
  endpoint: string;
  connectionId?: string;
} & (
  | { authentication: "oauth"; scopes?: string[]; clientId?: string; clientSecret?: string }
  | { authentication: "bearer"; token: string }
  | { authentication: "headers"; headers: Record<string, string> }
  | { authentication: "none" }
);

export type ConnectMcpResult = { id: string; authorizationUrl?: string };
export const isManagedConnection = (connection: AgentConnection) => connection.source === "managed" || connection.source === "oauth";

export interface SaveAgentInput extends AgentDraft {
  id?: string;
  expectedRevision?: number;
  /** Managed connections selected for this definition; operator connections stay operator-owned. */
  connectionIds?: string[];
  applyConnectionsToExisting?: boolean;
  requestId?: string;
}

export interface CreateChatInput {
  requestId: string;
  title?: string;
  agentDefinitionId?: string;
  agentDefinitionIds?: string[];
  sharedProjectId?: string | null;
}

export interface UpdateChatInput {
  pinned?: boolean;
  archived?: boolean;
}

export type ProjectMember = { userId: string; role: "manager" | "member" };
export interface SaveProjectInput {
  requestId: string; expectedRevision: number; name: string;
  members: ProjectMember[]; defaultAgentDefinitionIds: string[];
}

export type Project = {
  kind: "shared";
  revision?: number;
  members?: ProjectMember[];
  defaultAgentDefinitionIds?: string[];
  canManage?: boolean;
  canParticipate?: boolean;
  id: string;
  name: string;
  createdAt: number;
};

export interface CreateProjectInput {
  kind: "shared";
  requestId: string;
  name: string;
}

export interface SendMessageInput {
  requestId: string;
  attachmentIds?: string[];
  text: string;
  threadId?: string | null;
  mentions?: string[];
  /** Definition IDs selected as invite-on-send mentions; resolved to a single active participant on admission, or rejected as ambiguous. */
  agentMentions?: string[];
}

export interface CreateAgentInstanceInput {
  requestId: string;
  agentDefinitionId: string;
  name?: string;
  instructions?: string;
}

export type CreateAgentInstanceResult = ChatSnapshot & { createdParticipantId: string };

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
