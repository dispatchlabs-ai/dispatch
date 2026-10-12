import { createAgentSecrets } from "./extensions/agent-secrets.js";
import { withSharedContextCache } from "./collaboration/prompt-cache.js";
import type { TranscriptQuery } from "../src/shared/contracts.js";
import { ProjectArchiveStore, ProjectArchivesDoc, archiveDigest, decodeProjectArchive } from "./project-archives.js";
import { PROJECT_ARCHIVE_MAX_BYTES, type ProjectArchive, type ArchivedChat } from "../src/shared/project-archives.js";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { AgentDoc, configure, createRegistry, defineDoc, Harness, InboxDoc, LiveDoc, type CommitPublication, type ConversationId, type HarnessSettings, type Registry, type RegistryReader, type Storage, type Tx, type EntryRecord, type Cursor } from "@earendil-works/pi-durable";
import { WorkerActorsDoc, WorkerInstancesDoc, WorkerIdentityDoc, workerParticipantReportSchema, type BackendWorkerActor, type WorkerParticipantReport } from "./workers/participant-identity.js";
export type { WorkerParticipantReport } from "./workers/participant-identity.js";
import type { WorkerSummary } from "./workers/summaries.js";
import { prepareWorkerWorkspace, workerWorkspaceSection, WorkerWorkspaceDoc } from "./workers/workspace.js";
import { PostgresStorage } from "./storage/postgres/storage.js";
import { openPiStorage, type PiStorageConfig } from "./storage/open.js";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ProjectInstructionsDocument, SaveProjectInstructionsInput, CreateAgentInstanceInput, CreateAgentInstanceResult, AddParticipantsInput, CompanyPerson, SendMessageInput, AgentDefinition, AgentDraft, ChatSnapshot, ChatSummary, CreateChatInput, CreateProjectInput, Project, ProjectSpecDocument, ProjectMarkdownDocument, SaveProjectMarkdownInput, ImportProjectMarkdownInput, ProjectSpecReadInput, ProjectSpecPage, RuntimeScope, SaveAgentInput, UpdateChatInput, ManagedConnection, SkillDefinition, SaveSkillInput, SaveProjectInput } from "../src/shared/contracts.js";
import type { BundleExportInput, BundleImportResult, BundlePreview, PortableBundle, PortableAgent, PortableSkill } from "../src/shared/bundles.js";
import type { GitHubInstallation, GitHubBundleSource, GitHubBundlePreview, GitHubBundleApplyInput, GitHubBundleApplyResult } from "../src/shared/github-bundles.js";
import { isManagedConnection } from "../src/shared/contracts.js";
import { AttachmentsDoc, AttachmentStore, AttachmentError, attachmentMetadata } from "./attachments.js";
import { acquireRuntimeOwner } from "./runtime-owner.js";
import { projectSourcesSchema } from "../src/shared/project-sources.js";
import { ProjectMarkdownDoc, readProjectMarkdown, saveProjectMarkdown, replayProjectMarkdown, markdownHash, projectMarkdownPage } from "./project-markdown.js";
import { readProjectInstructions, saveProjectInstructions } from "./project-instructions.js";
import { ProjectsDoc, projectAccess, requireProjectAccess, type SharedProjectRecord } from "./project-access.js";
import { projectChatsSchema, chatSourceUrl, type ProjectChatsInput, type ProjectChatsResult, type ProjectChatMetadata, type ProjectChatReadInput, type ProjectChatResult } from "./project-chat-context.js";
import { readProjectChat } from "./project-chat-reader.js";
import { PublicSummaryDoc } from "./collaboration/summary.js";
import { readLocalProjectSpec } from "./local-project-spec.js";
import { fetchPublicGithubSpec, ProjectSpecError } from "./project-spec.js";
import { createWebResearch } from "./extensions/web.js";
import { createWebBackend } from "./web/backend.js";
import { Skills, SkillBindingsDoc } from "./extensions/skills.js";
import { imageGenerationSkill } from "./skills/image-generation.js";
import { agentBrowserSkill, dogfoodSkill } from "./skills/agent-browser/index.js";
import { createImageGen } from "./extensions/image-gen.js";
import { Coding } from "./extensions/coding.js";
import { SharedConversations, SharedDoc, PublicEntry, type Member, type PeopleDirectory, type Person } from "./collaboration/shared.js";
import { AgentConnections, isMcpExtension, isMcpTool } from "./mcp.js";
import type { AuthPrincipal } from "./auth.js";
import { ManagementError, detached, grantHistory, managementFields, readGrants, writeGrant, type Grant } from "./agent-grants.js";
import { parseEvaluationProfile, readEvaluationProfile, readEvaluationProfileRevision, saveEvaluationProfile } from "./evaluations.js";
import { managementReadSchema, managementSaveSchema } from "./agent-management.js";
import type { McpConnections } from "./mcp-connections.js";

const context = BACKGROUND_CONTEXT;
export const DEFAULT_AGENT_ID = "developer";
const IMAGE_GENERATION_SKILL_ID = "d6f5a67d-5c7b-4813-910f-b29d97d29cd1";
// Fixed application selections, not a plugin registry. Markers preserve historical capability recognition.
const capabilityDefinitions: { id: NonNullable<AgentDefinition["capabilities"]>[number]; marker: string; extensions: string[]; tools: string[] }[] = [
  { id: "files-and-commands", marker: CodingTools.name, extensions: [Coding.name, CodingTools.name, "dispatch-agent-secrets"], tools: ["read", "write", "edit", "bash", "secrets_list", "git_clone"] },
  { id: "image-generation", marker: "dispatch-image-gen", extensions: ["dispatch-image-gen"], tools: ["generate_image"] },
  { id: "edit-definition-of-done", marker: "dispatch-definition-of-done", extensions: ["dispatch-definition-of-done"], tools: ["conversation_definition_of_done"] },
  { id: "web-reading", marker: "dispatch-web-read", extensions: ["dispatch-web-read"], tools: ["web_read"] },
  { id: "web-search", marker: "dispatch-web-search", extensions: ["dispatch-web-search"], tools: ["web_search"] },
];
const capabilityExtensions = new Set([...capabilityDefinitions.flatMap(item => item.extensions), "dispatch-web"]);
const capabilityTools = new Set([...capabilityDefinitions.flatMap(item => item.tools), "web_run"]);
type StoredChat = Omit<ChatSummary, "sharedProjectId" | "canParticipate" | "status" | "error" | "updatedAt" | "revision" | "agentName" | "pinned" | "archived" | "projectId"> & { creationFingerprint?: string; creationTitleExplicit?: boolean; displayTitle?: string; pinned?: boolean; archived?: boolean; agentName?: string; creationProjectId?: string | null; companyId: string; userId: string; requestId: string; creationAgentIds?: string[]; creationAgentsOmitted?: boolean };
type StoredAgent = Omit<AgentDefinition, "extensions" | "tools"> & { companyId: string; extensions?: string[]; tools?: string[]; savedBy?: string; saveRequestId?: string; saveFingerprint?: string };
type StoredSkill = SkillDefinition & { companyId: string; savedBy: string; requestId: string; fingerprint: string };
type Catalog = { skills?: StoredSkill[]; chats: StoredChat[]; agents: StoredAgent[]; runtimeInstance?: string; connectionOwners?: Record<string, string> };
type ManagementActor = Awaited<ReturnType<SharedConversations["managementActor"]>>;
/** Nonsecret backend projection. History is retained so pinned skill/agent revisions stay resolvable. */
export type WorkerCatalogSnapshot = {
  sourceId: string; companyId: string; revision: number;
  agents: AgentDefinition[]; skills: SkillDefinition[]; projects: never[];
  sharedProjects: SharedProjectRecord[]; grants: Grant[];
  connectionOwners: Record<string, string>; readAllProjectUserIds: string[];
};
export type WorkerManagementActor = ManagementActor & { conversationKey: string; storeId: string; actorId: string; participantReport: WorkerParticipantReport };
export type WorkerManagement = {
  read(actor: WorkerManagementActor, input: unknown): Promise<unknown>;
  save(actor: WorkerManagementActor, callId: string, input: unknown): Promise<unknown>;
};
export type WorkerMcpSelection = { connections: NonNullable<AgentDefinition["connections"]>; extensions: string[]; tools: string[] };
export type WorkerMcp = {
  prepare(registry: Registry, membership: WorkerMembershipSnapshot, actorForInstance: (id: ConversationId) => Promise<WorkerManagementActor>): Promise<void>;
};
type WorkerInvitationEvent = { revision: number; authorUserId?: string; authorDefinitionId?: string; authorActorId?: string; names: string[]; at: number };
export type WorkerMembershipSnapshot = {
  conversationKey: string; revision: number; humans: Person[]; agents: {
    actorId: string; definitionId: string; revision: number; desiredRevision: number;
    /** Desired membership; actual cleanup state is in the participant report. */
    membership: "active" | "removing"; legacy: boolean;
    creation?: { name?: string; instructions?: string }; removedByUserId?: string;
    mcp: WorkerMcpSelection;
  }[];
  events: WorkerInvitationEvent[];
};
export type WorkerInvitationResult = { membership: WorkerMembershipSnapshot; catalog: WorkerCatalogSnapshot };
export type WorkerInvitations = {
  invite(actor: WorkerManagementActor, requestId: string, definitionIds: string[]): Promise<WorkerInvitationResult>;
};
export type ConversationWorkerBootstrap = {
  conversationKey: string; storeId: string; scope: RuntimeScope; input: CreateChatInput;
  catalog: WorkerCatalogSnapshot;
  initialAgentRevisions?: Record<string, number>;
  membership?: WorkerMembershipSnapshot;
  /** Retained attribution supplied by the authenticated backend, not a current ACL grant. */
  creator?: Person;
};
type WorkerBinding = {
  conversationKey: string; storeId: string; companyId: string; creationFingerprint: string;
  roomId?: string; sourceId: string; catalogRevision: number; catalogFingerprint: string;
};
const RuntimeModeDoc = defineDoc<{ mode?: "native" | "directory" | "conversation"; worker?: WorkerBinding }>({
  kind: "dispatch.runtime-mode", version: 1, scope: "session", initial: () => ({}),
});
const WorkerInvitationsDoc = defineDoc<{ rooms: Record<string, { revision: number; mcpSelections?: boolean; instances?: boolean; requests: Record<string, string>; events: WorkerInvitationEvent[] }> }>({
  kind: "dispatch.worker-invitations", version: 1, scope: "session", initial: () => ({ rooms: {} }),
});
const WorkerMembershipReceiptDoc = defineDoc<{ revision: number; fingerprint: string }>({
  kind: "dispatch.worker-membership-receipt", version: 1, scope: "session", initial: () => ({ revision: 0, fingerprint: "" }),
});
const WorkerSummaryReceiptDoc = defineDoc<{ revision: number; fingerprint: string }>({
  kind: "dispatch.worker-summary-receipt", version: 1, scope: "session", initial: () => ({ revision: 0, fingerprint: "" }),
});
const WorkerExportsDoc = defineDoc<{ sourceId?: string; companies: Record<string, { revision: number; fingerprint: string }> }>({
  kind: "dispatch.worker-catalog-exports", version: 1, scope: "session", initial: () => ({ companies: {} }),
});
type ManagementReceipt = {
  companyId: string; definitionId: string; revision: number; instanceId: string; participantId: string; roomId: string;
  workerStoreId?: string; conversationKey?: string;
  operationId: string; callId: string; fingerprint: string; targetId: string; beforeRevision: number; afterRevision: number;
  at: number; reason: string; evidence: string[]; fields: string[]; restoreRevision?: number; grantVersion: number;
};
const ManagementReceiptsDoc = defineDoc<{ receipts: ManagementReceipt[] }>({
  kind: "dispatch.agent-management-receipts", version: 1, scope: "session", initial: () => ({ receipts: [] }),
});
type BundleImportReceipt = {
  companyId: string; userId: string; requestId: string; fingerprint: string;
  packageId: string; packageVersion: string; importedAt: number; result: { agents: { key: string; id: string }[]; skills: { key: string; id: string }[] };
};
const BundleImportsDoc = defineDoc<{ imports: BundleImportReceipt[] }>({
  kind: "dispatch.bundle-imports", version: 1, scope: "session", initial: () => ({ imports: [] }),
});
type TrackedBundleEntry = { key: string; id: string; revision: number; baseline: string; upstream: string; present: boolean };
type TrackedBundle = GitHubInstallation & { companyId: string; agents: TrackedBundleEntry[]; skills: TrackedBundleEntry[] };
type SavedGitHubPreview = {
  id: string; companyId: string; userId: string; expiresAt: number; preview: string; expectedInstallationRevision: number;
  expectedAgents: { id: string; revision: number }[]; expectedSkills: { id: string; revision: number }[];
  agents: StoredAgent[]; skills: StoredSkill[]; next: TrackedBundle;
};
type GitHubReceipt = { companyId: string; userId: string; requestId: string; previewId: string; result: GitHubBundleApplyResult };
const GitHubBundlesDoc = defineDoc<{ installations: TrackedBundle[]; previews: SavedGitHubPreview[]; receipts: GitHubReceipt[] }>({
  kind: "dispatch.github-bundles", version: 1, scope: "session", initial: () => ({ installations: [], previews: [], receipts: [] }),
});
const CatalogDoc = defineDoc<Catalog>({
  kind: "dispatch.catalog", version: 1, scope: "session",
  initial: () => ({ chats: [], agents: [] }),
});

export class RuntimeError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type RuntimeOptions = {
  stateDir: string;
  piStorage?: PiStorageConfig;
  workspaceDir: string;
  readAllProjectUserIds?: string[];
  companyId: string;
  connectionsFile?: string;
  mcpConnections?: McpConnections;
  provider?: string;
  modelId?: string;
  thinkingLevel?: AgentDraft["thinkingLevel"];
  models?: Models;
  settings?: HarnessSettings;
  peopleDirectory?: PeopleDirectory;
  /** Backend catalog/directory store only: no agent construction and no scheduler resume. */
  directoryOnly?: boolean;
  connectMcpOnOpen?: boolean;
  runMcpBackground?: <T>(operation: () => Promise<T>) => Promise<T>;
  workerManagement?: WorkerManagement;
  workerSecrets?: (actor: WorkerManagementActor, secretId?: string, signal?: AbortSignal) => Promise<{ secrets: { id: string; name: string }[] } | { value: string }>;
  workerSearch?: (actor: WorkerManagementActor, query: Parameters<import("./web/types.js").WebBackend["search"]>[0], signal?: AbortSignal) => ReturnType<import("./web/types.js").WebBackend["search"]>;
  workerMcp?: WorkerMcp;
  workerInvitations?: WorkerInvitations;
  workerProjectSpec?: (actor: WorkerManagementActor, input: ProjectSpecReadInput) => Promise<ProjectSpecPage>;
  workerProjectChats?: {
    list(actor: WorkerManagementActor, input: ProjectChatsInput): Promise<ProjectChatsResult>;
    read(actor: WorkerManagementActor, input: ProjectChatReadInput): Promise<ProjectChatResult>;
  };
  workerParticipants?: { report(report: WorkerParticipantReport): Promise<unknown> };
  /** Workers must inject durable remote blob storage; native installations keep their local default. */
  attachmentStore?: AttachmentStore;
  projectArchiveStore?: Pick<ProjectArchiveStore, "save" | "read">;
};

/** Authentication supplies the scope; Pi remains the only owner of transcripts and work. */
export class DispatchRuntime {
  private harness: Harness;
  private models: Models;
  private registry: Registry;
  private owner: Awaited<ReturnType<typeof acquireRuntimeOwner>>;
  private commitRevision = 0;
  private closed = false;
  private upgradeDrain?: Promise<void>;
  private upgradeCatalogDirty = false;
  private upgradeRooms = new Set<ConversationId>();
  private pendingUpgradeRooms = new Map<ConversationId, ConversationId>();
  private unsubscribeUpgrades?: () => void;
  private shared: SharedConversations;
  private peopleDirectory?: PeopleDirectory;
  private connections: AgentConnections;
  private managed?: McpConnections;
  private readAllProjectUserIds = new Set<string>();
  private directoryOnly = false;
  private worker?: ConversationWorkerBootstrap;
  private workerManagement?: WorkerManagement;
  private workerMcp?: WorkerMcp;
  private workerParticipants?: RuntimeOptions["workerParticipants"];
  private participantReportDrain?: Promise<void>;
  private participantReportDirty = false;
  private boundRoomId?: string;
  private archiveStorage?: Pick<ProjectArchiveStore, "save" | "read">;
  private membershipTail: Promise<unknown> = Promise.resolve();

  private constructor(harness: Harness, private readonly storage: Storage, models: Models, owner: Awaited<ReturnType<typeof acquireRuntimeOwner>>, registry: Registry, shared: SharedConversations, connections: AgentConnections, private readonly workspaceDir: string, private readonly attachments: AttachmentStore, peopleDirectory?: PeopleDirectory) {
    this.connections = connections;
    this.shared = shared;
    this.peopleDirectory = peopleDirectory;
    shared.bind(harness, storage);
    shared.beforeDelivery = (tx, roomId, companyId, member) => this.upgradeParticipant(tx, roomId, companyId, member);
    shared.availableAgents = async companyId => (await this.listAgents({ companyId, userId: "" })).filter(agent => !agent.archived).map(({id,name,description}) => ({id,name,description}));
    this.harness = harness;
    this.models = models;
    this.registry = registry;
    this.owner = owner;
    harness.subscribeCommits((publication) => { this.commitRevision = publication.seq; });
  }

  static open(options: RuntimeOptions) { return this.openInternal(options); }

  static openConversation(options: RuntimeOptions, bootstrap: ConversationWorkerBootstrap) {
    if (options.directoryOnly) throw new RuntimeError(400, "A worker cannot be a directory runtime.");
    if (!bootstrap.membership || !options.workerParticipants) throw new RuntimeError(400, "Workers require membership authority and participant reporting.");
    if (!options.attachmentStore) throw new RuntimeError(400, "Workers require an explicitly supplied durable attachment store.");
    if (options.piStorage?.kind !== "postgres" || options.piStorage.access !== "worker" || options.piStorage.storeId !== bootstrap.storeId)
      throw new RuntimeError(400, "Conversation workers require their bound PostgreSQL store.");
    if (options.companyId !== bootstrap.scope.companyId || bootstrap.catalog.companyId !== options.companyId)
      throw new RuntimeError(400, "Worker company identity mismatch.");
    requireText(bootstrap.conversationKey, "Conversation key", 200);
    requireText(bootstrap.storeId, "Store ID", 200);
    return this.openInternal(options, detached(bootstrap));
  }

  private static async openInternal(options: RuntimeOptions, worker?: ConversationWorkerBootstrap) {
    if (!(await stat(options.workspaceDir)).isDirectory()) throw new Error("DISPATCH_WORKSPACE_DIR must point to an existing directory.");
    const owner = await acquireRuntimeOwner(options.stateDir);
    let storage: Storage | undefined;
    let connections: AgentConnections | undefined;
    let openedHarness: Harness | undefined;
    try {
      options.mcpConnections?.initialize();
      const models = withSharedContextCache(options.models ?? productionModels());
      storage = await openPiStorage(owner.directory, options.piStorage ?? { kind: "sqlite" });
      const registry = createRegistry();
      let runtime: DispatchRuntime;
      const attachments = options.attachmentStore ?? new AttachmentStore(join(owner.directory, "attachments"));
      const shared = new SharedConversations((tx, roomId, companyId, definitionId, revision) => runtime.createParticipant(tx, roomId, companyId, definitionId, revision), attachments, {
        read: (tx, instance, input) => runtime.readManagedAgent(tx, instance, input),
        save: (tx, instance, callId, input) => runtime.saveManagedAgent(tx, instance, callId, input),
      });
      registry.install(worker ? { ...shared.extension, sections: [...shared.extension.sections ?? [], workerWorkspaceSection] } : shared.extension);
      registry.install(shared.definitionOfDoneExtension);
      registry.install(CodingTools);
      registry.install(Coding);
      registry.install(Skills);
      const authorizeWeb = async (instanceId: ConversationId, capability: "web-reading" | "web-search", signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const authorized = await runtime.harness.commit(async tx => {
          const actor = await shared.managementActor(tx, instanceId);
          const catalog = await tx.doc(CatalogDoc);
          const definition = latestAgent(catalog, actor.companyId, actor.definitionId);
          if (!definition || definition.archived || !agentCapabilities(definition).includes(capability)) return undefined;
          return { companyId: actor.companyId, definitionId: actor.definitionId,
            remote: worker && capability === "web-search" ? await runtime.remoteActor(tx, actor) : undefined };
        }, context);
        signal?.throwIfAborted();
        return authorized;
      };
      const secretAccess = async (instanceId: ConversationId, secretId?: string, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const actor = await runtime.harness.commit(async tx => {
          const actor = await shared.managementActor(tx, instanceId);
          const definition = latestAgent(await tx.doc(CatalogDoc), actor.companyId, actor.definitionId);
          if (!definition || definition.archived || !agentCapabilities(definition).includes("files-and-commands")) throw new RuntimeError(403, "Secret tools are not authorized.");
          return { companyId: actor.companyId, definitionId: actor.definitionId, remote: worker ? await runtime.remoteActor(tx, actor) : undefined };
        }, context);
        signal?.throwIfAborted();
        if (worker) {
          if (!options.workerSecrets || !actor.remote) throw new RuntimeError(503, "Secret mediation unavailable.");
          return options.workerSecrets(actor.remote, secretId, signal);
        }
        if (!options.mcpConnections) throw new RuntimeError(503, "Secret storage unavailable.");
        return secretId ? { value: await options.mcpConnections.resolveNamedSecret(actor.companyId, actor.definitionId, secretId) }
          : { secrets: await options.mcpConnections.grantedNamedSecrets(actor.companyId, actor.definitionId) };
      };
      registry.install(createAgentSecrets({
        list: async (instanceId, signal) => {
          const result = await secretAccess(instanceId, undefined, signal);
          if (!("secrets" in result)) throw new RuntimeError(503, "Secret list unavailable.");
          return result.secrets;
        },
        resolve: async (instanceId, id, signal) => {
          const result = await secretAccess(instanceId, id, signal);
          if (!("value" in result)) throw new RuntimeError(503, "Secret unavailable.");
          return result.value;
        },
      }));
      const web = createWebResearch(createWebBackend(), {
        authorize: async (instanceId, capability, signal) => Boolean(await authorizeWeb(instanceId, capability, signal)),
        search: async (instanceId, query, signal) => {
          const authorized = await authorizeWeb(instanceId, "web-search", signal);
          if (worker && authorized) {
            if (!options.workerSearch || !authorized.remote) throw new RuntimeError(503, "Search mediation unavailable.");
            return options.workerSearch(authorized.remote, query, signal);
          }
          const key = authorized ? await options.mcpConnections?.resolveSearchSecret(authorized.companyId, authorized.definitionId) : undefined;
          return createWebBackend({ searchApiKey: key }).search(query, signal);
        },
      });
      registry.install(web.reading);
      registry.install(web.search);
      registry.install(web.legacy);
      registry.install(createImageGen(models));
      connections = await AgentConnections.load(options.connectionsFile ?? join(owner.directory, "agent-connections.json"), registry, options.mcpConnections, options.companyId);
      const harness = await Harness.open(storage, {
        models, registry, settings: { ...options.settings, extensions: options.settings?.extensions ?? [shared.extension, CodingTools, Coding] },
        env: async ({ cwd }) => {
          if (!cwd) return undefined;
          if (!(await stat(cwd)).isDirectory()) throw new Error("Agent workspace must be an existing directory.");
          // A local working directory organizes files; it is not a filesystem or process sandbox.
          return new NodeExecutionEnv({ cwd });
        },
      }, context);
      openedHarness = harness;
      runtime = new DispatchRuntime(harness, storage, models, owner, registry, shared, connections, options.workspaceDir, attachments, options.peopleDirectory);
      runtime.managed = options.mcpConnections;
      runtime.directoryOnly = options.directoryOnly ?? false;
      runtime.worker = worker;
      runtime.workerManagement = options.workerManagement;
      runtime.workerMcp = options.workerMcp;
      runtime.workerParticipants = options.workerParticipants;
      shared.readProjectSpec = async (instanceId, input) => {
        if (worker) {
          if (!options.workerProjectSpec) throw new RuntimeError(503, "Project spec mediation is unavailable.");
          const actor = await harness.commit(async tx => runtime.remoteActor(tx, await shared.managementActor(tx, instanceId)), context);
          return options.workerProjectSpec(actor, input);
        }
        return harness.commit(async tx => {
          const actor = await shared.managementActor(tx, instanceId);
          const room = await tx.doc(SharedDoc, actor.roomId);
          return projectMarkdownPage(tx, actor.companyId, room.sharedProjectId, input);
        }, context);
      };
      shared.listProjectChats = async (instanceId, input) => {
        if (worker) {
          if (!options.workerProjectChats) throw new RuntimeError(503, "Project chat mediation is unavailable.");
          const actor = await harness.commit(async tx => runtime.remoteActor(tx, await shared.managementActor(tx, instanceId)), context);
          return options.workerProjectChats.list(actor, input);
        }
        return harness.commit(async tx => runtime.projectChatsIn(tx, await shared.managementActor(tx, instanceId), input), context);
      };
      shared.readProjectChat = async (instanceId, input) => {
        if (worker) {
          if (!options.workerProjectChats) throw new RuntimeError(503, "Project chat mediation is unavailable.");
          const actor = await harness.commit(async tx => runtime.remoteActor(tx, await shared.managementActor(tx, instanceId)), context);
          return options.workerProjectChats.read(actor, input);
        }
        return harness.commit(async tx => {
          const actor = await shared.managementActor(tx, instanceId);
          const metadata = await runtime.projectChatIn(tx, actor, input.chatId);
          const roomId = nativeId(input.chatId);
          if (!await tx.conversation(roomId)) throw new RuntimeError(503, "Chat history is unavailable.");
          return readProjectChat({ room: await tx.doc(SharedDoc, roomId),
            entries: async id => { const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
              do { const page = await tx.scanEntries({ conversationId: id }, 200, cursor); entries.push(...page.items); cursor = page.next; } while (cursor);
              return entries.reverse(); },
            live: id => tx.doc(LiveDoc, id), attachments: async () => (await tx.doc(AttachmentsDoc, roomId)).records,
            bytes: attachment => attachments.read(attachment),
          }, roomId, metadata, input);
        }, context);
      };
      if (worker) shared.onParticipantStateChanged = tx => runtime.updateWorkerParticipantReport(tx);
      if (worker) shared.inviteRemote = async (instanceId, requestId, definitionIds) => {
        if (!options.workerInvitations) throw new RuntimeError(503, "Backend invitation service is unavailable.");
        const actor = await harness.commit(async tx => runtime.remoteActor(tx, await shared.managementActor(tx, instanceId)), context);
        const result = await options.workerInvitations.invite(actor, requestId, definitionIds);
        // The backend never calls back into this worker; do not hold a Pi transaction over the RPC.
        await runtime.applyWorkerCatalog(result.catalog);
        await runtime.applyWorkerMembership(result.membership);
      };
      runtime.archiveStorage = options.projectArchiveStore;
      runtime.readAllProjectUserIds = new Set(options.readAllProjectUserIds ?? []);
      await runtime.bindRuntimeMode();
      if (worker) {
        await runtime.applyWorkerCatalog(worker.catalog);
        if (options.runMcpBackground) connections.runBackground = options.runMcpBackground;
        await connections.open(harness, options.connectMcpOnOpen);
        const reopenedRoom = Boolean((await harness.snapshot(RuntimeModeDoc, context))?.worker?.roomId);
        if (worker.membership) await runtime.prepareWorkerMcp(worker.membership);
        runtime.boundRoomId = await runtime.createChatRecord(worker.scope, worker.input);
        // No whole-installation migrations or catalog revisions generated by worker discovery.
        // The stable workspace path must be identical after replacement; its bytes are disposable.
        if (worker.membership) await runtime.applyWorkerMembership(worker.membership);
        await runtime.verifyWorkerWorkspace();
        await prepareWorkerWorkspace(harness, owner.directory, reopenedRoom);
        await runtime.initializePublicSummaries();
        await runtime.reconcileUpgrades();
        if (!runtime.workerParticipants) throw new RuntimeError(503, "Worker participant reporting is unavailable.");
        await runtime.workerParticipants.report(await runtime.workerParticipantReport());
        runtime.unsubscribeUpgrades = harness.subscribeCommits(publication => {
          runtime.queueUpgrades(publication);
          if (publication.changes.some(change => (change.type === "document" || change.type === "document.copy")
            && change.record.kind === WorkerIdentityDoc.definition.kind)) runtime.queueParticipantReport();
        });
        harness.resume();
        return runtime;
      }
      // Seed once and publish a real commit before recovery so snapshots use Pi's persisted sequence.
      await harness.commit(async (tx) => {
        const catalog = await tx.doc(CatalogDoc);
        const now = Date.now();
        const retired = latestAgent(catalog, options.companyId, "default");
        const developer = latestAgent(catalog, options.companyId, DEFAULT_AGENT_ID);
        if (!developer) {
          const agent: StoredAgent = {
            id: DEFAULT_AGENT_ID, companyId: options.companyId, name: "Developer",
            description: "Builds, debugs, and improves software in a coding workspace.",
            instructions: "Inspect the project and its instructions before changing code. Make focused changes, preserve existing work, and explain what changed and how it was checked. Be clear about anything you could not verify.",
            provider: retired?.provider ?? options.provider ?? "openai",
            modelId: retired?.modelId ?? options.modelId ?? "gpt-6-sol",
            thinkingLevel: retired?.thinkingLevel ?? options.thinkingLevel ?? "off",
            extensions: [Coding.name, CodingTools.name], tools: ["read", "write", "edit", "bash"],
            revision: 1, archived: false, createdAt: now, updatedAt: now,
          };
          runtime.validateAgent(agent);
          catalog.agents.push(agent);
        } else if (developer.archived) {
          catalog.agents.push({ ...developer, archived: false, revision: developer.revision + 1, updatedAt: now });
        }
        // Retain historical revisions and instances; only new selections change.
        if (retired && !retired.archived) {
          catalog.agents.push({ ...retired, archived: true, revision: retired.revision + 1, updatedAt: now });
        }
        const projects = await tx.doc(ProjectsDoc);
        for (const project of Object.values(projects.projects)) {
          if (project.companyId !== options.companyId || !project.defaultAgentDefinitionIds.includes("default")) continue;
          project.defaultAgentDefinitionIds = [...new Set(project.defaultAgentDefinitionIds.map(id => id === "default" ? DEFAULT_AGENT_ID : id))];
          project.revision += 1;
          project.updatedAt = now;
        }
        catalog.skills ??= [];
        if (!catalog.skills.some(skill => skill.companyId === options.companyId && skill.id === IMAGE_GENERATION_SKILL_ID)) {
          const now = Date.now();
          catalog.skills.push({
            ...imageGenerationSkill, id: IMAGE_GENERATION_SKILL_ID, companyId: options.companyId,
            revision: 1, createdAt: now, updatedAt: now, savedBy: "system",
            requestId: "seed:image-generation", fingerprint: "seed:image-generation:1",
          });
        }
        for (const seed of [
          { id: "f0f71a7c-2268-4b27-80ec-837c76845592", key: "agent-browser", content: agentBrowserSkill },
          { id: "e0ae224c-e456-48ca-9575-6391bb39918e", key: "agent-browser-dogfood", content: dogfoodSkill },
        ]) {
          if (catalog.skills.some(skill => skill.companyId === options.companyId && skill.id === seed.id)) continue;
          const now = Date.now();
          catalog.skills.push({
            ...seed.content, id: seed.id, companyId: options.companyId,
            revision: 1, createdAt: now, updatedAt: now, savedBy: "system",
            requestId: `seed:${seed.key}`, fingerprint: `seed:${seed.key}:1`,
          });
        }
        catalog.runtimeInstance = randomUUID();
      }, context);
      // Append revisions rather than rewriting historical definitions or native snapshots.
      await runtime.harness.commit(async tx => {
        const catalog = await tx.doc(CatalogDoc);
        const selection = capabilitySelection(["web-reading", "web-search"]);
        for (const agent of latestAgents(catalog, options.companyId).values()) {
          if (!agent.extensions?.includes("dispatch-web")) continue;
          catalog.agents.push({ ...agent,
            extensions: [...new Set([...agent.extensions.filter(name => name !== "dispatch-web"), ...selection.extensions])],
            tools: [...new Set([...(agent.tools ?? []).filter(name => name !== "web_run"), ...selection.tools])],
            revision: agent.revision + 1, updatedAt: Date.now(),
          });
        }
      }, context);
      await runtime.harness.commit(async tx => {
        const catalog = await tx.doc(CatalogDoc);
        for (const agent of latestAgents(catalog, options.companyId).values()) {
          if (!agent.extensions?.includes(CodingTools.name) || agent.extensions.includes("dispatch-agent-secrets")) continue;
          catalog.agents.push({ ...agent, extensions: [...agent.extensions, "dispatch-agent-secrets"],
            tools: [...new Set([...(agent.tools ?? []), "secrets_list", "git_clone"])],
            revision: agent.revision + 1, updatedAt: Date.now() });
        }
      }, context);
      if (!runtime.directoryOnly) {
        await runtime.migrateChats();
        await runtime.initializePublicSummaries();
        await runtime.migrateWorkspaces(options.companyId);
      }
      if (options.runMcpBackground) connections.runBackground = options.runMcpBackground;
      await connections.open(harness, options.connectMcpOnOpen);
      await runtime.configureConnections(options.companyId);
      connections.onChanged = () => runtime.configureConnections(options.companyId);
      if (!runtime.directoryOnly) {
        await runtime.reconcileUpgrades();
        runtime.unsubscribeUpgrades = harness.subscribeCommits(publication => runtime.queueUpgrades(publication));
        harness.resume();
      }
      return runtime;
    } catch (error) {
      try { if (openedHarness) await openedHarness.close(context); else await storage?.close(context); }
      finally { try { await connections?.close(); } finally { owner.release(); } }
      throw error;
    }
  }

  private async bindRuntimeMode() {
    await this.harness.commit(async tx => {
      const state = await tx.doc(RuntimeModeDoc);
      const mode = this.worker ? "conversation" : this.directoryOnly ? "directory" : "native";
      if (state.mode && state.mode !== mode) throw new RuntimeError(409, "This store belongs to another runtime mode; implicit migration is not supported.");
      if (!state.mode && mode !== "native") {
        const catalog = await tx.doc(CatalogDoc);
        if (catalog.chats.length || catalog.agents.length || (await tx.scanConversations({}, 1)).items.length || (await tx.scanTasks({}, 1)).items.length)
          throw new RuntimeError(409, "Split runtime initialization requires a new, empty store.");
      }
      state.mode = mode;
      if (this.directoryOnly && (await tx.scanTasks({}, 1)).items.length)
        throw new RuntimeError(409, "A directory runtime cannot own execution tasks.");
      if (!this.worker) return;
      const worker = this.worker;
      const creationFingerprint = fingerprint([worker.scope, worker.input]);
      if (state.worker) {
        if (state.worker.conversationKey !== worker.conversationKey || state.worker.storeId !== worker.storeId
          || state.worker.companyId !== worker.scope.companyId || state.worker.creationFingerprint !== creationFingerprint)
          throw new RuntimeError(409, "Worker store/bootstrap binding conflict.");
      } else {
        state.worker = { conversationKey: worker.conversationKey, storeId: worker.storeId, companyId: worker.scope.companyId,
          creationFingerprint, sourceId: worker.catalog.sourceId, catalogRevision: 0, catalogFingerprint: "" };
      }
      this.boundRoomId = state.worker.roomId;
    }, context);
  }

  /** Backend-owned export receipt. Revision advances durably whenever the exported projection changes,
   * including grant/project/connection changes; it is not a volatile subscription sequence.
   */
  async exportWorkerCatalog(companyId: string): Promise<WorkerCatalogSnapshot> {
    this.requireCatalogOwner();
    requireText(companyId, "Company ID", 200);
    return this.harness.commit(tx => this.workerCatalog(tx, companyId), context);
  }

  private async workerCatalog(tx: Tx, companyId: string): Promise<WorkerCatalogSnapshot> {
    const catalog = await tx.doc(CatalogDoc);
    const shared = await tx.doc(ProjectsDoc);
    const exports = await tx.doc(WorkerExportsDoc);
    exports.sourceId ??= randomUUID();
    const agentIds = new Set(catalog.agents.filter(agent => agent.companyId === companyId).map(agent => agent.id));
    const payload = detached({
      sourceId: exports.sourceId, companyId,
      agents: catalog.agents.filter(agent => agent.companyId === companyId).map(publicAgent),
      skills: (catalog.skills ?? []).filter(skill => skill.companyId === companyId).map(publicSkill),
      projects: [],
      sharedProjects: Object.values(shared.projects).filter(project => project.companyId === companyId),
      grants: await readGrants(tx, companyId),
      connectionOwners: Object.fromEntries(Object.entries(catalog.connectionOwners ?? {}).filter(([, agentId]) => agentIds.has(agentId))),
      readAllProjectUserIds: [...this.readAllProjectUserIds].sort(),
    });
    const hash = fingerprint(payload);
    const prior = exports.companies[companyId];
    if (!prior || prior.fingerprint !== hash) exports.companies[companyId] = { revision: (prior?.revision ?? 0) + 1, fingerprint: hash };
    return { ...payload, revision: exports.companies[companyId].revision };
  }

  /** Internal route-bound read: the backend authenticates the current launch attempt first.
   * One transaction pins catalog history, membership and creation attribution together.
   * Never authorize recovery as the original creator, who may since have lost project access.
   */
  async directoryWorkerBootstrap(companyId: string, conversationKey: string) {
    if (!this.directoryOnly) throw new RuntimeError(409, "Not a directory runtime.");
    return this.harness.commit(async tx => {
      const chat = (await tx.doc(CatalogDoc)).chats.find(chat => chat.companyId === companyId && chat.id === conversationKey);
      if (!chat) throw new RuntimeError(404, "Conversation not found.");
      const room = await tx.doc(SharedDoc, nativeId(conversationKey));
      if (room.companyId !== companyId) throw new RuntimeError(404, "Conversation not found.");
      const human = room.members.find(member => member.kind === "human" && member.userId === chat.userId);
      if (!human) throw new RuntimeError(409, "Conversation creation attribution is unavailable.");
      const membership = await this.workerMembership(tx, conversationKey);
      return { catalog: await this.workerCatalog(tx, companyId), membership,
        initialAgentRevisions: Object.fromEntries([...membership.agents].reverse().map(agent => [agent.definitionId, agent.revision])),
        creator: { id: human.userId!, name: human.name } };
    }, context);
  }

  /** Call only with an authenticated backend projection. A receipt is committed with the projection.
   * Membership/grant snapshots are not an independent authority for cross-store management saves.
   */
  async applyWorkerCatalog(input: WorkerCatalogSnapshot) {
    if (!this.worker) throw new RuntimeError(409, "Only conversation workers accept catalog projections.");
    const snapshot = detached(input);
    requireText(snapshot.sourceId, "Catalog source ID", 200);
    if (snapshot.companyId !== this.worker.scope.companyId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1)
      throw new RuntimeError(409, "Worker catalog identity/revision mismatch.");
    if (snapshot.projects.length !== 0
      || snapshot.sharedProjects.some(project => project.companyId !== snapshot.companyId)
      || snapshot.grants.some(grant => grant.companyId !== snapshot.companyId))
      throw new RuntimeError(409, "Worker catalog contains another company's state.");
    const hash = fingerprint(snapshot);
    const receipt = await this.harness.commit(async tx => {
      const binding = (await tx.doc(RuntimeModeDoc)).worker!;
      if (binding.sourceId !== snapshot.sourceId || snapshot.revision < binding.catalogRevision)
        throw new RuntimeError(409, "Stale or unrelated worker catalog.");
      if (snapshot.revision === binding.catalogRevision && binding.catalogFingerprint !== hash)
        throw new RuntimeError(409, "Catalog revision was reused with different content.");
      if (snapshot.revision > binding.catalogRevision) {
        const catalog = await tx.doc(CatalogDoc);
        catalog.agents = snapshot.agents.map(agent => ({ ...agent, companyId: snapshot.companyId }));
        catalog.skills = snapshot.skills.map(skill => ({ ...skill, companyId: snapshot.companyId, savedBy: "backend",
          requestId: `projection:${skill.id}:${skill.revision}`, fingerprint: "backend-projection" }));
        catalog.connectionOwners = snapshot.connectionOwners;
        const shared = await tx.doc(ProjectsDoc);
        shared.projects = Object.fromEntries(snapshot.sharedProjects.map(project => [project.id, project]));
        // Workers never write project-administration request receipts or management grants.
        binding.catalogRevision = snapshot.revision;
        binding.catalogFingerprint = hash;
      }
      return { sourceId: binding.sourceId, revision: binding.catalogRevision, fingerprint: binding.catalogFingerprint };
    }, context);
    this.readAllProjectUserIds = new Set(snapshot.readAllProjectUserIds);
    return receipt;
  }

  async workerBinding() {
    if (!this.worker) throw new RuntimeError(409, "Not a conversation worker.");
    const binding = (await this.harness.snapshot(RuntimeModeDoc, context))?.worker;
    if (!binding?.roomId) throw new RuntimeError(503, "Worker bootstrap is incomplete.");
    return detached({ conversationKey: binding.conversationKey, storeId: binding.storeId, companyId: binding.companyId,
      roomId: binding.roomId, sourceId: binding.sourceId, catalogRevision: binding.catalogRevision,
      workspace: await this.harness.snapshot(WorkerWorkspaceDoc, context) });
  }

  /** Directory metadata only. Preserve resolved creation choices when the backend persists routing. */
  async directoryChatBootstrap(scope: RuntimeScope, id: string) {
    if (!this.directoryOnly) throw new RuntimeError(409, "Not a directory runtime.");
    return this.harness.commit(async tx => {
      const room = await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      const chat = (await tx.doc(CatalogDoc)).chats.find(item => item.id === id && item.companyId === scope.companyId);
      if (!chat) throw new RuntimeError(404, "Conversation not found.");
      return detached({ scope: { companyId: chat.companyId, userId: chat.userId }, input: {
        requestId: chat.requestId, ...(chat.creationTitleExplicit ? { title: chat.title } : {}),
        agentDefinitionIds: chat.creationAgentIds ?? [chat.agentDefinitionId],
        ...(room.sharedProjectId ? { sharedProjectId: room.sharedProjectId } : {}),
      } satisfies CreateChatInput });
    }, context);
  }

  /** RPC caller must first authenticate and bind the actor's store/key to the current launcher attempt.
   * Never call the worker back from this backend transaction: the worker awaits it on its own commit line.
   */
  async readWorkerManagedAgent(actor: WorkerManagementActor, raw: unknown) {
    this.requireDirectoryActor(actor);
    return this.harness.commit(async tx => this.readManagedActor(tx, await this.authoritativeWorkerActor(tx, actor), managementReadSchema.parse(raw)), context);
  }

  async saveWorkerManagedAgent(actor: WorkerManagementActor, callId: string, raw: unknown) {
    this.requireDirectoryActor(actor);
    requireText(callId, "Tool call ID", 200);
    return this.harness.commit(async tx => this.saveManagedActor(tx, await this.authoritativeWorkerActor(tx, actor), callId, managementSaveSchema.parse(raw)), context);
  }

  async directoryWorkerMembership(scope: RuntimeScope, id: string): Promise<WorkerMembershipSnapshot> {
    if (!this.directoryOnly) throw new RuntimeError(409, "Not a directory runtime.");
    return this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      return this.workerMembership(tx, id);
    }, context);
  }

  /** Commit backend intent first. The next authenticated RPC/bootstrap reconciles worker membership
   * even if the response is lost or the worker disappears before applying it.
   */
  async inviteWorkerParticipants(scope: RuntimeScope, id: string, input: AddParticipantsInput): Promise<WorkerInvitationResult> {
    if (!this.directoryOnly) throw new RuntimeError(409, "Not a directory runtime.");
    const people = await Promise.all([...new Set([scope.userId, ...input.userIds ?? []])].map(userId => this.person(scope.companyId, userId)));
    return this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      const membership = await this.admitWorkerInvitation(tx, id, scope.companyId, { userId: scope.userId }, input, people);
      return { membership, catalog: await this.workerCatalog(tx, scope.companyId) };
    }, context);
  }

  async inviteWorkerAgents(claim: WorkerManagementActor, requestId: string, definitionIds: string[]): Promise<WorkerInvitationResult> {
    this.requireDirectoryActor(claim);
    return this.harness.commit(async tx => {
      const actor = await this.authoritativeWorkerActor(tx, claim);
      const membership = await this.admitWorkerInvitation(tx, claim.conversationKey, actor.companyId, { definitionId: actor.definitionId, actorId: actor.participantId },
        { requestId, agentDefinitionIds: definitionIds }, []);
      return { membership, catalog: await this.workerCatalog(tx, claim.companyId) };
    }, context);
  }

  async admitWorkerInstance(scope: RuntimeScope, id: string, input: CreateAgentInstanceInput) {
    if (!this.directoryOnly) throw new RuntimeError(409, "Not a directory runtime.");
    requireText(input.requestId, "Request ID", 200);
    requireText(input.agentDefinitionId, "Agent ID", 200);
    if (input.name !== undefined) requireText(input.name, "Instance name", 100, true);
    if (input.instructions !== undefined) requireText(input.instructions, "Instance instructions", 50_000, true);
    const person = await this.person(scope.companyId, scope.userId);
    return this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      await this.shared.ensureHuman(tx, nativeId(id), person);
      await this.workerMembership(tx, id);
      const journal = (await tx.doc(WorkerInstancesDoc)).rooms[id] ??= { requests: {} };
      const key = JSON.stringify([scope.userId, input.requestId]);
      const name = input.name?.trim() || undefined;
      const hash = fingerprint([input.agentDefinitionId, name ?? "", input.instructions ?? ""]);
      const prior = journal.requests[key];
      if (prior && prior.fingerprint !== hash) throw requestConflict();
      let actorId = prior?.actorId;
      if (!actorId) {
        const actors = (await tx.doc(WorkerActorsDoc)).actors[id];
        if (actors.some(actor => actor.definitionId === input.agentDefinitionId && actor.membership === "removing"))
          throw new RuntimeError(409, "Agent removal is still pending. Retry after cleanup finishes.");
        const definition = this.findAgent(await tx.doc(CatalogDoc), scope, input.agentDefinitionId);
        this.validateAgent(definition);
        const identity = await tx.createConversation({ ownership: { kind: "ownerless" } });
        actorId = randomUUID();
        actors.push({ companyId: scope.companyId, definitionId: definition.id, revision: definition.revision,
          instanceId: identity.id, participantId: actorId, roomId: nativeId(id), configuration: detached(publicAgent(definition)),
          legacy: false, membership: "active", creation: { ...(name ? { name } : {}), ...(input.instructions ? { instructions: input.instructions } : {}) } });
        journal.requests[key] = { fingerprint: hash, actorId };
        const invitations = (await tx.doc(WorkerInvitationsDoc)).rooms[id];
        invitations.revision++;
        invitations.events.push({ revision: invitations.revision, authorUserId: scope.userId, names: [name ?? definition.name], at: Date.now() });
      }
      return { actorId, membership: await this.workerMembership(tx, id), catalog: await this.workerCatalog(tx, scope.companyId) };
    }, context);
  }

  async removeWorkerParticipant(scope: RuntimeScope, id: string, participantId: string) {
    if (!this.directoryOnly) throw new RuntimeError(409, "Not a directory runtime.");
    requireText(participantId, "Participant ID", 200);
    const person = await this.person(scope.companyId, scope.userId);
    return this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      const room = await tx.doc(SharedDoc, nativeId(id));
      const knownHuman = room.members.some(member => member.kind === "human" && member.userId === person.id);
      await this.shared.ensureHuman(tx, nativeId(id), person);
      if (!knownHuman) (await tx.doc(WorkerInvitationsDoc)).rooms[id].revision++;
      await this.workerMembership(tx, id);
      const actor = (await tx.doc(WorkerActorsDoc)).actors[id].find(actor => actor.worker?.participantId === participantId
        || (!actor.legacy && actor.participantId === participantId));
      if (!actor) throw new RuntimeError(404, "Agent participant not found.");
      if (actor.membership === "active") {
        actor.membership = "removing";
        actor.removedByUserId = scope.userId;
        (await tx.doc(WorkerInvitationsDoc)).rooms[id].revision++;
      }
      return { membership: await this.workerMembership(tx, id), catalog: await this.workerCatalog(tx, scope.companyId) };
    }, context);
  }

  async workerInstanceResult(scope: RuntimeScope, id: string, actorId: string): Promise<CreateAgentInstanceResult> {
    this.requireWorkerRoom(scope, id);
    if (!this.worker) throw new RuntimeError(409, "Not a conversation worker.");
    const createdParticipantId = await this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      const mapping = (await tx.doc(WorkerIdentityDoc)).mappings[actorId];
      if (!mapping) throw new RuntimeError(409, "Worker instance has not been reconciled.");
      return mapping.participantId;
    }, context);
    return { ...await this.getChat(scope, id), createdParticipantId };
  }

  /** Report only native state already committed with its identity/adoption/removal transition. */
  async workerParticipantReport(): Promise<WorkerParticipantReport> {
    if (!this.worker) throw new RuntimeError(409, "Not a conversation worker.");
    const report = (await this.harness.snapshot(WorkerIdentityDoc, context))?.report;
    if (!report) throw new RuntimeError(503, "Worker participant report is unavailable.");
    return detached(report);
  }

  private async updateWorkerParticipantReport(tx: Tx) {
    if (!this.worker || !this.boundRoomId) return;
    const identities = await tx.doc(WorkerIdentityDoc);
    const room = await tx.doc(SharedDoc, nativeId(this.boundRoomId));
    const membership = await tx.doc(WorkerMembershipReceiptDoc);
    if (!membership.revision) return;
    const agents = Object.entries(identities.mappings).map(([actorId, mapping]) => {
      const member = room.members.find(member => member.id === mapping.participantId);
      if (!member?.conversationId || String(member.conversationId) !== mapping.instanceId || !member.agentDefinitionId || !member.agentRevision)
        throw new RuntimeError(409, "Worker participant mapping conflicts with native state.");
      return { actorId, participantId: mapping.participantId, instanceId: mapping.instanceId, definitionId: member.agentDefinitionId, appliedRevision: member.agentRevision,
        membership: member.membership ?? "active" as const };
    });
    const payload = { conversationKey: this.worker.conversationKey, storeId: this.worker.storeId, roomId: this.boundRoomId,
      membershipRevision: membership.revision, agents };
    const revision = identities.report?.revision ?? 0;
    const report = { ...payload, revision };
    if (!identities.report || fingerprint(report) !== fingerprint(identities.report)) identities.report = { ...report, revision: revision + 1 };
  }

  private queueParticipantReport() {
    if (this.closed || !this.workerParticipants) return;
    this.participantReportDirty = true;
    if (this.participantReportDrain) return;
    // Publication callbacks are wakeups only; no Session or network operation runs in them.
    this.participantReportDrain = Promise.resolve().then(async () => {
      while (this.participantReportDirty && !this.closed) {
        this.participantReportDirty = false;
        await this.workerParticipants!.report(await this.workerParticipantReport());
      }
    }).catch(() => { console.error("Worker participant report failed; committed state remains available for reconciliation."); })
      .finally(() => { this.participantReportDrain = undefined; if (this.participantReportDirty && !this.closed) this.queueParticipantReport(); });
  }

  /** Caller authenticates the current attempt and supplies its route, not worker-supplied scope. */
  async acknowledgeWorkerParticipants(companyId: string, conversationKey: string, storeId: string, raw: unknown) {
    if (!this.directoryOnly) throw new RuntimeError(409, "Not a directory runtime.");
    const report = workerParticipantReportSchema.parse(raw);
    return this.harness.commit(tx => this.acknowledgeWorkerParticipantsIn(tx, companyId, conversationKey, storeId, report), context);
  }

  private async acknowledgeWorkerParticipantsIn(tx: Tx, companyId: string, conversationKey: string, storeId: string, report: WorkerParticipantReport) {
    if (report.conversationKey !== conversationKey || report.storeId !== storeId)
      throw new RuntimeError(403, "Participant report is outside the authenticated route.");
    const catalog = await tx.doc(CatalogDoc);
    if (!catalog.chats.some(chat => chat.companyId === companyId && chat.id === conversationKey)) throw new RuntimeError(404, "Conversation not found.");
    await this.workerMembership(tx, conversationKey);
    const actors = (await tx.doc(WorkerActorsDoc)).actors[conversationKey];
    const invitations = (await tx.doc(WorkerInvitationsDoc)).rooms[conversationKey];
    const journal = (await tx.doc(WorkerInstancesDoc)).rooms[conversationKey] ??= { requests: {} };
    const hash = fingerprint(report);
    if (journal.report) {
      if (journal.report.storeId !== storeId || journal.report.roomId !== report.roomId) throw new RuntimeError(409, "Worker report binding changed.");
      if (report.revision < journal.report.revision) return;
      if (report.revision === journal.report.revision) {
        if (journal.report.fingerprint !== hash) throw new RuntimeError(409, "Worker report revision conflicts.");
        return;
      }
    }
    if (report.membershipRevision > invitations.revision
      || new Set(report.agents.map(agent => agent.actorId)).size !== report.agents.length
      || new Set(report.agents.map(agent => agent.participantId)).size !== report.agents.length
      || new Set(report.agents.map(agent => agent.instanceId)).size !== report.agents.length)
      throw new RuntimeError(409, "Worker report contains conflicting membership identities.");
    if (actors.some(actor => actor.worker && !report.agents.some(agent => agent.actorId === actor.participantId)))
      throw new RuntimeError(409, "Worker report lost a retained participant.");
    for (const applied of report.agents) {
      const actor = actors.find(actor => actor.participantId === applied.actorId);
      if (!actor || actor.companyId !== companyId || actor.definitionId !== applied.definitionId)
        throw new RuntimeError(403, "Worker participant has no backend authority.");
      const binding = { storeId, roomId: report.roomId, participantId: applied.participantId, instanceId: applied.instanceId };
      if ((actor.worker && fingerprint(actor.worker) !== fingerprint(binding)) || (!actor.legacy && applied.participantId !== actor.participantId))
        throw new RuntimeError(409, "Worker participant identity changed.");
      if (applied.appliedRevision < (actor.appliedRevision ?? actor.revision)
        || !catalog.agents.some(agent => agent.companyId === companyId && agent.id === actor.definitionId && agent.revision === applied.appliedRevision)
        || applied.appliedRevision > actor.desiredRevision!)
        throw new RuntimeError(409, "Worker applied revision is not authorized.");
      if ((actor.membership === "active" && applied.membership !== "active")
        || (actor.membership === "removed" && applied.membership !== "removed"))
        throw new RuntimeError(409, "Worker membership conflicts with backend intent.");
      actor.worker = binding;
      actor.appliedRevision = applied.appliedRevision;
      // An older active report can never undo a backend removal fence.
      if (actor.membership === "removing" && applied.membership === "removed") {
        actor.membership = "removed";
        // Projection carries the durable removal intent, not its observation. Completion
        // must not invalidate a concurrent reconcile/definition request for that intent.
      }
    }
    journal.report = { storeId, roomId: report.roomId, revision: report.revision, fingerprint: hash };
  }

  private async workerMembership(tx: Tx, id: string): Promise<WorkerMembershipSnapshot> {
    const room = await tx.doc(SharedDoc, nativeId(id));
    const actors = (await tx.doc(WorkerActorsDoc)).actors[id];
    const invitations = (await tx.doc(WorkerInvitationsDoc)).rooms[id];
    if (!actors || !invitations) throw new RuntimeError(409, "Conversation has no backend membership journal.");
    const catalog = await tx.doc(CatalogDoc);
    let changed = false;
    // Additive journal upgrade: retain every backend/native identity and old request receipt.
    if (!invitations.instances) {
      for (const actor of actors) { actor.legacy ??= true; actor.membership ??= "active"; }
      invitations.instances = true;
      changed = true;
    }
    if (!invitations.mcpSelections) { invitations.mcpSelections = true; changed = true; }
    for (const actor of actors) {
      const latest = latestAgent(catalog, actor.companyId, actor.definitionId);
      const desired = latest && !latest.archived && actor.membership !== "removed" && actor.membership !== "removing"
        ? latest.revision : actor.desiredRevision ?? Math.max(actor.appliedRevision ?? actor.revision, latest?.revision ?? actor.revision);
      if (actor.desiredRevision !== desired) { actor.desiredRevision = desired; changed = true; }
      actor.membership ??= "active";
      actor.legacy ??= false;
    }
    if (changed) invitations.revision++;
    return detached({ conversationKey: id, revision: invitations.revision,
      humans: room.members.filter(member => member.kind === "human").map(member => ({ id: member.userId!, name: member.name })),
      agents: actors.map(actor => ({ actorId: actor.participantId, definitionId: actor.definitionId,
        revision: actor.revision, desiredRevision: actor.desiredRevision!, membership: actor.membership === "active" ? "active" : "removing", legacy: actor.legacy!,
        ...(actor.creation ? { creation: actor.creation } : {}), ...(actor.removedByUserId ? { removedByUserId: actor.removedByUserId } : {}),
        mcp: workerMcpSelection(actor.configuration) })), events: invitations.events });
  }

  private async admitWorkerInvitation(tx: Tx, id: string, companyId: string, author: { userId?: string; definitionId?: string; actorId?: string }, input: AddParticipantsInput, people: Person[]) {
    requireText(input.requestId, "Invitation request ID", 200);
    const agentIds = [...new Set(input.agentDefinitionIds ?? [])].sort();
    const userIds = [...new Set(input.userIds ?? [])].sort();
    for (const id of [...agentIds, ...userIds]) requireText(id, "Participant ID", 200);
    const room = await tx.doc(SharedDoc, nativeId(id));
    if (room.companyId !== companyId) throw new RuntimeError(404, "Conversation not found.");
    if (room.sharedProjectId !== undefined && userIds.length) throw new RuntimeError(403, "Manage project membership to grant access to this conversation.");
    await this.workerMembership(tx, id);
    const actors = (await tx.doc(WorkerActorsDoc)).actors[id];
    const invitations = (await tx.doc(WorkerInvitationsDoc)).rooms[id];
    const key = JSON.stringify([author, input.requestId]);
    const hash = fingerprint([agentIds, userIds]);
    if (invitations.requests[key]) {
      if (invitations.requests[key] !== hash) throw requestConflict();
      return this.workerMembership(tx, id);
    }
    const catalog = await tx.doc(CatalogDoc);
    const names: string[] = [];
    let authorAdded = false;
    if (author.userId && !room.members.some(member => member.userId === author.userId)) {
      const person = people.find(person => person.id === author.userId);
      if (!person) throw new RuntimeError(404, "Invitation author is unavailable.");
      room.members.push({ id: `human:${person.id}`, kind: "human", userId: person.id, name: person.name, joinedAt: Date.now(), status: "idle" });
      room.preferences[person.id] ??= { pinned: false, archived: false };
      authorAdded = true;
    }
    for (const definitionId of agentIds) {
      const existing = actors.filter(actor => actor.definitionId === definitionId);
      if (existing.some(actor => actor.membership === "active")) continue;
      if (!author.userId && existing.length) throw new RuntimeError(403, "Only a human can re-add a removed agent.");
      if (existing.some(actor => actor.membership === "removing")) throw new RuntimeError(409, "Agent removal is still pending. Retry after cleanup finishes.");
      const definition = this.findAgent(catalog, { companyId }, definitionId);
      this.validateAgent(definition);
      const identity = await tx.createConversation({ ownership: { kind: "ownerless" } });
      actors.push({ companyId, definitionId, revision: definition.revision, instanceId: identity.id,
        participantId: randomUUID(), roomId: nativeId(id), configuration: detached(publicAgent(definition)), legacy: false, membership: "active" });
      names.push(definition.name);
    }
    for (const userId of userIds) {
      if (room.members.some(member => member.kind === "human" && member.userId === userId)) continue;
      const person = people.find(person => person.id === userId);
      if (!person) throw new RuntimeError(404, "Company member not found.");
      room.members.push({ id: `human:${userId}`, kind: "human", userId, name: person.name, joinedAt: Date.now(), status: "idle" });
      room.preferences[userId] = { pinned: false, archived: false };
      names.push(person.name);
    }
    invitations.requests[key] = hash;
    if (names.length || authorAdded) invitations.revision++;
    if (names.length) {
      invitations.events.push({ revision: invitations.revision, ...(author.userId ? { authorUserId: author.userId } : { authorDefinitionId: author.definitionId!, authorActorId: author.actorId! }), names, at: Date.now() });
    }
    return this.workerMembership(tx, id);
  }

  /** Backend-only projection, applied on Pi's commit line. Versions reject stale/conflicting
   * content; participant creation and membership notices commit with the receipt.
   */
  async applyWorkerMembership(input: WorkerMembershipSnapshot) {
    // Agent invitation callbacks and HTTP reconciliation can arrive independently.
    // Order registry preparation with the durable selection commit, without holding a Pi transaction over I/O.
    const operation = this.membershipTail.then(() => this.applyWorkerMembershipNow(input));
    this.membershipTail = operation.catch(() => {});
    return operation;
  }

  private async applyWorkerMembershipNow(input: WorkerMembershipSnapshot) {
    if (!this.worker || !this.boundRoomId) throw new RuntimeError(409, "Worker room is not open.");
    const snapshot = detached(input);
    if (snapshot.conversationKey !== this.worker.conversationKey || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1)
      throw new RuntimeError(409, "Worker membership identity/revision mismatch.");
    if (new Set(snapshot.humans.map(person => person.id)).size !== snapshot.humans.length
      || new Set(snapshot.agents.map(agent => agent.actorId)).size !== snapshot.agents.length)
      throw new RuntimeError(409, "Duplicate worker membership identity.");
    for (const agent of snapshot.agents) {
      requireText(agent.actorId, "Worker actor ID", 200);
      if (!Number.isSafeInteger(agent.revision) || agent.revision < 1 || !Number.isSafeInteger(agent.desiredRevision)
        || agent.desiredRevision < agent.revision || !["active", "removing"].includes(agent.membership))
        throw new RuntimeError(409, "Invalid worker instance projection.");
    }
    const hash = fingerprint(snapshot);
    const prior = await this.harness.snapshot(WorkerMembershipReceiptDoc, context);
    if (prior && (snapshot.revision < prior.revision || (snapshot.revision === prior.revision && hash !== prior.fingerprint)))
      throw new RuntimeError(409, "Stale or conflicting worker membership.");
    if (prior?.revision === snapshot.revision) return { revision: snapshot.revision };
    await this.prepareWorkerMcp(snapshot);
    await this.harness.commit(async tx => {
      const receipt = await tx.doc(WorkerMembershipReceiptDoc);
      if (snapshot.revision < receipt.revision || (snapshot.revision === receipt.revision && hash !== receipt.fingerprint))
        throw new RuntimeError(409, "Stale or conflicting worker membership.");
      if (snapshot.revision === receipt.revision) return;
      const roomId = nativeId(this.boundRoomId!);
      const room = await tx.doc(SharedDoc, roomId);
      for (const person of snapshot.humans) {
        if (room.members.some(member => member.kind === "human" && member.userId === person.id)) continue;
        room.members.push({ id: `human:${person.id}`, kind: "human", userId: person.id, name: person.name, joinedAt: Date.now(), status: "idle" });
        room.preferences[person.id] ??= { pinned: false, archived: false };
      }
      const identities = await tx.doc(WorkerIdentityDoc);
      for (const agent of snapshot.agents) {
        let mapping = identities.mappings[agent.actorId];
        if (!mapping) {
          let member: Member | undefined;
          if (agent.legacy) {
            // The old protocol admitted at most one instance per definition. Bind it once,
            // without changing native IDs, public author IDs, task inputs or history.
            const retained = room.members.filter(member => member.kind === "agent" && member.agentDefinitionId === agent.definitionId
              && !Object.values(identities.mappings).some(mapping => mapping.participantId === member.id));
            if (retained.length > 1) throw new RuntimeError(409, "Legacy participant mapping is ambiguous.");
            member = retained[0];
          }
          if (!member) member = await this.shared.addAgent(tx, roomId, agent.definitionId, agent.creation ?? {}, agent.revision, agent.actorId);
          if (!member.conversationId) throw new RuntimeError(409, "Worker participant has no native instance.");
          mapping = identities.mappings[agent.actorId] = { participantId: member.id, instanceId: String(member.conversationId), desiredRevision: agent.desiredRevision };
        }
        if (agent.desiredRevision < mapping.desiredRevision) throw new RuntimeError(409, "Worker desired revision regressed.");
        mapping.desiredRevision = agent.desiredRevision;
        const member = room.members.find(member => member.id === mapping.participantId);
        if (!member || member.agentDefinitionId !== agent.definitionId || String(member.conversationId) !== mapping.instanceId
          || !member.agentRevision || member.agentRevision < agent.revision || member.agentRevision > agent.desiredRevision)
          throw new RuntimeError(409, "Worker participant conflicts with its backend instance authority.");
        if (agent.membership !== "active") {
          if (!agent.removedByUserId) throw new RuntimeError(409, "Removal attribution is unavailable.");
          await this.shared.beginRemoval(tx, roomId, member.id, `human:${agent.removedByUserId}`);
        } else {
          if (member.membership && member.membership !== "active") throw new RuntimeError(409, "Backend projection cannot revive a removed participant.");
          if (fingerprint(workerMcpSelection(member.agent!)) !== fingerprint(agent.mcp)) member.pendingWorkerMcp = detached(agent.mcp);
          else delete member.pendingWorkerMcp;
        }
      }
      if (room.members.some(member => member.kind === "agent" && !Object.values(identities.mappings).some(mapping => mapping.participantId === member.id))
        || Object.keys(identities.mappings).some(actorId => !snapshot.agents.some(agent => agent.actorId === actorId)))
        throw new RuntimeError(409, "Worker has a participant without backend authority.");
      for (const event of snapshot.events.filter(event => event.revision > receipt.revision)) {
        const authorId = event.authorUserId ? `human:${event.authorUserId}`
          : event.authorActorId ? identities.mappings[event.authorActorId]?.participantId
          : room.members.find(member => member.agentDefinitionId === event.authorDefinitionId)?.id;
        if (!authorId) throw new RuntimeError(409, "Invitation author is unavailable.");
        await this.shared.appendPublic(tx, roomId, { data: { id: `membership:${this.worker!.conversationKey}:${event.revision}`,
          kind: "membership", authorId, text: `Invited ${event.names.join(", ")}`, createdAt: event.at, threadId: null, mentions: [] } });
      }
      receipt.revision = snapshot.revision; receipt.fingerprint = hash;
      await this.updateWorkerParticipantReport(tx);
    }, context);
    // Registry preparation precedes this safe-idle application; pending work remains native-owned.
    await this.reconcileUpgrades(new Set([nativeId(this.boundRoomId)]));
    return { revision: snapshot.revision };
  }

  async workerInitialAgentRevisions(scope: RuntimeScope, id: string): Promise<Record<string, number>> {
    if (!this.directoryOnly) throw new RuntimeError(409, "Not a directory runtime.");
    return this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      const actors = (await tx.doc(WorkerActorsDoc)).actors[id];
      if (!actors) throw new RuntimeError(409, "Conversation has no backend actor pins.");
      return Object.fromEntries([...actors].reverse().map(actor => [actor.definitionId, actor.revision]));
    }, context);
  }

  private async prepareWorkerMcp(membership: WorkerMembershipSnapshot) {
    if (!this.worker) throw new RuntimeError(409, "Not a conversation worker.");
    if (membership.conversationKey !== this.worker.conversationKey) throw new RuntimeError(409, "Worker membership identity mismatch.");
    for (const { mcp } of membership.agents.filter(agent => agent.membership === "active")) {
      if (!mcp || mcp.extensions.some(name => !isMcpExtension(name)) || mcp.tools.some(name => !isMcpTool(name)))
        throw new RuntimeError(409, "Invalid worker MCP selection.");
    }
    if (this.workerMcp) await this.workerMcp.prepare(this.registry, membership, id => this.harness.commit(async tx => this.remoteActor(tx, await this.shared.managementActor(tx, id)), context));
    else if (membership.agents.some(agent => agent.membership === "active" && (agent.mcp.extensions.length || agent.mcp.tools.length)))
      throw new RuntimeError(503, "Worker MCP registrations are unavailable.");
  }

  private async applyWorkerMcpSelection(tx: Tx, member: Member, selection: WorkerMcpSelection) {
    if (!member.conversationId || !member.agent) throw new RuntimeError(409, "Worker agent binding is unavailable.");
    const registry = this.registry.snapshot();
    const extensions = selection.extensions.map(name => {
      const extension = registry.extension(name);
      if (!extension) throw new RuntimeError(503, `Agent extension ${name} is unavailable.`);
      return extension;
    });
    if (selection.tools.some(name => !extensions.some(extension => extension.tools?.some(tool => tool.name === name))))
      throw new RuntimeError(503, "Worker MCP tool registration is unavailable.");
    const agent = await tx.doc(AgentDoc, member.conversationId);
    // These instances originate from configure() with explicit lists. Preserve native
    // collaboration/skill/coding selections and reject unsupported selection shapes.
    if (!Array.isArray(agent.extensions) || !Array.isArray(agent.tools)) throw new RuntimeError(409, "Worker agent selections must be explicit.");
    agent.extensions = [...agent.extensions.filter(name => !isMcpExtension(name)), ...selection.extensions];
    agent.tools = [...agent.tools.filter(name => !isMcpTool(name)), ...selection.tools];
    member.agent.extensions = [...member.agent.extensions.filter(name => !isMcpExtension(name)), ...selection.extensions];
    member.agent.tools = [...member.agent.tools.filter(name => !isMcpTool(name)), ...selection.tools];
    member.agent.connections = detached(selection.connections ?? []);
  }

  /** Attempt authentication belongs to the backend route. Never execute the returned
   * authorization after a concurrent revocation barrier; the invocation owns that ordering.
   */
  async authorizeWorkerSecrets(claim: WorkerManagementActor) {
    this.requireDirectoryActor(claim);
    return this.harness.commit(async tx => {
      const actor = await this.authoritativeWorkerActor(tx, claim);
      const definition = latestAgent(await tx.doc(CatalogDoc), actor.companyId, actor.definitionId);
      if (!definition || definition.archived || !agentCapabilities(definition).includes("files-and-commands"))
        throw new RuntimeError(403, "Secret tools are not authorized for this participant.");
      return { companyId: actor.companyId, definitionId: actor.definitionId };
    }, context);
  }

  async readWorkerProjectSpec(claim: WorkerManagementActor, input: ProjectSpecReadInput): Promise<ProjectSpecPage> {
    this.requireDirectoryActor(claim);
    return this.harness.commit(async tx => {
      const actor = await this.authoritativeWorkerActor(tx, claim);
      const room = await tx.doc(SharedDoc, nativeId(claim.conversationKey));
      if (room.companyId !== actor.companyId) throw new RuntimeError(403, "Project spec access is unavailable.");
      return projectMarkdownPage(tx, actor.companyId, room.sharedProjectId, input);
    }, context);
  }

  async listWorkerProjectChats(claim: WorkerManagementActor, raw: unknown): Promise<ProjectChatsResult> {
    this.requireDirectoryActor(claim);
    const input = projectChatsSchema.parse(raw);
    return this.harness.commit(async tx => this.projectChatsIn(tx, await this.authoritativeWorkerActor(tx, claim), input), context);
  }

  /** Return only a detached, project-authorized target. The backend reads its store
   * after releasing this transaction, then rechecks before disclosing the result. */
  async authorizeWorkerProjectChat(claim: WorkerManagementActor, chatId: string) {
    this.requireDirectoryActor(claim);
    return this.harness.commit(async tx => {
      const actor = await this.authoritativeWorkerActor(tx, claim);
      const metadata = await this.projectChatIn(tx, actor, chatId);
      return { projectId: (await tx.doc(SharedDoc, actor.roomId)).sharedProjectId!, metadata };
    }, context);
  }

  private async agentProjectIn(tx: Tx, actor: ManagementActor) {
    const room = await tx.doc(SharedDoc, actor.roomId);
    if (room.companyId !== actor.companyId) throw new RuntimeError(403, "Agent project access is unavailable.");
    if (!room.sharedProjectId) return undefined;
    const project = (await tx.doc(ProjectsDoc)).projects[room.sharedProjectId];
    if (!project || project.companyId !== actor.companyId) throw new RuntimeError(404, "Project not found.");
    return project.id;
  }

  private async projectChatsIn(tx: Tx, actor: ManagementActor, input: ProjectChatsInput): Promise<ProjectChatsResult> {
    const projectId = await this.agentProjectIn(tx, actor);
    if (!projectId) return { projectId: null, chats: [], nextCursor: null };
    const candidates = (await tx.doc(CatalogDoc)).chats.filter(chat => chat.companyId === actor.companyId)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const chats: ProjectChatMetadata[] = [];
    const limit = input.limit ?? 50;
    for (const chat of candidates) {
      if (input.cursor && chat.id <= input.cursor) continue;
      const room = await tx.doc(SharedDoc, nativeId(chat.id));
      if (room.companyId !== actor.companyId || room.sharedProjectId !== projectId) continue;
      if (chats.length === limit) return { projectId, chats, nextCursor: chats.at(-1)!.id };
      chats.push(await this.projectChatMetadataIn(tx, chat));
    }
    return { projectId, chats, nextCursor: null };
  }

  private async projectChatIn(tx: Tx, actor: ManagementActor, chatId: string): Promise<ProjectChatMetadata> {
    const projectId = await this.agentProjectIn(tx, actor);
    const chat = (await tx.doc(CatalogDoc)).chats.find(chat => chat.id === chatId && chat.companyId === actor.companyId);
    if (!projectId || !chat) throw new RuntimeError(404, "Chat not found.");
    const room = await tx.doc(SharedDoc, nativeId(chat.id));
    if (room.companyId !== actor.companyId || room.sharedProjectId !== projectId) throw new RuntimeError(404, "Chat not found.");
    return this.projectChatMetadataIn(tx, chat);
  }

  private async projectChatMetadataIn(tx: Tx, chat: StoredChat): Promise<ProjectChatMetadata> {
    const summary = await tx.doc(PublicSummaryDoc, nativeId(chat.id));
    return { id: chat.id, title: chat.displayTitle ?? (chat.title === "New conversation" && !chat.creationTitleExplicit ? summary.first?.text || "New chat" : chat.title),
      createdAt: chat.createdAt, updatedAt: Math.max(chat.createdAt, summary.updatedAt), url: chatSourceUrl(chat.id) };
  }

  async authorizeWorkerSearch(claim: WorkerManagementActor) {
    this.requireDirectoryActor(claim);
    return this.harness.commit(async tx => {
      const actor = await this.authoritativeWorkerActor(tx, claim);
      const definition = latestAgent(await tx.doc(CatalogDoc), actor.companyId, actor.definitionId);
      if (!definition || definition.archived || !agentCapabilities(definition).includes("web-search"))
        throw new RuntimeError(403, "Search is not authorized for this participant.");
      return { companyId: actor.companyId, definitionId: actor.definitionId };
    }, context);
  }

  async authorizeWorkerMcp(claim: WorkerManagementActor, connectionId: string, toolName: string) {
    this.requireDirectoryActor(claim);
    return this.harness.commit(async tx => {
      const actor = await this.authoritativeWorkerActor(tx, claim);
      const mcp = workerMcpSelection(actor.configuration);
      const connection = mcp.connections?.find(item => item.id === connectionId);
      const installed = connection && this.registry.snapshot().extension(connection.extension);
      if (!connection || !mcp.extensions.includes(connection.extension) || !mcp.tools.includes(toolName)
        || !installed?.tools?.some(tool => tool.name === toolName)) throw new RuntimeError(403, "MCP tool is not authorized for this participant.");
      const current = this.connections.forAgent(actor.definitionId, managedIds(actor.configuration)).find(item => item.id === connectionId && item.extension === connection.extension);
      if (!current) throw new RuntimeError(403, "MCP connection is unavailable.");
      if (isManagedConnection(connection)) {
        const record = this.managed?.record(connectionId);
        if (!record || record.companyId !== actor.companyId || record.authorization !== "authorized") throw new RuntimeError(403, "MCP connection is disabled.");
      }
      return detached({ actor, connection });
    }, context);
  }

  private async authoritativeWorkerActor(tx: Tx, claim: WorkerManagementActor): Promise<WorkerManagementActor> {
    const actors = (await tx.doc(WorkerActorsDoc)).actors[claim.conversationKey] ?? [];
    const actor = actors.find(item => item.participantId === claim.actorId);
    if (!actor || actor.companyId !== claim.companyId || actor.definitionId !== claim.definitionId)
      throw new RuntimeError(403, "Instance is not authorized in this conversation.");
    const report = workerParticipantReportSchema.parse(claim.participantReport);
    // Tool calls carry the last committed report too: a lost background acknowledgement
    // must not race a newly adopted instance. This never calls back into the worker.
    await this.acknowledgeWorkerParticipantsIn(tx, claim.companyId, claim.conversationKey, claim.storeId, report);
    if (actor.membership !== "active"
      || actor.worker?.storeId !== claim.storeId || actor.worker.roomId !== String(claim.roomId)
      || actor.worker.participantId !== claim.participantId || actor.worker.instanceId !== String(claim.instanceId)
      || actor.appliedRevision !== claim.revision)
      throw new RuntimeError(403, "Instance is not authorized in this conversation.");
    const applied = (await tx.doc(CatalogDoc)).agents.find(agent => agent.companyId === actor.companyId
      && agent.id === actor.definitionId && agent.revision === actor.appliedRevision);
    if (!applied) throw new RuntimeError(409, "Applied agent revision is unavailable.");
    const configuration = detached(publicAgent(applied));
    setWorkerMcpSelection({ configuration }, workerMcpSelection(actor.configuration));
    // Retain stable backend receipt identities, but only after checking the exact persisted
    // worker/native mapping. Definition equality is never an identity substitute.
    return { ...detached(actor), revision: actor.appliedRevision, configuration,
      conversationKey: claim.conversationKey, storeId: claim.storeId, actorId: actor.participantId, participantReport: detached(report) };
  }

  private requireDirectoryActor(actor: WorkerManagementActor) {
    if (!this.directoryOnly) throw new RuntimeError(409, "Remote management requires a directory runtime.");
    requireText(actor.conversationKey, "Conversation key", 200);
    requireText(actor.storeId, "Worker store ID", 200);
    requireText(actor.companyId, "Company ID", 200);
    requireText(actor.actorId, "Worker actor ID", 200);
  }

  private async remoteActor(tx: Tx, actor: ManagementActor): Promise<WorkerManagementActor> {
    this.requireWorkerRoom({ companyId: actor.companyId, userId: "" }, String(actor.roomId));
    const identities = await tx.doc(WorkerIdentityDoc);
    const identity = Object.entries(identities.mappings).find(([, mapping]) => mapping.participantId === actor.participantId
      && mapping.instanceId === String(actor.instanceId));
    if (!identity || !identities.report) throw new RuntimeError(409, "Worker instance authority is unavailable.");
    return detached({ ...actor, conversationKey: this.worker!.conversationKey, storeId: this.worker!.storeId,
      actorId: identity[0], participantReport: identities.report });
  }

  private requireCatalogOwner() {
    if (this.worker) throw new RuntimeError(409, "Catalog administration belongs to the backend, not a conversation worker.");
  }

  private requireConversationExecutor() {
    if (this.directoryOnly) throw new RuntimeError(409, "Conversation execution must be routed to its worker.");
  }

  private requireWorkerRoom(scope: RuntimeScope, id: string) {
    if (this.worker && (scope.companyId !== this.worker.scope.companyId || id !== this.boundRoomId))
      throw new RuntimeError(404, "Conversation not found in this worker.");
  }

  private async verifyWorkerWorkspace() {
    await this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      if (catalog.chats.length !== 1 || catalog.chats[0].id !== this.boundRoomId)
        throw new RuntimeError(409, "A conversation worker must own exactly one room.");
      const room = await tx.doc(SharedDoc, nativeId(this.boundRoomId!));
      if (room.companyId !== this.worker!.scope.companyId) throw new RuntimeError(409, "Worker room company mismatch.");
      for (const member of room.members) {
        if (!member.conversationId) continue;
        const agent = await tx.doc(AgentDoc, member.conversationId);
        if (agent.cwd && agent.cwd !== this.workspaceDir)
          throw new RuntimeError(409, "Worker workspace path changed; implicit workspace migration is not supported.");
      }
    }, context);
  }

  async listChats(scope: RuntimeScope): Promise<ChatSummary[]> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    const summaries: ChatSummary[] = [];
    for (const chat of catalog!.chats.filter(chat => chat.companyId === scope.companyId)) {
      try {
        summaries.push(await this.harness.commit(async tx => {
          const current = (await tx.doc(CatalogDoc)).chats.find(item => item.id === chat.id && item.companyId === scope.companyId);
          if (!current) throw new RuntimeError(404, "Conversation not found.");
          return this.chatSummary(tx, scope, current);
        }, context));
      }
      catch (error) { if (!(error instanceof Error && "status" in error && error.status === 404)) throw error; }
    }
    return summaries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }

  workerMcpBridge() {
    if (!this.directoryOnly) throw new RuntimeError(409, "Not a directory runtime.");
    return {
      definition: this.connections.workerDefinition.bind(this.connections),
      call: this.connections.callWorkerTool.bind(this.connections),
    };
  }

  /** Directory authority and title policy are read together; no worker is started. */
  async directoryChatSummaries(scope: RuntimeScope): Promise<{ conversation: ChatSummary; automaticTitle: boolean }[]> {
    if (!this.directoryOnly) throw new RuntimeError(409, "Not a directory runtime.");
    return this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      const projects = await tx.doc(ProjectsDoc);
      const entries: { conversation: ChatSummary; automaticTitle: boolean }[] = [];
      for (const chat of catalog.chats.filter(chat => chat.companyId === scope.companyId)) {
        try {
          const room = await this.shared.authorize(tx, scope, nativeId(chat.id), "read", this.readAll(scope));
          const preference = room.preferences[scope.userId] ?? { pinned: false, archived: false };
          const access = room.sharedProjectId ? projectAccess(projects.projects[room.sharedProjectId], scope, this.readAll(scope)) : { participate: true };
          entries.push({ automaticTitle: chat.displayTitle === undefined && chat.title === "New conversation", conversation: {
            id: chat.id, title: chat.displayTitle ?? chat.title,
            sharedProjectId: room.sharedProjectId ?? null, canParticipate: access.participate,
            projectId: room.sharedProjectId ?? null, pinned: preference.pinned, archived: preference.archived,
            createdAt: chat.createdAt, updatedAt: chat.createdAt, revision: this.commitRevision,
            agentDefinitionId: chat.agentDefinitionId, agentRevision: chat.agentRevision, agentName: chat.agentName ?? "Saved agent", status: "idle",
          } });
        } catch (error) {
          if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
        }
      }
      return entries;
    }, context);
  }

  async listProjects(scope: RuntimeScope): Promise<Project[]> {
    return this.harness.commit(async tx => {
      const shared = await tx.doc(ProjectsDoc);
      return Object.values(shared.projects).filter(project => projectAccess(project, scope, this.readAll(scope)).read).map(project => this.projectSummary(project, scope))
        .sort((a, b) => a.name.localeCompare(b.name));
    }, context);
  }

  private readAll(scope: RuntimeScope) { return this.readAllProjectUserIds.has(scope.userId); }

  private projectSummary(project: SharedProjectRecord, scope: RuntimeScope): Project {
    const access = projectAccess(project, scope, this.readAll(scope));
    return { instructionsRevision: project.instructionsRevision ?? 0, id: project.id, name: project.name, ...(project.cwd ? { cwd: project.cwd } : {}), createdAt: project.createdAt, kind: "shared", revision: project.revision,
      repositories: (project.repositories ?? []).map(repository => ({ ...repository })), ...(project.spec ? { spec: { ...project.spec } } : {}), ...(project.specRevision ? { specRevision: project.specRevision } : {}),
      members: project.members.map(({ userId, role }) => ({ userId, role })), defaultAgentDefinitionIds: [...project.defaultAgentDefinitionIds], canManage: access.manage, canParticipate: access.participate };
  }

  async createProject(scope: RuntimeScope, input: CreateProjectInput): Promise<Project> {
    this.requireCatalogOwner();
    requireText(input.requestId, "Request ID", 200);
    const name = input.name.trim();
    requireText(name, "Project name", 100);
    return this.harness.commit(async tx => {
      const doc = await tx.doc(ProjectsDoc);
      const key = JSON.stringify([scope.companyId, scope.userId, "create", input.requestId]);
      const fingerprint = JSON.stringify([name, "shared"]);
      const prior = doc.requests[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw requestConflict();
        const project = await requireProjectAccess(tx, scope, prior.projectId, "read", this.readAll(scope));
        return this.projectSummary(project, scope);
      }
      const now = Date.now();
      const project: SharedProjectRecord = { id: randomUUID(), name, companyId: scope.companyId, createdBy: scope.userId,
        createdAt: now, updatedAt: now, revision: 1, members: [{ userId: scope.userId, role: "manager" }], defaultAgentDefinitionIds: [DEFAULT_AGENT_ID] };
      doc.projects[project.id] = project; doc.requests[key] = { fingerprint, projectId: project.id };
      return this.projectSummary(project, scope);
    }, context);
  }

  private get projectArchiveStore() {
    if (this.archiveStorage) return this.archiveStorage;
    if (this.directoryOnly) throw new RuntimeError(503, "Durable archive storage is unavailable.");
    return new ProjectArchiveStore(join(this.owner.directory, "project-archives"));
  }

  async authorizeProjectExport(scope: RuntimeScope, id: string, chatIds: string[]) {
    if (chatIds.length > 100 || new Set(chatIds).size !== chatIds.length) throw new RuntimeError(400, "Choose up to 100 unique chats.");
    await this.harness.commit(async tx => {
      await requireProjectAccess(tx, scope, id, "manage");
      for (const chatId of chatIds) {
        const room = await this.shared.authorize(tx, scope, nativeId(chatId), "read", false);
        if (room.sharedProjectId !== id) throw new RuntimeError(409, "Selected chat no longer belongs to this project.");
      }
    }, context);
  }

  async exportProjectArchive(scope: RuntimeScope, id: string, chatIds: string[]): Promise<ProjectArchive> {
    if (chatIds.length > 100 || new Set(chatIds).size !== chatIds.length) throw new RuntimeError(400, "Choose up to 100 unique chats.");
    const snapshot = await this.harness.commit(async tx => {
      const project = await requireProjectAccess(tx, scope, id, "manage");
      const catalog = await tx.doc(CatalogDoc);
      const chats = [];
      for (const chatId of chatIds) {
        const stored = catalog.chats.find(chat => chat.id === chatId && chat.companyId === scope.companyId);
        if (!stored) throw new RuntimeError(404, "Chat not found.");
        const room = await this.shared.authorize(tx, scope, nativeId(chatId), "read", false);
        if (room.sharedProjectId !== id) throw new RuntimeError(409, "Selected chat no longer belongs to this project.");
        const messages = await this.shared.publicMessages(nativeId(chatId), room.messageAliases);
        const attachments = await tx.doc(AttachmentsDoc, nativeId(chatId));
        for (const message of messages) for (const file of message.attachments ?? []) {
          if (!attachments.records[file.id] || attachments.records[file.id].private) throw new RuntimeError(409, "Public attachment metadata is unavailable.");
        }
        chats.push({ id: chatId, title: stored.displayTitle ?? stored.title, messages,
          authors: room.members.map(member => ({ id: member.id, name: member.name, kind: member.kind })) });
      }
      return JSON.parse(JSON.stringify({ name: project.name, chats, prior: (await tx.doc(ProjectArchivesDoc)).records[id] })) as { name: string; chats: typeof chats; prior?: { id: string; digest: string } };
    }, context);
    const archive: ProjectArchive = { format: "dispatch-project-content", version: 1, name: snapshot.name, exportedAt: Date.now(), chats: [] };
    // Existing imported history is retained when re-exporting, separate from native selected chats.
    if (snapshot.prior) archive.chats.push(...(await this.projectArchiveStore.read(snapshot.prior)).chats);
    let size = Buffer.byteLength(JSON.stringify(archive));
    for (const source of snapshot.chats) {
      const authors = new Map(source.authors.map((author, index) => [author.id, { key: `a${index}`, name: author.name, kind: author.kind as "human" | "agent" | "unknown" }]));
      for (const message of source.messages) for (const id of [message.authorId, ...message.mentions]) {
        if (!authors.has(id)) authors.set(id, { key: `a${authors.size}`, name: "Unknown historical author", kind: "unknown" });
      }
      const ids = new Map<string, string>();
      source.messages.forEach((message, index) => { ids.set(message.id, `m${index}`); message.aliases?.forEach(alias => ids.set(alias, `m${index}`)); });
      const chat: ArchivedChat = { key: `c${archive.chats.length}`, title: source.title, authors: [...authors.values()], messages: [], files: [] };
      const files = new Map<string, string>();
      for (const message of source.messages) {
        const references: string[] = [];
        for (const file of message.attachments ?? []) {
          if (!files.has(file.id)) {
            if (size + Math.ceil(file.size / 3) * 4 > PROJECT_ARCHIVE_MAX_BYTES) throw new RuntimeError(413, "Selected content exceeds 32 MiB.");
            const bytes = await this.attachments.read(file);
            if (bytes.length !== file.size) throw new RuntimeError(409, "Attachment size changed.");
            const item = { key: `f${files.size}`, name: file.name, mimeType: file.mimeType, size: bytes.length, sha256: archiveDigest(bytes), data: bytes.toString("base64") };
            size += Buffer.byteLength(JSON.stringify(item)); chat.files.push(item); files.set(file.id, item.key);
          }
          references.push(files.get(file.id)!);
        }
        if (message.images?.length) throw new RuntimeError(409, "This chat contains legacy inline images; export is not supported without losing content.");
        const thread = message.threadId === null ? null : ids.get(message.threadId);
        if (thread === undefined) throw new RuntimeError(409, "A historical thread reference is unavailable.");
        const item = { key: ids.get(message.id)!, author: authors.get(message.authorId)!.key, kind: message.kind, text: message.text, createdAt: message.createdAt,
          thread, mentions: message.mentions.map(id => authors.get(id)!.key), files: references };
        size += Buffer.byteLength(JSON.stringify(item));
        if (size > PROJECT_ARCHIVE_MAX_BYTES) throw new RuntimeError(413, "Selected content exceeds 32 MiB.");
        chat.messages.push(item);
      }
      archive.chats.push(chat);
    }
    // Re-key chats so re-exported archives cannot collide with newly selected native history.
    archive.chats.forEach((chat, index) => { chat.key = `c${index}`; });
    const validated = decodeProjectArchive(JSON.stringify(archive));
    await this.harness.commit(async tx => {
      await requireProjectAccess(tx, scope, id, "manage");
      for (const chatId of chatIds) {
        const room = await this.shared.authorize(tx, scope, nativeId(chatId), "read", false);
        if (room.sharedProjectId !== id) throw new RuntimeError(409, "Selected chat moved during export; retry.");
      }
    }, context);
    return validated;
  }

  async importProjectArchive(scope: RuntimeScope, archive: ProjectArchive, requestId: string): Promise<Project> {
    requireText(requestId, "Request ID", 200);
    const fingerprint = archiveDigest(JSON.stringify(archive));
    const key = JSON.stringify([scope.companyId, scope.userId, "project-archive", requestId]);
    const replay = async (tx: Tx) => {
      const prior = (await tx.doc(ProjectsDoc)).requests[key];
      if (!prior) return;
      if (prior.fingerprint !== fingerprint) throw requestConflict();
      return this.projectSummary(await requireProjectAccess(tx, scope, prior.projectId, "read", this.readAll(scope)), scope);
    };
    const prior = await this.harness.commit(replay, context);
    if (prior) return prior;
    const blob = await this.projectArchiveStore.save(archive);
    return this.harness.commit(async tx => {
      const prior = await replay(tx);
      if (prior) return prior;
      const now = Date.now();
      const project: SharedProjectRecord = { id: randomUUID(), name: archive.name, companyId: scope.companyId, createdBy: scope.userId,
        createdAt: now, updatedAt: now, revision: 1, members: [{ userId: scope.userId, role: "manager" }], defaultAgentDefinitionIds: [] };
      const doc = await tx.doc(ProjectsDoc);
      doc.projects[project.id] = project;
      (await tx.doc(ProjectArchivesDoc)).records[project.id] = blob;
      doc.requests[key] = { fingerprint, projectId: project.id };
      return this.projectSummary(project, scope);
    }, context);
  }

  async getProjectArchive(scope: RuntimeScope, id: string): Promise<ProjectArchive | null> {
    const blob = await this.harness.commit(async tx => {
      await requireProjectAccess(tx, scope, id, "read", this.readAll(scope));
      const record = (await tx.doc(ProjectArchivesDoc)).records[id];
      return record ? { ...record } : undefined;
    }, context);
    const archive = blob ? await this.projectArchiveStore.read(blob) : null;
    await this.harness.commit(async tx => { await requireProjectAccess(tx, scope, id, "read", this.readAll(scope)); }, context);
    return archive;
  }

  /** Reads the configured spec, then rechecks current authority/reference. I/O stays outside native commits. */
  private async readLegacyProjectSpec(scope: RuntimeScope, id: string): Promise<ProjectSpecDocument> {
    const binding = (project: SharedProjectRecord) => {
      const spec = project.spec;
      if (spec?.source !== "repository") return undefined;
      const repository = project.repositories?.find(item => item.id === spec.repositoryId);
      return repository ? { repositoryId: repository.id, url: repository.url, path: spec.path, projectRevision: project.revision } : undefined;
    };
    const source = await this.harness.commit(async tx => {
      const project = await requireProjectAccess(tx, scope, id, "read", this.readAll(scope));
      if (project.spec?.source === "directory") return this.localSpecBinding(project);
      return binding(project);
    }, context);
    if (!source) throw new ProjectSpecError(404, "This project has no spec file configured.");
    if ("cwd" in source) {
      const loaded = await readLocalProjectSpec(source.cwd, source.path);
      await this.checkLocalSpec(scope, id, source.binding, "read");
      return { projectId: id, repositoryId: "", url: source.cwd, path: source.path, source: "directory", binding: source.binding, projectRevision: source.projectRevision, ...loaded };
    }
    const loaded = await fetchPublicGithubSpec(source.url, source.path);
    await this.harness.commit(async tx => {
      const current = binding(await requireProjectAccess(tx, scope, id, "read", this.readAll(scope)));
      if (current?.projectRevision !== source.projectRevision || current?.repositoryId !== source.repositoryId || current.url !== source.url || current.path !== source.path) {
        throw new ProjectSpecError(409, "The project's spec reference changed while loading. Reload to open the current spec.");
      }
    }, context);
    return { projectId: id, ...source, ...loaded };
  }

  private localSpecBinding(project: SharedProjectRecord) {
    if (this.directoryOnly || this.worker) throw new ProjectSpecError(400, "Local-directory spec editing is unavailable on cloud workers.");
    if (project.spec?.source !== "directory" || !project.cwd) throw new ProjectSpecError(400, "Configure a project directory and spec file first.");
    const { cwd } = project;
    const path = project.spec.path;
    const binding = createHash("sha256").update(JSON.stringify([project.id, project.revision, cwd, path])).digest("hex");
    return { cwd, path, binding, projectRevision: project.revision };
  }

  private async checkLocalSpec(scope: RuntimeScope, id: string, expectedBinding: string, action: "read" | "manage") {
    return this.harness.commit(async tx => {
      const project = await requireProjectAccess(tx, scope, id, action, this.readAll(scope));
      const current = this.localSpecBinding(project);
      if (current.binding !== expectedBinding) throw new ProjectSpecError(409, "Project spec reference or settings changed. Draft retained; reload and review.");
      return current;
    }, context);
  }

  async getProjectInstructions(scope: RuntimeScope, id: string): Promise<ProjectInstructionsDocument> {
    this.requireCatalogOwner();
    return this.harness.commit(tx => readProjectInstructions(tx, scope, id, this.readAll(scope)), context);
  }

  async saveProjectInstructions(scope: RuntimeScope, id: string, input: SaveProjectInstructionsInput): Promise<ProjectInstructionsDocument> {
    this.requireCatalogOwner();
    return this.harness.commit(tx => saveProjectInstructions(tx, scope, id, input), context);
  }

  async getProjectMarkdown(scope: RuntimeScope, id: string, revision?: number): Promise<ProjectMarkdownDocument> {
    this.requireCatalogOwner();
    return this.harness.commit(tx => readProjectMarkdown(tx, scope, id, revision, this.readAll(scope)), context);
  }

  async saveProjectMarkdown(scope: RuntimeScope, id: string, input: SaveProjectMarkdownInput): Promise<ProjectMarkdownDocument> {
    this.requireCatalogOwner();
    return this.harness.commit(tx => saveProjectMarkdown(tx, scope, id, input), context);
  }

  async importProjectMarkdown(scope: RuntimeScope, id: string, input: ImportProjectMarkdownInput): Promise<ProjectMarkdownDocument> {
    this.requireCatalogOwner();
    // Replay must not require the old file/repository to remain available after migration.
    // Import receipts bind the reviewed source, not mutable project or filesystem state.
    const fingerprint = JSON.stringify(["reviewed-import", input.expectedProjectRevision, input.sourceVersion, input.contentHash]);
    const replay = await this.harness.commit(tx => replayProjectMarkdown(tx, scope, id, input.requestId, fingerprint), context);
    if (replay) return replay;
    await this.harness.commit(async tx => {
      const project = await requireProjectAccess(tx, scope, id, "manage");
      if (project.revision !== input.expectedProjectRevision) throw new ProjectSpecError(409, "Project changed before import. Reload and review.");
    }, context);
    const legacy = await this.readLegacyProjectSpec(scope, id);
    const sourceVersion = legacy.version ?? legacy.commit;
    if (sourceVersion !== input.sourceVersion || markdownHash(legacy.content) !== input.contentHash) throw new ProjectSpecError(409, "Spec source changed before import. Reload and review.");
    const provenance = { source: legacy.source === "directory" ? "directory" as const : "repository" as const, url: legacy.url, path: legacy.path, version: sourceVersion, contentHash: input.contentHash };
    return this.harness.commit(async tx => saveProjectMarkdown(tx, scope, id,
      { requestId: input.requestId, expectedRevision: 0, content: legacy.content },
      { provenance, expectedProjectRevision: input.expectedProjectRevision, fingerprint }), context);
  }

  async getLegacyProjectSpec(scope: RuntimeScope, id: string): Promise<ProjectSpecDocument> {
    this.requireCatalogOwner();
    return this.readLegacyProjectSpec(scope, id);
  }

  async saveProject(scope: RuntimeScope, id: string, input: SaveProjectInput): Promise<Project> {
    this.requireCatalogOwner();
    const cwd = input.cwd === undefined ? undefined : input.cwd?.trim() || null;
    if (cwd && (cwd.length > 4096 || cwd.includes("\0") || !isAbsolute(cwd))) {
      throw new RuntimeError(400, "Working directory must be an absolute path on the service host.");
    }
    const sources = projectSourcesSchema.parse({ repositories: input.repositories, spec: input.spec });
    const key = JSON.stringify([scope.companyId, scope.userId, id, input.requestId]);
    // Preserve historical fingerprints when newer optional fields are omitted.
    const fields: unknown[] = [input.expectedRevision, input.name, input.members, input.defaultAgentDefinitionIds];
    if (cwd !== undefined) fields.push(cwd);
    if (sources.repositories !== undefined || sources.spec !== undefined) fields.push(sources);
    const fingerprint = JSON.stringify(fields);
    const replay = async (tx: Tx) => {
      const current = await requireProjectAccess(tx, scope, id, "manage", this.readAll(scope));
      const prior = (await tx.doc(ProjectsDoc)).requests[key];
      if (!prior) return;
      if (prior.fingerprint !== fingerprint) throw requestConflict();
      return this.projectSummary(current, scope);
    };
    // A committed retry must not depend on a directory or company member still existing.
    const prior = await this.harness.commit(replay, context);
    if (prior) return prior;
    if (cwd) {
      const info = await stat(normalize(cwd)).catch(() => undefined);
      if (!info?.isDirectory()) throw new RuntimeError(400, "Working directory must be an existing directory on the service host.");
    }
    return this.harness.commit(async tx => {
      const prior = await replay(tx);
      if (prior) return prior;
      const current = await requireProjectAccess(tx, scope, id, "manage", this.readAll(scope));
      if (current.revision !== input.expectedRevision) throw new RuntimeError(409, "Project changed. Reload before saving.");
      // Recovery can temporarily hide an existing account from the people directory.
      // Only additions and role changes require a currently available company member.
      await Promise.all(input.members.filter(member => !current.members.some(existing => existing.userId === member.userId && existing.role === member.role))
        .map(member => this.person(scope.companyId, member.userId)));
      const catalog = await tx.doc(CatalogDoc);
      for (const agentId of input.defaultAgentDefinitionIds) this.findAgent(catalog, scope, agentId);
      const project: SharedProjectRecord = { ...current, name: input.name, members: input.members, defaultAgentDefinitionIds: input.defaultAgentDefinitionIds,
        revision: current.revision + 1, updatedAt: Date.now() };
      if (cwd !== undefined) {
        if (cwd === null) delete project.cwd;
        else project.cwd = normalize(cwd);
      }
      if (sources.repositories !== undefined) project.repositories = sources.repositories;
      if (sources.spec && (await tx.doc(ProjectMarkdownDoc)).revisions[id]?.length) {
        throw new RuntimeError(409, "This project uses database-backed Markdown. Reload project settings.");
      }
      if (sources.spec !== undefined) {
        if (sources.spec === null) delete project.spec;
        else project.spec = sources.spec;
      }
      const spec = project.spec;
      if (spec?.source === "repository" && !project.repositories?.some(repository => repository.id === spec.repositoryId)) {
        throw new RuntimeError(400, "Clear or reassign the spec file before removing its repository.");
      }
      if (spec?.source === "directory" && !project.cwd) {
        throw new RuntimeError(400, "Set a project directory or clear or reassign the spec file.");
      }
      const doc = await tx.doc(ProjectsDoc);
      doc.projects[id] = project; doc.requests[key] = { fingerprint, projectId: project.id };
      return this.projectSummary(project, scope);
    }, context);
  }

  async createChat(scope: RuntimeScope, input: CreateChatInput): Promise<ChatSnapshot> {
    return this.getChat(scope, await this.createChatRecord(scope, input));
  }

  private async createChatRecord(scope: RuntimeScope, input: CreateChatInput): Promise<string> {
    if (this.worker) {
      if (fingerprint([scope, input]) !== fingerprint([this.worker.scope, this.worker.input]))
        throw new RuntimeError(409, "A conversation worker cannot create another room.");
      const binding = (await this.harness.snapshot(RuntimeModeDoc, context))?.worker;
      if (binding?.roomId) return binding.roomId;
    }
    requireText(input.requestId, "Request ID", 200);
    const explicitTitle = Boolean(input.title?.trim());
    const title = input.title?.trim() || "New conversation";
    const requestedAgents = input.agentDefinitionIds ?? (input.agentDefinitionId ? [input.agentDefinitionId] : undefined);
    let agentIds = [...new Set(requestedAgents ?? [DEFAULT_AGENT_ID])];
    const creationFingerprint = input.sharedProjectId ? JSON.stringify([title, input.sharedProjectId, requestedAgents ?? null]) : undefined;
    for (const agentId of agentIds) requireText(agentId, "Agent ID", 200);
    requireText(title, "Title", 200);
    const admittedCreator = this.worker?.creator;
    if (admittedCreator && (admittedCreator.id !== scope.userId || !this.worker?.membership
      || this.worker.membership.conversationKey !== this.worker.conversationKey || requestedAgents === undefined))
      throw new RuntimeError(409, "Worker creation attribution/admission mismatch.");
    const human = admittedCreator ?? await this.person(scope.companyId, scope.userId);
    const id = await this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      const existing = catalog.chats.find(chat => owns(scope, chat) && chat.requestId === input.requestId);
      if (existing) {
        const savedAgents = existing.creationAgentIds ?? [existing.agentDefinitionId];
        const sameAgents = requestedAgents === undefined
          ? existing.creationAgentsOmitted ?? (savedAgents.length === 1 && ["default", DEFAULT_AGENT_ID].includes(savedAgents[0]))
          : existing.creationAgentsOmitted !== true && JSON.stringify([...savedAgents].sort()) === JSON.stringify([...new Set(requestedAgents)].sort());
        const matches = existing.creationFingerprint !== undefined
          ? existing.creationFingerprint === creationFingerprint
          : creationFingerprint === undefined && existing.title === title
            && sameAgents
            && (existing.creationProjectId ?? null) === null;
        if (!matches || (existing.creationTitleExplicit !== undefined && existing.creationTitleExplicit !== explicitTitle)) throw requestConflict();
        return existing.id;
      }
      if (input.sharedProjectId) {
        if (admittedCreator) {
          const project = (await tx.doc(ProjectsDoc)).projects[input.sharedProjectId];
          if (!project || project.companyId !== scope.companyId) throw new RuntimeError(409, "Admitted worker project is unavailable.");
        } else {
          const project = await requireProjectAccess(tx, scope, input.sharedProjectId, "participate", this.readAll(scope));
          agentIds = [...new Set(requestedAgents ?? project.defaultAgentDefinitionIds)];
        }
      }
      const initialAgent = (agentId: string) => {
        const revision = this.worker?.initialAgentRevisions?.[agentId];
        const agent = revision === undefined ? this.findAgent(catalog, scope, agentId)
          : catalog.agents.find(item => item.companyId === scope.companyId && item.id === agentId && item.revision === revision);
        if (!agent) throw new RuntimeError(409, "Pinned worker agent revision is unavailable.");
        return agent;
      };
      for (const agentId of agentIds) this.validateAgent(initialAgent(agentId));
      const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const initialize = admittedCreator ? this.shared.initializeAdmitted.bind(this.shared) : this.shared.initialize.bind(this.shared);
      await initialize(tx, record.id, scope.companyId, human, this.directoryOnly || this.worker ? [] : agentIds, { pinned: false, archived: false }, input.sharedProjectId ?? undefined);
      const first = agentIds.length ? initialAgent(agentIds[0]) : undefined;
      const id = String(record.id);
      if (this.directoryOnly) {
        const actors: BackendWorkerActor[] = [];
        for (const definitionId of agentIds) {
          const definition = this.findAgent(catalog, scope, definitionId);
          const identity = await tx.createConversation({ ownership: { kind: "ownerless" } });
          actors.push({ companyId: scope.companyId, definitionId, revision: definition.revision,
            instanceId: identity.id, participantId: randomUUID(), roomId: record.id,
            configuration: detached(publicAgent(definition)), legacy: false, membership: "active" });
        }
        (await tx.doc(WorkerActorsDoc)).actors[id] = actors;
        (await tx.doc(WorkerInvitationsDoc)).rooms[id] = { revision: 1, mcpSelections: true, instances: true, requests: {}, events: [] };
      }
      catalog.chats.push({ ...(creationFingerprint ? { creationFingerprint } : {}), id, title, creationTitleExplicit: explicitTitle, ...(explicitTitle ? { displayTitle: title } : {}), creationAgentIds: agentIds, creationAgentsOmitted: requestedAgents === undefined, createdAt: Date.now(), agentDefinitionId: first?.id ?? "", agentRevision: first?.revision ?? 0, agentName: first?.name ?? "People", companyId: scope.companyId, userId: scope.userId, requestId: input.requestId });
      if (this.worker) {
        const binding = (await tx.doc(RuntimeModeDoc)).worker!;
        if (binding.roomId) throw new RuntimeError(409, "Worker room already exists.");
        binding.roomId = id;
      }
      return id;
    }, context);
    return id;
  }

  async updateChat(scope: RuntimeScope, id: string, input: UpdateChatInput): Promise<ChatSnapshot> {
    this.requireWorkerRoom(scope, id);
    await this.harness.commit(async tx => {
      const room = await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      const preference = room.preferences[scope.userId] ??= { pinned: false, archived: false };
      if (input.pinned !== undefined) preference.pinned = input.pinned;
      if (input.archived !== undefined) preference.archived = input.archived;
    }, context);
    return this.getChat(scope, id);
  }

  async saveDefinitionOfDone(scope: RuntimeScope, id: string, input: { markdown: string; expectedRevision: number }): Promise<ChatSnapshot> {
    if (typeof input.markdown !== "string" || input.markdown.length > 20000 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new RuntimeError(400, "Invalid completion criteria.");
    this.requireWorkerRoom(scope, id);
    await this.harness.commit(async tx => {
      const room = await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      const revision = room.definitionOfDone?.revision ?? 0;
      if (revision !== input.expectedRevision) throw new RuntimeError(409, "Criteria changed. Review the saved version before saving again.");
      room.definitionOfDone = { markdown: input.markdown.trim(), revision: revision + 1 };
    }, context);
    return this.getChat(scope, id);
  }

  async renameChat(scope: RuntimeScope, id: string, title: string): Promise<ChatSnapshot> {
    title = title.trim();
    requireText(title, "Title", 200);
    this.requireWorkerRoom(scope, id);
    await this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      const chat = catalog.chats.find(item => item.id === id && item.companyId === scope.companyId);
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      if (!chat) throw new RuntimeError(404, "Conversation not found.");
      // Keep the creation title intact for request replay; this override is presentation only.
      chat.displayTitle = title;
    }, context);
    return this.getChat(scope, id);
  }

  /** Shared by list and detail so metadata semantics never depend on loaded history. */
  private async chatSummary(tx: Tx, scope: RuntimeScope, chat: StoredChat): Promise<ChatSummary> {
    const room = await this.shared.authorize(tx, scope, nativeId(chat.id), "read", this.readAll(scope));
    const preference = room.preferences[scope.userId] ?? { pinned: false, archived: false };
    const access = room.sharedProjectId ? projectAccess((await tx.doc(ProjectsDoc)).projects[room.sharedProjectId], scope, this.readAll(scope)) : { participate: true };
    const summary = await this.shared.summary(tx, nativeId(chat.id));
    return {
      id: chat.id, title: chat.displayTitle ?? (chat.title === "New conversation" && !chat.creationTitleExplicit ? summary.firstText || "New chat" : chat.title),
      sharedProjectId: room.sharedProjectId ?? null, canParticipate: access.participate,
      projectId: room.sharedProjectId ?? null, pinned: preference.pinned, archived: preference.archived,
      createdAt: chat.createdAt, updatedAt: Math.max(summary.updatedAt, chat.createdAt), revision: this.commitRevision,
      agentDefinitionId: chat.agentDefinitionId, agentRevision: chat.agentRevision, agentName: chat.agentName ?? "Saved agent", status: summary.status,
      ...(summary.error ? { error: summary.error } : {}),
    };
  }

  async getChat(scope: RuntimeScope, id: string): Promise<ChatSnapshot> {
    this.requireWorkerRoom(scope, id);
    // Authorize and read all participating streams on the same native commit line.
    return this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      const chat = catalog.chats.find(item => item.id === id && item.companyId === scope.companyId)!;
      const room = await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      const project = room.sharedProjectId ? (await tx.doc(ProjectsDoc)).projects[room.sharedProjectId] : undefined;
      if (project && !this.directoryOnly) {
        // Record project participants before they speak. This preserves their identity for
        // later message attribution; current project policy still owns all access decisions.
        const known = new Set(room.members.filter(member => member.kind === "human").map(member => member.userId));
        const people = await Promise.all(project.members.filter(member => !known.has(member.userId))
          .map(member => this.peopleDirectory?.get(scope.companyId, member.userId)));
        for (const person of people) if (person) {
          room.members.push({ id: `human:${person.id}`, kind: "human", userId: person.id, name: person.name, joinedAt: Date.now(), status: "idle" });
        }
      }
      const presentation = await this.shared.presentation(tx, nativeId(id));
      for (const participant of presentation.participants) {
        if (participant.kind === "human" && project) {
          participant.membership = project.members.some(member => member.userId === participant.userId) ? "active" : "removed";
        }
        if (participant.kind !== "agent" || participant.membership !== "active") continue;
        const latest = latestAgent(catalog, scope.companyId, participant.agentDefinitionId);
        participant.savedAgentRevision = latest && !latest.archived ? latest.revision : participant.agentRevision;
        const member = room.members.find(item => item.id === participant.id)!;
        if (member.conversationId) participant.agent = { ...participant.agent, connections: await this.connections.boundConnections(tx, member.conversationId) };
      }
      const conversation = await this.chatSummary(tx, scope, chat);
      // Compatibility carries no private native transcript, inbox, reasoning or agent context.
      return { conversation, definitionOfDone: { markdown: room.definitionOfDone?.markdown ?? "", revision: room.definitionOfDone?.revision ?? 0 }, ...presentation, view: { conversation: (await tx.conversation(nativeId(id)))!, entries: [], docs: {} }, submissions: [] } as ChatSnapshot;
    }, context);
  }

  async transcriptPage(scope: RuntimeScope, id: string, query: TranscriptQuery) {
    this.requireWorkerRoom(scope, id);
    return this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      return { ...await this.shared.page(tx, nativeId(id), query), revision: this.commitRevision };
    }, context);
  }

  async publicDetail(scope: RuntimeScope, id: string, kind: "message" | "activity", itemId: string) {
    this.requireWorkerRoom(scope, id);
    return this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      const value = await this.shared.detail(tx, nativeId(id), kind, itemId);
      if (!value) throw new RuntimeError(404, "History item unavailable.");
      return value;
    }, context);
  }

  /** Internal public-summary projection. This never borrows the creator's current access.
   * Its durable content revision survives replacement and also orders transient status changes.
   */
  async workerSummary(): Promise<WorkerSummary> {
    if (!this.worker || !this.boundRoomId) throw new RuntimeError(409, "Worker room is not open.");
    return this.harness.commit(async tx => {
      const chat = (await tx.doc(CatalogDoc)).chats.find(chat => chat.id === this.boundRoomId);
      if (!chat) throw new RuntimeError(409, "Worker room is unavailable.");
      const { firstText, updatedAt, status, error } = await this.shared.summary(tx, nativeId(this.boundRoomId!));
      const summary = { updatedAt: Math.max(updatedAt, chat.createdAt), status,
        ...(error ? { error } : {}), ...(firstText ? { suggestedTitle: firstText.slice(0, 80) } : {}) };
      const receipt = await tx.doc(WorkerSummaryReceiptDoc);
      const hash = fingerprint(summary);
      if (receipt.fingerprint !== hash) { receipt.revision++; receipt.fingerprint = hash; }
      return { ...summary, revision: receipt.revision };
    }, context);
  }

  async watchChat(scope: RuntimeScope, id: string) {
    await this.authorize(scope, id);
    const streams = new Set<ConversationId>([nativeId(id)]);
    const updateStreams = async () => {
      const room = await this.harness.snapshot(SharedDoc, nativeId(id), context);
      streams.clear(); streams.add(nativeId(id));
      for (const member of room?.members ?? []) if (member.conversationId) streams.add(member.conversationId);
    };
    await updateStreams();
    let value = await this.getChat(scope, id);
    let listener: ((snapshot: ChatSnapshot) => Promise<void>) | undefined;
    let running = false;
    let dirty = false;
    let stopped = false;
    let finish!: (value: { reason: "stopped" | "listener_error" | "session_closed" }) => void;
    const closed = new Promise<{ reason: "stopped" | "listener_error" | "session_closed" }>(resolve => { finish = resolve; });
    const drain = async () => {
      if (running || stopped || !listener) return;
      running = true;
      try {
        // Coalesce publications while the current snapshot or listener is pending.
        while (dirty && !stopped) {
          dirty = false;
          await updateStreams();
          value = await this.getChat(scope, id);
          await listener(value);
        }
      } catch {
        stopped = true;
        unsubscribe();
        unsubscribeClose();
        finish({ reason: "listener_error" });
      } finally {
        running = false;
      }
    };
    const unsubscribe = this.harness.subscribeCommits(publication => {
      // Read-only snapshots produce no changes and cannot recursively wake themselves.
      if (stopped) return;
      const relevant = publication.changes.some(change => {
        if (change.type === "document" || change.type === "document.copy") {
          return change.conversationId ? streams.has(change.conversationId) : change.record.kind === CatalogDoc.definition.kind || change.record.kind === ProjectsDoc.definition.kind;
        }
        const stream = change.type === "conversation" ? change.value.id : change.value.conversationId;
        return stream !== undefined && streams.has(stream);
      });
      if (!relevant) return;
      dirty = true;
      void drain();
    });
    const unsubscribeClose = this.harness.subscribeClose(() => {
      stopped = true;
      unsubscribe();
      finish({ reason: "session_closed" });
    });
    return {
      get value() { return value; },
      deliver: (emit: () => void | Promise<void>) => this.harness.commit(async tx => {
        await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
        await emit();
      }, context),
      start: (next: (snapshot: ChatSnapshot) => Promise<void>) => {
        listener = next;
        dirty = true;
        void drain();
      },
      stop: async () => {
        stopped = true;
        unsubscribe();
        unsubscribeClose();
        finish({ reason: "stopped" });
        return closed;
      },
      closed,
    };
  }

  async authorizeAttachmentUpload(scope: RuntimeScope, id: string) {
    this.requireWorkerRoom(scope, id);
    await this.harness.commit(async tx => { await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope)); }, context);
  }

  async uploadAttachment(scope: RuntimeScope, id: string, file: File) {
    await this.authorizeAttachmentUpload(scope, id);
    const record = await this.attachments.save(id, scope.userId, file);
    // Repeat authorization after I/O. Unreferenced bytes are safe to retain if admission fails.
    await this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      (await tx.doc(AttachmentsDoc, nativeId(id))).records[record.id] = record;
    }, context);
    return attachmentMetadata(record);
  }

  async downloadAttachment(scope: RuntimeScope, id: string, attachmentId: string) {
    this.requireWorkerRoom(scope, id);
    const attachment = await this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      const record = (await tx.doc(AttachmentsDoc, nativeId(id))).records[attachmentId];
      if (!record || record.private) throw new AttachmentError(404, "Attachment not found.");
      return attachmentMetadata(record);
    }, context);
    return { attachment, bytes: await this.attachments.read(attachment) };
  }

  async submit(scope: RuntimeScope, id: string, input: SendMessageInput) {
    this.requireConversationExecutor();
    requireText(input.requestId, "Request ID", 200);
    requireText(input.text, "Message", 100_000, Boolean(input.attachmentIds?.length));
    await this.authorize(scope, id);
    const person = await this.person(scope.companyId, scope.userId);
    return this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      await this.shared.ensureHuman(tx, nativeId(id), person);
      return this.shared.post(tx, nativeId(id), `human:${scope.userId}`, input);
    }, context);
  }

  async submitAndGetChat(scope: RuntimeScope, id: string, input: SendMessageInput): Promise<ChatSnapshot> {
    await this.submit(scope, id, input);
    return this.getChat(scope, id);
  }

  async composing(scope: RuntimeScope, id: string, input: { clientId: string; sequence: number; active: boolean }) {
    this.requireConversationExecutor();
    await this.authorize(scope, id);
    const person = await this.person(scope.companyId, scope.userId);
    await this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      await this.shared.ensureHuman(tx, nativeId(id), person);
      await this.shared.turns.composing(tx, nativeId(id), `human:${scope.userId}`, input.clientId, input.sequence, input.active);
    }, context);
  }

  async addParticipants(scope: RuntimeScope, id: string, input: AddParticipantsInput) {
    this.requireConversationExecutor();
    if (this.worker) throw new RuntimeError(409, "Worker invitations must first be admitted by the backend.");
    requireText(input.requestId, "Request ID", 200);
    await this.authorize(scope, id);
    const people = await Promise.all((input.userIds ?? []).map(userId => this.person(scope.companyId, userId)));
    const person = await this.person(scope.companyId, scope.userId);
    await this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      await this.shared.ensureHuman(tx, nativeId(id), person);
      await this.shared.invite(tx, nativeId(id), `human:${scope.userId}`, input, people);
    }, context);
    return this.getChat(scope, id);
  }

  async createAgentInstance(scope: RuntimeScope, id: string, input: CreateAgentInstanceInput): Promise<CreateAgentInstanceResult> {
    this.requireConversationExecutor();
    if (this.worker) throw new RuntimeError(409, "Worker instance creation must first be admitted by the backend.");
    requireText(input.requestId, "Request ID", 200);
    requireText(input.agentDefinitionId, "Agent ID", 200);
    if (input.name !== undefined) requireText(input.name, "Instance name", 100, true);
    if (input.instructions !== undefined) requireText(input.instructions, "Instance instructions", 50_000, true);
    await this.authorize(scope, id);
    const person = await this.person(scope.companyId, scope.userId);
    const createdParticipantId = await this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      await this.shared.ensureHuman(tx, nativeId(id), person);
      return this.shared.createInstance(tx, nativeId(id), `human:${scope.userId}`, { ...input, name: input.name?.trim() || undefined });
    }, context);
    return { ...await this.getChat(scope, id), createdParticipantId };
  }

  async removeParticipant(scope: RuntimeScope, id: string, participantId: string) {
    this.requireConversationExecutor();
    requireText(participantId, "Participant ID", 200);
    await this.authorize(scope, id);
    const person = await this.person(scope.companyId, scope.userId);
    await this.shared.remove(nativeId(id), participantId, `human:${scope.userId}`, async tx => {
      if (this.worker) {
        const member = (await tx.doc(SharedDoc, nativeId(id))).members.find(member => member.id === participantId);
        const mapped = Object.values((await tx.doc(WorkerIdentityDoc)).mappings).some(mapping => mapping.participantId === participantId);
        if (!mapped || !member?.membership || member.membership === "active") throw new RuntimeError(409, "Worker removal must first be admitted by the backend.");
      }
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      await this.shared.ensureHuman(tx, nativeId(id), person);
    });
    if (this.workerParticipants) await this.workerParticipants.report(await this.workerParticipantReport());
    return this.getChat(scope, id);
  }

  async stop(scope: RuntimeScope, id: string) {
    this.requireConversationExecutor();
    this.requireWorkerRoom(scope, id);
    await this.shared.stop(nativeId(id), async tx => { await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope)); });
    return this.getChat(scope, id);
  }

  async getDefaultAgent(companyId: string): Promise<AgentDefinition> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    return publicAgent(this.findAgent(catalog!, { companyId }, DEFAULT_AGENT_ID));
  }

  async listAgents(scope: RuntimeScope): Promise<AgentDefinition[]> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    return [...latestAgents(catalog!, scope.companyId).values()].map(publicAgent);
  }

  async evaluationProfile(scope: RuntimeScope, agentId: string) {
    return this.harness.commit(async tx => {
      if (!latestAgent(await tx.doc(CatalogDoc), scope.companyId, agentId)) throw new RuntimeError(404, "Agent not found.");
      return readEvaluationProfile(tx, scope, agentId);
    }, context);
  }

  async evaluationProfileRevision(scope: RuntimeScope, agentId: string, revision: number) {
    return this.harness.commit(async tx => {
      if (!latestAgent(await tx.doc(CatalogDoc), scope.companyId, agentId)) throw new RuntimeError(404, "Agent not found.");
      return readEvaluationProfileRevision(tx, scope, agentId, revision);
    }, context);
  }

  async saveEvaluationProfile(scope: RuntimeScope, agentId: string, raw: unknown) {
    const input = parseEvaluationProfile(raw);
    return this.harness.commit(async tx => {
      const agent = latestAgent(await tx.doc(CatalogDoc), scope.companyId, agentId);
      if (!agent) throw new RuntimeError(404, "Agent not found.");
      return saveEvaluationProfile(tx, scope, agentId, agent.archived, input);
    }, context);
  }

  async listGitHubBundles(scope: RuntimeScope): Promise<GitHubInstallation[]> {
    const state = await this.harness.snapshot(GitHubBundlesDoc, context);
    return (state?.installations ?? []).filter(item => item.companyId === scope.companyId).map(publicInstallation);
  }

  /** Receives only bounded, validated content fetched by the trusted server route. */
  async previewGitHubBundle(scope: RuntimeScope, bundle: PortableBundle, source: GitHubBundleSource, installationId?: string): Promise<GitHubBundlePreview> {
    return this.harness.commit(async tx => {
      const state = await tx.doc(GitHubBundlesDoc);
      const catalog = await tx.doc(CatalogDoc);
      const prior = installationId ? state.installations.find(item => item.companyId === scope.companyId && item.id === installationId) : undefined;
      if (installationId && !prior) throw new RuntimeError(404, "Tracked bundle not found.");
      if (prior && (prior.source.owner.toLowerCase() !== source.owner.toLowerCase() || prior.source.repository.toLowerCase() !== source.repository.toLowerCase() || prior.source.path !== source.path || prior.packageId !== bundle.id))
        throw new RuntimeError(409, "Updates must use the same repository, package directory and package ID. Import a separate copy instead.");
      const preview: GitHubBundlePreview = { ...this.bundlePreview(bundle), previewId: randomUUID(), source,
        digest: bundleFingerprint(bundle), installationId: prior?.id ?? null, changes: [] };
      if (prior) preview.warnings.push("Updated agent definitions also apply to active instances at their next safe idle boundary. Existing connection bindings keep their separate rollout policy.");
      const next: TrackedBundle = { id: prior?.id ?? randomUUID(), revision: (prior?.revision ?? 0) + 1,
        companyId: scope.companyId, packageId: bundle.id, packageVersion: bundle.version, source, digest: preview.digest,
        updatedAt: Date.now(), agents: detached(prior?.agents ?? []), skills: detached(prior?.skills ?? []) };
      const saved: SavedGitHubPreview = { id: preview.previewId, companyId: scope.companyId, userId: scope.userId,
        expiresAt: Date.now() + 30 * 60_000, preview: "", expectedInstallationRevision: prior?.revision ?? 0, expectedAgents: [], expectedSkills: [], agents: [], skills: [], next };
      const now = Date.now();
      for (const entry of next.agents) {
        const local = latestAgent(catalog, scope.companyId, entry.id);
        const names = local ? [...new Set([...(local.connections ?? []), ...this.connections.forAgent(local.id, managedIds(local))].map(connection => connection.name))] : [];
        if (names.length) preview.warnings.push(`${local!.name}: retained local connections: ${names.join(", ")}. Updated instructions can use their existing authority.`);
      }
      // Removed entries retain both their local records and identity for a later reappearance.
      for (const kind of ["skills", "agents"] as const) {
        for (const entry of next[kind]) {
          if (bundle[kind].some(item => item.key === entry.key)) continue;
          entry.present = false;
          const local = kind === "skills" ? catalog.skills?.findLast(item => item.companyId === scope.companyId && item.id === entry.id)
            : latestAgent(catalog, scope.companyId, entry.id);
          if (local) (kind === "skills" ? saved.expectedSkills : saved.expectedAgents).push({ id: local.id, revision: local.revision });
          preview.changes.push({ kind: kind === "skills" ? "skill" : "agent", key: entry.key, name: local?.name ?? entry.key,
            action: "removed", before: JSON.parse(entry.upstream), local: local ? (kind === "skills" ? portableSkill(entry.key, local as StoredSkill) : portableTrackedAgent(entry.key, local as StoredAgent, next.skills)) : null, incoming: null });
        }
      }
      for (const incoming of bundle.skills) {
        const entry = next.skills.find(item => item.key === incoming.key);
        const local = entry ? catalog.skills?.findLast(item => item.companyId === scope.companyId && item.id === entry.id) : undefined;
        if (local) saved.expectedSkills.push({ id: local.id, revision: local.revision });
        const desired = skillContent(incoming);
        const changed = !entry || desired !== skillContent(JSON.parse(entry.upstream));
        // Conservative first slice: do not combine local and upstream edits within one definition.
        const conflict = !!entry && (!local || (changed && skillContent(local) !== entry.baseline && skillContent(local) !== desired));
        preview.changes.push({ kind: "skill", key: incoming.key, name: incoming.name, action: conflict ? "conflict" : !entry ? "add" : changed && skillContent(local!) !== desired ? "update" : "unchanged",
          before: entry ? JSON.parse(entry.upstream) : null, local: local ? portableSkill(incoming.key, local) : null, incoming });
        if (conflict) { preview.blockers.push(`${incoming.name}: local skill edits conflict with this update. Import a separate copy.`); continue; }
        const write = !local || (changed && skillContent(local) !== desired);
        const record: StoredSkill = write ? { id: entry?.id ?? randomUUID(), revision: (local?.revision ?? 0) + 1,
          name: incoming.name, description: incoming.description, instructions: incoming.instructions,
          companyId: scope.companyId, savedBy: scope.userId, requestId: `github:${preview.previewId}:${incoming.key}`, fingerprint: preview.digest,
          createdAt: local?.createdAt ?? now, updatedAt: now } : local!;
        if (write) saved.skills.push(record);
        const updated: TrackedBundleEntry = { key: incoming.key, id: record.id, revision: changed ? record.revision : entry!.revision,
          baseline: changed ? skillContent(record) : entry!.baseline, upstream: JSON.stringify(incoming), present: true };
        if (entry) Object.assign(entry, updated); else next.skills.push(updated);
      }
      for (const incoming of bundle.agents) {
        const entry = next.agents.find(item => item.key === incoming.key);
        const local = entry ? latestAgent(catalog, scope.companyId, entry.id) : undefined;
        if (local) saved.expectedAgents.push({ id: local.id, revision: local.revision });
        const selection = capabilitySelection(incoming.capabilities);
        const bindings = incoming.skills.map(key => next.skills.find(item => item.key === key && item.present));
        if (bindings.some(item => !item)) { preview.blockers.push(`${incoming.name}: an assigned skill has an unresolved update.`); continue; }
        const skills = bindings.map(item => ({ id: item!.id, revision: item!.revision }));
        const desired = { name: incoming.name, description: incoming.description, instructions: incoming.instructions,
          provider: incoming.provider, modelId: incoming.modelId, thinkingLevel: incoming.thinkingLevel,
          skills, extensions: selection.extensions, tools: selection.tools };
        // The upstream text may be unchanged while a pinned assigned skill revision changes.
        const upstreamChanged = !entry || agentUpstreamContent(incoming) !== agentUpstreamContent(JSON.parse(entry.upstream));
        const baseline = entry ? JSON.parse(entry.baseline) as ReturnType<typeof agentContent> : undefined;
        const assignmentsChanged = !!baseline && JSON.stringify(baseline.skills) !== JSON.stringify(skills);
        const changed = upstreamChanged || assignmentsChanged;
        const desiredContent = JSON.stringify(agentContent(desired));
        const conflict = !!entry && (!local || local.archived || (changed && JSON.stringify(agentContent(local)) !== entry.baseline && JSON.stringify(agentContent(local)) !== desiredContent));
        preview.changes.push({ kind: "agent", key: incoming.key, name: incoming.name, action: conflict ? "conflict" : !entry ? "add" : changed && JSON.stringify(agentContent(local!)) !== desiredContent ? "update" : "unchanged",
          before: entry ? JSON.parse(entry.upstream) : null, local: local ? portableTrackedAgent(incoming.key, local, next.skills) : null, incoming });
        if (conflict) { preview.blockers.push(`${incoming.name}: local agent edits or archive state conflict with this update. Import a separate copy.`); continue; }
        const write = !local || (changed && JSON.stringify(agentContent(local)) !== desiredContent);
        const record: StoredAgent = write ? { ...desired, id: entry?.id ?? randomUUID(), revision: (local?.revision ?? 0) + 1, archived: false,
          extensions: [...selection.extensions, ...(local?.extensions ?? []).filter(isMcpExtension)],
          tools: [...selection.tools, ...(local?.tools ?? []).filter(isMcpTool)], connections: detached(local?.connections ?? []),
          companyId: scope.companyId, savedBy: scope.userId, createdAt: local?.createdAt ?? now, updatedAt: now } : local!;
        if (write) saved.agents.push(record);
        const updated: TrackedBundleEntry = { key: incoming.key, id: record.id, revision: record.revision,
          baseline: changed ? JSON.stringify(agentContent(record)) : entry!.baseline, upstream: JSON.stringify(incoming), present: true };
        if (entry) Object.assign(entry, updated); else next.agents.push(updated);
      }
      saved.preview = JSON.stringify(preview);
      // Bound abandoned review plans independently of permanent committed import receipts.
      const size = (value: SavedGitHubPreview) => Buffer.byteLength(JSON.stringify(value));
      const actorLimit = 32 * 1024 * 1024;
      if (size(saved) > actorLimit) throw new RuntimeError(413, "This update preview is too large. Use smaller packages.");
      state.previews = state.previews.filter(item => item.expiresAt > now);
      const own = state.previews.filter(item => item.companyId === scope.companyId && item.userId === scope.userId);
      own.push(saved);
      while (own.length > 3 || own.reduce((bytes, item) => bytes + size(item), 0) > actorLimit) own.shift();
      state.previews = state.previews.filter(item => item.companyId !== scope.companyId || item.userId !== scope.userId);
      state.previews.push(...own);
      if (state.previews.reduce((bytes, item) => bytes + size(item), 0) > 64 * 1024 * 1024)
        throw new RuntimeError(503, "Bundle preview storage is full. Retry after older previews expire.");
      return detached(preview);
    }, context);
  }

  async applyGitHubBundle(scope: RuntimeScope, input: GitHubBundleApplyInput): Promise<GitHubBundleApplyResult> {
    return this.harness.commit(async tx => {
      const state = await tx.doc(GitHubBundlesDoc);
      const replay = state.receipts.find(item => item.companyId === scope.companyId && item.userId === scope.userId && item.requestId === input.requestId);
      if (replay) {
        if (replay.previewId !== input.previewId) throw requestConflict();
        return detached(replay.result);
      }
      // A preview is a single admission, even if a client mistakenly supplies a fresh request ID.
      if (state.receipts.some(item => item.companyId === scope.companyId && item.userId === scope.userId && item.previewId === input.previewId))
        throw new RuntimeError(409, "This preview was already applied. Preview again to create another copy.");
      const saved = state.previews.find(item => item.id === input.previewId && item.companyId === scope.companyId && item.userId === scope.userId);
      if (!saved || saved.expiresAt <= Date.now()) throw new RuntimeError(404, "Bundle preview expired or was replaced. Preview the pinned commit again.");
      const preview = JSON.parse(saved.preview) as GitHubBundlePreview;
      if (preview.blockers.length) throw new RuntimeError(409, "Resolve the preview conflicts or import a separate copy.");
      const prior = state.installations.find(item => item.id === saved.next.id && item.companyId === scope.companyId);
      if ((prior?.revision ?? 0) !== saved.expectedInstallationRevision) throw new RuntimeError(409, "The tracked bundle changed. Preview again.");
      const catalog = await tx.doc(CatalogDoc);
      for (const expected of saved.expectedAgents) {
        if (latestAgent(catalog, scope.companyId, expected.id)?.revision !== expected.revision) throw new RuntimeError(409, "An agent changed after preview. Preview again.");
      }
      for (const expected of saved.expectedSkills) {
        if (catalog.skills?.findLast(item => item.companyId === scope.companyId && item.id === expected.id)?.revision !== expected.revision) throw new RuntimeError(409, "A skill changed after preview. Preview again.");
      }
      const compatibility = this.bundlePreview(preview.bundle);
      if (compatibility.blockers.length) throw new RuntimeError(409, compatibility.blockers.join("\n"));
      catalog.skills ??= [];
      catalog.skills.push(...detached(saved.skills));
      catalog.agents.push(...detached(saved.agents));
      const next = detached(saved.next);
      next.updatedAt = Date.now();
      if (prior) Object.assign(prior, next); else state.installations.push(next);
      const result: GitHubBundleApplyResult = { installation: publicInstallation(next),
        agents: next.agents.filter(item => item.present).map(({ key, id }) => ({ key, id })),
        skills: next.skills.filter(item => item.present).map(({ key, id }) => ({ key, id })) };
      state.receipts.push({ companyId: scope.companyId, userId: scope.userId, requestId: input.requestId, previewId: input.previewId, result });
      state.previews = state.previews.filter(item => item.id !== saved.id && item.expiresAt > Date.now());
      return detached(result);
    }, context);
  }

  async listSkills(scope: RuntimeScope): Promise<SkillDefinition[]> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    const latest = new Map<string, StoredSkill>();
    for (const skill of catalog?.skills ?? []) if (skill.companyId === scope.companyId) latest.set(skill.id, skill);
    return [...latest.values()].map(publicSkill);
  }

  async getSkill(scope: RuntimeScope, id: string, revision: number): Promise<SkillDefinition> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    const skill = catalog?.skills?.find(skill => skill.companyId === scope.companyId && skill.id === id && skill.revision === revision);
    if (!skill) throw new RuntimeError(404, "Skill revision not found.");
    return publicSkill(skill);
  }

  /** Export from one catalog snapshot, including each exact assigned skill revision. */
  async exportBundle(scope: RuntimeScope, input: BundleExportInput): Promise<PortableBundle> {
    const catalog = (await this.harness.snapshot(CatalogDoc, context))!;
    const bundle: PortableBundle = { formatVersion: 1, id: input.id, version: input.version, agents: [], skills: [] };
    const skillKeys = new Map<string, string>();
    const includeSkill = (selection: { id: string; revision: number }) => {
      const identity = JSON.stringify([selection.id, selection.revision]);
      const existing = skillKeys.get(identity);
      if (existing) return existing;
      const skill = catalog.skills?.find(value => value.companyId === scope.companyId && value.id === selection.id && value.revision === selection.revision);
      if (!skill) throw new RuntimeError(409, "An exported skill revision is unavailable.");
      const key = `skill-${bundle.skills.length + 1}`;
      bundle.skills.push({ key, name: skill.name, description: skill.description, instructions: skill.instructions });
      skillKeys.set(identity, key);
      return key;
    };
    for (const id of new Set(input.agentIds)) {
      const agent = latestAgent(catalog, scope.companyId, id);
      if (!agent) throw new RuntimeError(404, "Agent not found.");
      const capabilities = publicAgent(agent).capabilities ?? [];
      const selection = capabilitySelection(capabilities);
      const extensions = (agent.extensions ?? []).filter(name => !isMcpExtension(name));
      const tools = (agent.tools ?? []).filter(name => !isMcpTool(name));
      // Never silently omit custom code or broaden a partial tool selection on reimport.
      if (!sameNames(extensions, selection.extensions) || !sameNames(tools, selection.tools))
        throw new RuntimeError(409, `${agent.name} has a capability selection this bundle format cannot represent.`);
      bundle.agents.push({ key: `agent-${bundle.agents.length + 1}`, name: agent.name, description: agent.description,
        instructions: agent.instructions, provider: agent.provider, modelId: agent.modelId, thinkingLevel: agent.thinkingLevel,
        capabilities, skills: (agent.skills ?? []).map(includeSkill),
        omittedConnections: new Set([...(agent.connections ?? []).map(connection => connection.id),
          ...this.connections.forAgent(id, managedIds(agent)).map(connection => connection.id)]).size });
    }
    for (const selection of input.skills) includeSkill(selection);
    return bundle;
  }

  async previewBundle(_scope: RuntimeScope, bundle: PortableBundle): Promise<BundlePreview> {
    return this.bundlePreview(bundle);
  }

  /** Codec validates structure first; mutable compatibility is checked again at admission. */
  async importBundle(scope: RuntimeScope, bundle: PortableBundle, requestId: string): Promise<BundleImportResult> {
    const fingerprint = bundleFingerprint(bundle);
    return this.harness.commit(async tx => {
      const receipts = await tx.doc(BundleImportsDoc);
      const replay = receipts.imports.find(receipt => receipt.companyId === scope.companyId && receipt.userId === scope.userId && receipt.requestId === requestId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw requestConflict();
        return detached(replay.result);
      }
      const preview = this.bundlePreview(bundle);
      if (preview.blockers.length) throw new RuntimeError(409, preview.blockers.join("\n"));
      const catalog = await tx.doc(CatalogDoc);
      catalog.skills ??= [];
      const now = Date.now();
      const result: BundleImportResult = { agents: [], skills: [] };
      const skillIds = new Map<string, string>();
      for (const skill of bundle.skills) {
        const id = randomUUID();
        skillIds.set(skill.key, id);
        catalog.skills.push({ id, revision: 1, name: skill.name, description: skill.description, instructions: skill.instructions,
          createdAt: now, updatedAt: now, companyId: scope.companyId, savedBy: scope.userId,
          requestId: `bundle:${requestId}:${skill.key}`, fingerprint });
        result.skills.push({ key: skill.key, id });
      }
      for (const agent of bundle.agents) {
        const id = randomUUID();
        const selection = capabilitySelection(agent.capabilities);
        catalog.agents.push({ id, revision: 1, archived: false, name: agent.name, description: agent.description,
          instructions: agent.instructions, provider: agent.provider, modelId: agent.modelId, thinkingLevel: agent.thinkingLevel,
          skills: agent.skills.map(key => ({ id: skillIds.get(key)!, revision: 1 })),
          extensions: selection.extensions, tools: selection.tools, connections: [],
          companyId: scope.companyId, savedBy: scope.userId, createdAt: now, updatedAt: now });
        result.agents.push({ key: agent.key, id });
      }
      receipts.imports.push({ companyId: scope.companyId, userId: scope.userId, requestId, fingerprint,
        packageId: bundle.id, packageVersion: bundle.version, importedAt: now, result });
      return detached(result);
    }, context);
  }

  private bundlePreview(bundle: PortableBundle): BundlePreview {
    const blockers: string[] = [];
    const warnings = ["Review instructions for private information before sharing. Credential fields are excluded, but text is not automatically redacted."];
    const registry = this.registry.snapshot();
    for (const agent of bundle.agents) {
      try {
        this.validateAgent({ name: agent.name, description: agent.description, instructions: agent.instructions,
          provider: agent.provider, modelId: agent.modelId, thinkingLevel: agent.thinkingLevel });
      } catch (error) {
        if (!(error instanceof RuntimeError)) throw error;
        blockers.push(`${agent.name}: ${error.message}`);
      }
      for (const capability of agent.capabilities) {
        const selection = capabilityDefinitions.find(item => item.id === capability);
        if (!selection) {
          blockers.push(`${agent.name}: unsupported capability ${capability}.`);
          continue;
        }
        const installed = selection.extensions.map(name => registry.extension(name));
        if (installed.some(extension => !extension) || selection.tools.some(name => !installed.some(extension => extension?.tools?.some(tool => tool.name === name))))
          blockers.push(`${agent.name}: capability ${capability} is unavailable.`);
      }
      if (agent.skills.length && !registry.extension(Skills.name)?.tools?.some(tool => tool.name === "load_skill"))
        blockers.push(`${agent.name}: assigned skills are unavailable on this installation.`);
      if (agent.omittedConnections) warnings.push(`${agent.name}: ${agent.omittedConnections} connection(s) excluded; configure new connections after import.`);
    }
    return { bundle, blockers, warnings };
  }

  async saveSkill(scope: RuntimeScope, input: SaveSkillInput): Promise<SkillDefinition> {
    this.requireCatalogOwner();
    const fingerprint = JSON.stringify([input.id, input.expectedRevision, input.name, input.description, input.instructions]);
    return this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      catalog.skills ??= [];
      const records = catalog.skills.filter(skill => skill.companyId === scope.companyId);
      const replay = records.find(skill => skill.savedBy === scope.userId && skill.requestId === input.requestId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw requestConflict();
        return publicSkill(replay);
      }
      const prior = records.findLast(skill => skill.id === input.id);
      if (input.id && !prior) throw new RuntimeError(404, "Skill not found.");
      if (prior && prior.revision !== input.expectedRevision) throw new RuntimeError(409, "The skill has changed. Reload before saving.");
      const now = Date.now();
      const skill: StoredSkill = { id: prior?.id ?? randomUUID(), revision: (prior?.revision ?? 0) + 1,
        name: input.name, description: input.description, instructions: input.instructions,
        createdAt: prior?.createdAt ?? now, updatedAt: now, companyId: scope.companyId,
        savedBy: scope.userId, requestId: input.requestId, fingerprint };
      catalog.skills.push(skill);
      return publicSkill(skill);
    }, context);
  }

  async agentConnections(scope: RuntimeScope, id: string) {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    const agent = latestAgent(catalog!, scope.companyId, id);
    if (!agent) throw new RuntimeError(404, "Agent not found.");
    return this.connections.status(id, managedIds(agent));
  }

  async reconnectAgentConnection(scope: RuntimeScope, agentId: string, connectionId: string) {
    const connections = await this.agentConnections(scope, agentId);
    if (!connections.some(connection => connection.id === connectionId)) throw new RuntimeError(404, "Connection not found.");
    return this.connections.reconnect(agentId, connectionId, connections.filter(isManagedConnection).map(connection => connection.id));
  }

  async listMcpConnections(scope: RuntimeScope): Promise<ManagedConnection[]> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    const latest = latestAgents(catalog!, scope.companyId);
    return (this.managed?.list(scope.companyId) ?? []).filter(record => record.ownerId === scope.userId || catalog!.connectionOwners?.[record.id])
      .map(record => {
        const assigned = catalog!.connectionOwners?.[record.id];
        const agent = assigned ? latest.get(assigned) : undefined;
        return { ...(this.connections.managedStatus(record.id) ?? { id: record.id, name: record.name, endpoint: record.endpoint, identity: record.identity,
          extension: `dispatch-mcp-oauth-${record.id}`, status: "disconnected" as const, checkedAt: null, tools: [], source: "managed" as const }),
          authorization: record.authorization, authentication: record.authentication, scopes: record.scopes, createdAt: record.createdAt, canManage: record.ownerId === scope.userId,
          ...(record.disconnectNotice ? { disconnectNotice: record.disconnectNotice } : {}),
          usedBy: agent ? [{ id: agent.id, name: agent.name }] : [], ...(record.error ? { error: record.error } : {}) };
      });
  }

  async startMcpConnections() { await this.connections.start(); }

  async refreshMcpConnections(id?: string) { await this.connections.reloadManaged(id); }

  async saveAgent(scope: RuntimeScope, input: SaveAgentInput): Promise<AgentDefinition> {
    this.requireCatalogOwner();
    this.validateAgent(input);
    const fingerprint = JSON.stringify([input.id, input.expectedRevision, input.name.trim(), input.description.trim(), input.instructions,
      input.provider, input.modelId, input.thinkingLevel, input.capabilities?.slice().sort(), input.connectionIds?.slice().sort(), !!input.applyConnectionsToExisting, ...(input.skills === undefined ? [] : [input.skills])]);
    return this.harness.commit(async (tx) => {
      const catalog = await tx.doc(CatalogDoc);
      const priorRequest = input.requestId ? catalog.agents.find(agent => agent.companyId === scope.companyId && agent.savedBy === scope.userId && agent.saveRequestId === input.requestId) : undefined;
      if (priorRequest) {
        if (priorRequest.saveFingerprint !== fingerprint) throw requestConflict();
        return publicAgent(priorRequest);
      }
      const prior = input.id ? latestAgent(catalog, scope.companyId, input.id) : undefined;
      if (input.id && !prior) throw new RuntimeError(404, "Agent not found.");
      if (prior?.archived) throw new RuntimeError(409, "This agent is archived. Create a new agent to use its configuration again.");
      if (prior && prior.revision !== input.expectedRevision) throw new RuntimeError(409, "The agent has changed. Reload it before saving.");
      const now = Date.now();
      const id = prior?.id ?? randomUUID();
      const skills = input.skills ?? prior?.skills ?? [];
      for (const selection of skills) {
        if (!catalog.skills?.some(skill => skill.companyId === scope.companyId && skill.id === selection.id && skill.revision === selection.revision))
          throw new RuntimeError(409, "A selected skill revision is unavailable. Reload the skills catalog.");
      }
      const selectedManaged = input.connectionIds ?? (prior ? managedIds(prior) : []);
      for (const connectionId of selectedManaged) {
        if (!prior || !managedIds(prior).includes(connectionId)) {
          if (!this.managed) throw new RuntimeError(503, "MCP connections are unavailable.");
          this.managed.requireAssignment(scope, connectionId);
        }
        const owner = catalog.connectionOwners?.[connectionId];
        if (owner && owner !== id) throw new RuntimeError(409, "That connection belongs to another agent. Add a separate connection for this agent.");
      }
      const selectedConnections = this.connections.forAgent(id, selectedManaged);
      if (selectedManaged.some(connectionId => !selectedConnections.some(connection => connection.id === connectionId && isManagedConnection(connection)))) throw new RuntimeError(409, "A selected connection is unavailable. Update it in Settings before saving.");
      catalog.connectionOwners ??= {};
      for (const connectionId of selectedManaged) catalog.connectionOwners[connectionId] = id;
      const selection = this.connections.selection(id, selectedManaged);
      let extensions = (prior?.extensions ?? []).filter(name => !isMcpExtension(name));
      let tools = (prior?.tools ?? []).filter(name => !isMcpTool(name));
      if (input.capabilities !== undefined) {
        extensions = extensions.filter(name => !capabilityExtensions.has(name));
        tools = tools.filter(name => !capabilityTools.has(name));
        const capabilities = capabilitySelection(input.capabilities);
        extensions.push(...capabilities.extensions);
        tools.push(...capabilities.tools);
      }
      const agent: StoredAgent = {
        id, name: input.name.trim(), description: input.description.trim(),
        instructions: input.instructions, provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel,
        skills, extensions: [...extensions, ...selection.extensions], tools: [...tools, ...selection.tools], connections: selectedConnections,
        revision: (prior?.revision ?? 0) + 1, archived: false, createdAt: prior?.createdAt ?? now, updatedAt: now, companyId: scope.companyId,
        ...(input.requestId ? { saveRequestId: input.requestId, saveFingerprint: fingerprint, savedBy: scope.userId } : {}),
      };
      catalog.agents.push(agent);
      if (input.applyConnectionsToExisting && prior) {
        for (const chat of catalog.chats.filter(chat => chat.companyId === scope.companyId)) {
          if (this.directoryOnly) {
            const actors = (await tx.doc(WorkerActorsDoc)).actors[chat.id] ?? [];
            for (const actor of actors.filter(actor => actor.definitionId === id && (!actor.membership || actor.membership === "active"))) {
              const desired = workerMcpSelection(publicAgent(agent));
              if (setWorkerMcpSelection(actor, desired)) (await tx.doc(WorkerInvitationsDoc)).rooms[chat.id].revision++;
            }
            continue;
          }
          const room = await tx.doc(SharedDoc, nativeId(chat.id));
          for (const member of room.members) {
            if (member.kind !== "agent" || member.agentDefinitionId !== id || !member.conversationId || !member.agent) continue;
            if (member.membership && member.membership !== "active") continue;
            member.pendingConnectionIds = [...selectedManaged];
          }
        }
      }
      return publicAgent(agent);
    }, context);
  }

  async managementGrants(principal: AuthPrincipal) {
    return this.harness.commit(async tx => ({ grants: await readGrants(tx, principal.companyId), history: await grantHistory(tx, principal),
      saves: detached((await tx.doc(ManagementReceiptsDoc)).receipts.filter(item => item.companyId === principal.companyId)) }), context);
  }

  async saveManagementGrant(principal: AuthPrincipal, input: unknown) {
    this.requireCatalogOwner();
    return this.harness.commit(tx => writeGrant(tx, principal, input, async input => {
      const catalog = await tx.doc(CatalogDoc);
      const editor = latestAgent(catalog, principal.companyId, input.editorId);
      const target = latestAgent(catalog, principal.companyId, input.targetId);
      if (!editor || editor.archived || editor.revision !== input.policy!.editorRevision) throw new ManagementError(409, "Reload the editor revision before granting access.");
      this.requireManagementTarget(target, input.editorId);
      if (input.policy!.action === "save" && !input.policy!.fields.length) throw new ManagementError(400, "Choose editable fields for a save grant.");
    }), context);
  }

  private requireManagementTarget(target: StoredAgent | undefined, editorId: string): asserts target is StoredAgent {
    if (!target || target.archived || target.id === editorId)
      throw new ManagementError(403, "This target is not eligible for management.");
  }

  private requireManagementGrant(catalog: Catalog, actor: ManagementActor, targetId: string, grants: Grant[]) {
    const grant = grants.find(item => item.editorId === actor.definitionId && item.targetId === targetId && item.policy);
    const editor = latestAgent(catalog, actor.companyId, actor.definitionId);
    if (!grant?.policy || !editor || editor.archived) throw new ManagementError(403, "No current management grant for this editor and target.");
    if (grant.policy.editorRevision !== actor.revision || editor.revision !== actor.revision)
      throw new ManagementError(403, `Grant is pinned to revision ${grant.policy.editorRevision}; current definition is ${editor.revision}, acting instance is ${actor.revision}. Wait for base adoption and explicitly re-grant the current revision.`);
    const target = latestAgent(catalog, actor.companyId, targetId);
    this.requireManagementTarget(target, actor.definitionId);
    return { grant, target };
  }

  private managementView(agent: StoredAgent) {
    return { id: agent.id, name: agent.name, description: agent.description, revision: agent.revision,
      instructions: agent.instructions, provider: agent.provider, modelId: agent.modelId, thinkingLevel: agent.thinkingLevel };
  }

  private async readManagedAgent(tx: Tx, instance: ConversationId, raw: unknown) {
    const input = managementReadSchema.parse(raw);
    const actor = await this.shared.managementActor(tx, instance);
    if (this.worker) {
      if (!this.workerManagement) throw new ManagementError(503, "Backend management service is unavailable.");
      return this.workerManagement.read(await this.remoteActor(tx, actor), detached(input));
    }
    return this.readManagedActor(tx, actor, input);
  }

  private async readManagedActor(tx: Tx, actor: ManagementActor, input: ReturnType<typeof managementReadSchema.parse>) {
    const catalog = await tx.doc(CatalogDoc);
    const grants = await readGrants(tx, actor.companyId);
    if (!input.targetId) {
      const targets = [];
      for (const candidate of grants.filter(grant => grant.editorId === actor.definitionId && grant.policy)) {
        try {
          const { grant, target } = this.requireManagementGrant(catalog, actor, candidate.targetId, grants);
          targets.push({ id: target.id, name: target.name, revision: target.revision, policy: grant.policy });
        } catch (error) { if (!(error instanceof ManagementError)) throw error; }
      }
      return detached({ targets: targets.slice(input.offset ?? 0, (input.offset ?? 0) + 100), total: targets.length,
        nextOffset: (input.offset ?? 0) + 100 < targets.length ? (input.offset ?? 0) + 100 : null });
    }
    const { grant, target } = this.requireManagementGrant(catalog, actor, input.targetId, grants);
    const selected = input.revision ? catalog.agents.find(agent => agent.companyId === actor.companyId && agent.id === target.id && agent.revision === input.revision) : target;
    if (!selected) throw new ManagementError(404, "Revision not found.");
    return detached({ agent: this.managementView(selected), policy: grant.policy });
  }

  private async saveManagedAgent(tx: Tx, instance: ConversationId, callId: string, raw: unknown) {
    const input = managementSaveSchema.parse(raw);
    const actor = await this.shared.managementActor(tx, instance);
    if (this.worker) {
      if (!this.workerManagement) throw new ManagementError(503, "Backend management service is unavailable.");
      return this.workerManagement.save(await this.remoteActor(tx, actor), callId, detached(input));
    }
    return this.saveManagedActor(tx, actor, callId, input);
  }

  private async saveManagedActor(tx: Tx, actor: ManagementActor | WorkerManagementActor, callId: string, input: ReturnType<typeof managementSaveSchema.parse>) {
    const catalog = await tx.doc(CatalogDoc);
    const receipts = await tx.doc(ManagementReceiptsDoc);
    const workerStoreId = "storeId" in actor ? actor.storeId : undefined;
    const fingerprint = JSON.stringify([input.targetId, input.expectedRevision, input.reason, input.evidence ?? [], input.restoreRevision ?? null,
      input.patch ? managementFields.filter(field => input.patch![field] !== undefined).map(field => [field, input.patch![field]]) : null]);
    // Durable call identity catches transport replay; operation identity also catches a new call retry.
    const receipt = receipts.receipts.find(item => item.companyId === actor.companyId && item.workerStoreId === workerStoreId && item.instanceId === String(actor.instanceId) &&
      (item.callId === callId || item.operationId === input.operationId));
    if (receipt) {
      if (receipt.fingerprint !== fingerprint || receipt.operationId !== input.operationId || receipt.definitionId !== actor.definitionId)
        throw new ManagementError(409, "Operation ID was already used with different content.");
      return managementReceipt(receipt);
    }
    const grants = await readGrants(tx, actor.companyId);
    const { grant, target } = this.requireManagementGrant(catalog, actor, input.targetId, grants);
    const policy = grant.policy!;
    if (policy.action !== "save") throw new ManagementError(403, "This grant permits reads only.");
    if (target.revision !== input.expectedRevision) throw new ManagementError(409, "The target changed. Reload before saving.");
    let patch = input.patch;
    if (input.restoreRevision) {
      const historical = catalog.agents.find(agent => agent.companyId === actor.companyId && agent.id === target.id && agent.revision === input.restoreRevision);
      if (!historical) throw new ManagementError(404, "Restore revision not found.");
      patch = Object.fromEntries(policy.fields.map(field => [field, historical[field]]));
    }
    const fields = Object.keys(patch!);
    if (fields.some(field => !policy.fields.includes(field as typeof managementFields[number]))) throw new ManagementError(403, "The patch includes a field outside this grant.");
    const now = Date.now();
    const recent = receipts.receipts.filter(item => item.companyId === actor.companyId && item.definitionId === actor.definitionId && item.at > now - 3_600_000).sort((a, b) => a.at - b.at);
    if (recent.length >= policy.maxSavesPerHour)
      throw new ManagementError(429, `The editor's limit of ${policy.maxSavesPerHour} committed saves per hour has been reached. Retry after ${new Date(recent[recent.length - policy.maxSavesPerHour].at + 3_600_000).toISOString()}.`);
    const next: StoredAgent = { ...detached(target), ...patch, revision: target.revision + 1, updatedAt: now };
    // Do not copy a human save receipt onto an agent-authored revision.
    delete next.savedBy; delete next.saveRequestId; delete next.saveFingerprint;
    this.validateAgent(next);
    catalog.agents.push(next);
    const outcome: ManagementReceipt = { companyId: actor.companyId, definitionId: actor.definitionId, revision: actor.revision,
      instanceId: String(actor.instanceId), roomId: String(actor.roomId), participantId: actor.participantId,
      ...("storeId" in actor ? { workerStoreId: actor.storeId, conversationKey: actor.conversationKey } : {}),
      operationId: input.operationId, callId, fingerprint, targetId: target.id, beforeRevision: target.revision, afterRevision: next.revision,
      at: now, reason: input.reason, evidence: input.evidence ?? [], fields, grantVersion: grant.version,
      ...(input.restoreRevision ? { restoreRevision: input.restoreRevision } : {}) };
    receipts.receipts.push(outcome);
    return managementReceipt(outcome);
  }

  async archiveAgent(scope: RuntimeScope, id: string, expectedRevision: number): Promise<AgentDefinition> {
    this.requireCatalogOwner();
    if (id === DEFAULT_AGENT_ID) throw new RuntimeError(400, "The default agent cannot be archived.");
    return this.harness.commit(async (tx) => {
      const catalog = await tx.doc(CatalogDoc);
      const prior = latestAgent(catalog, scope.companyId, id);
      if (!prior) throw new RuntimeError(404, "Agent not found.");
      if (prior.revision !== expectedRevision) throw new RuntimeError(409, "The agent has changed. Reload it before archiving.");
      const agent = { ...prior, revision: prior.revision + 1, archived: true, updatedAt: Date.now() };
      catalog.agents.push(agent);
      return publicAgent(agent);
    }, context);
  }

  get healthy(): boolean { return !this.closed && (!(this.storage instanceof PostgresStorage) || this.storage.healthy); }

  /** Caller has sealed and joined every worker RPC before asking to retire.
   * A UI summary or waitForIdle() omits background work and cannot authorize this.
   */
  async closeWorkerIfIdle(): Promise<boolean> {
    if (!this.worker || !this.healthy) throw new Error("Worker is not available for idle retirement.");
    const inspection = await this.harness.inspect(context);
    if (inspection.tasks.length || inspection.submissions.length || this.upgradeDrain || this.participantReportDrain
      || this.upgradeCatalogDirty || this.upgradeRooms.size || this.participantReportDirty) return false;
    // close() seals local reconciliation synchronously, before its first await.
    await this.close();
    return true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeUpgrades?.();
    await this.upgradeDrain;
    await this.participantReportDrain;
    try { await this.harness.close(context); } finally {
      try { await this.connections.close(); } finally { this.owner.release(); }
    }
  }

  private async authorize(scope: RuntimeScope, id: string) {
    this.requireWorkerRoom(scope, id);
    await this.harness.commit(async tx => { await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope)); }, context);
  }

  private async person(companyId: string, userId: string): Promise<CompanyPerson> {
    const person = await this.peopleDirectory?.get(companyId, userId);
    if (!person) throw new RuntimeError(404, "Company member not found.");
    return person;
  }

  // These are wakeup indexes only. Startup and each transaction re-read durable revision/member state.
  private queueUpgrades(publication: CommitPublication) {
    if (this.closed) return;
    for (const change of publication.changes) {
      if (change.type === "document" || change.type === "document.copy") {
        // Project instructions adopt independently of agent-definition revisions.
        if (change.record.kind === CatalogDoc.definition.kind || change.record.kind === ProjectsDoc.definition.kind) this.upgradeCatalogDirty = true;
        else if (change.record.kind === SharedDoc.definition.kind && change.conversationId) this.upgradeRooms.add(change.conversationId);
        else if (change.record.kind === LiveDoc.definition.kind || change.record.kind === InboxDoc.definition.kind) {
          const room = change.conversationId && this.pendingUpgradeRooms.get(change.conversationId);
          if (room) this.upgradeRooms.add(room);
        }
      } else if (change.type === "task") {
        const room = change.value.conversationId && this.pendingUpgradeRooms.get(change.value.conversationId);
        if (room) this.upgradeRooms.add(room);
      }
    }
    this.scheduleUpgrades();
  }

  private scheduleUpgrades() {
    if (this.closed || this.upgradeDrain || (!this.upgradeCatalogDirty && !this.upgradeRooms.size)) return;
    // Commit listeners must not call Session operations. Start reads after publication returns.
    this.upgradeDrain = Promise.resolve().then(async () => {
      while ((this.upgradeCatalogDirty || this.upgradeRooms.size) && !this.closed) {
        const rooms = this.upgradeCatalogDirty ? undefined : this.upgradeRooms;
        this.upgradeCatalogDirty = false;
        this.upgradeRooms = new Set();
        await this.reconcileUpgrades(rooms);
      }
    }).catch(() => { console.error("Agent upgrade reconciliation failed; pending revisions remain saved."); })
      .finally(() => { this.upgradeDrain = undefined; this.scheduleUpgrades(); });
  }

  private async reconcileUpgrades(rooms?: ReadonlySet<ConversationId>) {
    const catalog = (await this.harness.snapshot(CatalogDoc, context))!;
    const projects = (await this.harness.snapshot(ProjectsDoc, context))?.projects ?? {};
    for (const chat of catalog.chats) {
      const roomId = nativeId(chat.id);
      if (rooms && !rooms.has(roomId)) continue;
      const room = await this.harness.snapshot(SharedDoc, roomId, context);
      const projectRevision = room?.sharedProjectId ? projects[room.sharedProjectId]?.instructionsRevision ?? 0 : 0;
      for (const member of room?.members ?? []) {
        if (member.conversationId) this.pendingUpgradeRooms.delete(member.conversationId);
        if (member.kind !== "agent" || !member.agentDefinitionId || (member.membership && member.membership !== "active")) continue;
        const latest = latestAgent(catalog, chat.companyId, member.agentDefinitionId);
        if ((!latest || latest.archived || latest.revision === member.agentRevision) && projectRevision === (member.projectInstructionsRevision ?? 0)
          && !member.pendingConnectionIds && !member.pendingWorkerMcp && !member.connectionsRefreshPending) continue;
        // Index before awaiting the idle check, so a settling task cannot lose its wakeup.
        if (member.conversationId) this.pendingUpgradeRooms.set(member.conversationId, roomId);
        try {
          await this.harness.commit(async tx => {
            const current = (await tx.doc(SharedDoc, roomId)).members.find(item => item.id === member.id);
            if (current) await this.upgradeParticipant(tx, roomId, chat.companyId, current);
          }, context);
        } catch {
          // The failed configuration transaction rolls back before recording its safe public status.
          await this.harness.commit(async tx => {
            const current = (await tx.doc(SharedDoc, roomId)).members.find(item => item.id === member.id);
            const error = "Update could not be applied. It will retry at the next idle boundary.";
            if (current && current.upgradeError !== error) current.upgradeError = error;
          }, context);
        }
      }
    }
  }

  private async upgradeParticipant(tx: Tx, roomId: ConversationId, companyId: string, member: Member) {
    if (!member.conversationId || !member.agent || !member.agentDefinitionId || (member.membership && member.membership !== "active")) return;
    const catalog = await tx.doc(CatalogDoc);
    const latest = latestAgent(catalog, companyId, member.agentDefinitionId);
    const mapping = this.worker ? Object.values((await tx.doc(WorkerIdentityDoc)).mappings).find(mapping => mapping.participantId === member.id) : undefined;
    const desired = mapping ? catalog.agents.find(agent => agent.companyId === companyId && agent.id === member.agentDefinitionId && agent.revision === mapping.desiredRevision) : latest;
    const agent = latest && !latest.archived && (!this.worker || mapping) ? desired : undefined;
    const updateBase = agent && agent.revision !== member.agentRevision;
    const room = await tx.doc(SharedDoc, roomId);
    const project = room.sharedProjectId ? (await tx.doc(ProjectsDoc)).projects[room.sharedProjectId] : undefined;
    // Latest-only adoption: compare revisions before idle/task scans; intermediate revisions are never replayed.
    const updateProject = room.sharedProjectId !== undefined && (project?.instructionsRevision ?? 0) !== (member.projectInstructionsRevision ?? 0);
    if (!updateBase && !updateProject && !member.pendingConnectionIds && !member.pendingWorkerMcp && !member.connectionsRefreshPending) return;
    if (room.stopping) return;
    const id = member.conversationId;
    if ((await tx.doc(LiveDoc, id)).run || (await tx.doc(InboxDoc, id)).items.length || await this.hasUnfinishedAgentWork(tx, id, roomId)) return;
    if (member.pendingWorkerMcp) {
      if (!this.worker) throw new RuntimeError(409, "Worker MCP selection appeared in a native runtime.");
      await this.applyWorkerMcpSelection(tx, member, member.pendingWorkerMcp);
      delete member.pendingWorkerMcp;
    }
    if (member.pendingConnectionIds || member.connectionsRefreshPending) {
      const connected = await this.connections.bind(tx, id, member.agentDefinitionId, true, member.pendingConnectionIds, member.pendingConnectionIds !== undefined);
      member.agent.extensions = [...member.agent.extensions.filter(name => !isMcpExtension(name)), ...connected.extensions];
      member.agent.tools = [...member.agent.tools.filter(name => !isMcpTool(name)), ...connected.tools];
      member.agent.connections = await this.connections.boundConnections(tx, id);
      delete member.pendingConnectionIds;
      delete member.connectionsRefreshPending;
    }
    if (updateBase) {
      this.validateAgent(agent);
      // Connection authority is independent of base revision adoption.
      const configuration = { ...agent,
        extensions: [...(agent.extensions ?? []).filter(name => !isMcpExtension(name)), ...member.agent.extensions.filter(isMcpExtension)],
        tools: [...(agent.tools ?? []).filter(name => !isMcpTool(name)), ...member.agent.tools.filter(isMcpTool)],
      };
      const { extensions, tools, snapshots } = this.resolveConfiguration(catalog, companyId, configuration);
      const cwd = member.agent.cwd ?? (configuration.extensions.some(name => name === CodingTools.name || name === "dispatch-image-gen") ? member.workspaceDefault ?? this.workspaceDir : undefined);
      await configure(tx, id, {
        model: { provider: agent.provider, modelId: agent.modelId }, thinkingLevel: agent.thinkingLevel,
        instructions: [agent.instructions, ...(member.instanceInstructions ? ["## Instance instructions", member.instanceInstructions] : [])].filter(Boolean).join("\n\n"),
        extensions, tools, ...(cwd ? { cwd } : {}),
      });
      (await tx.doc(SkillBindingsDoc, id)).skills = snapshots;
      await this.shared.enable(tx, id);
      const connections = member.agent.connections;
      member.agent = { ...publicAgent(agent), connections, extensions: extensions.map(item => item.name), tools: tools.map(item => item.name), ...(cwd ? { cwd } : {}) };
      member.agentRevision = agent.revision;
    }
    // Independent of base adoption, including unchanged, archived or unmapped definitions.
    if (updateProject) await this.shared.bindProjectInstructions(tx, room, member);
    if (member.upgradeError) delete member.upgradeError;
    if (this.worker) await this.updateWorkerParticipantReport(tx);
  }

  private async hasUnfinishedAgentWork(tx: Tx, id: ConversationId, roomId: ConversationId) {
    if (id !== roomId) return hasUnfinishedTasks(tx, id);
    // Legacy agents share the room stream. Room deliveries/presence are not native agent work.
    const roomTasks = new Set([
      this.shared.delivery.definition.name, this.shared.legacyReporter.definition.name,
      this.shared.turns.expirePresence.definition.name, this.shared.turns.wait.definition.name,
      this.shared.contributions.guard.definition.name,
    ]);
    for (const status of ["pending", "running", "waiting", "completing"] as const) {
      let page = await tx.scanTasks({ conversationId: id, status }, 100);
      while (true) {
        if (page.items.some(task => !roomTasks.has(task.kind))) return true;
        if (!page.next) break;
        page = await tx.scanTasks({ conversationId: id, status }, 100, page.next);
      }
    }
    return false;
  }

  private resolveConfiguration(catalog: Catalog, companyId: string, agent: StoredAgent) {
    const registry = this.registry.snapshot();
    const extensions = (agent.extensions ?? []).map(name => {
      const found = registry.extension(name);
      if (!found) throw new RuntimeError(503, `Agent extension ${name} is unavailable.`);
      return found;
    });
    const tools = (agent.tools ?? []).map(name => {
      const found = extensions.flatMap(extension => extension.tools ?? []).find(tool => tool.name === name);
      if (!found) throw new RuntimeError(503, `Agent tool ${name} is unavailable.`);
      return found;
    });
    const snapshots = (agent.skills ?? []).map(selection => {
      const skill = catalog.skills?.find(skill => skill.companyId === companyId && skill.id === selection.id && skill.revision === selection.revision);
      if (!skill) throw new RuntimeError(409, "An assigned skill revision is unavailable.");
      return { id: skill.id, revision: skill.revision, name: skill.name, description: skill.description, instructions: skill.instructions };
    });
    if (snapshots.length) { extensions.push(Skills); tools.push(...Skills.tools!); }
    return { extensions, tools, snapshots };
  }

  private async createParticipant(tx: Tx, roomId: ConversationId, companyId: string, definitionId: string, revision?: number): Promise<Member> {
    this.requireConversationExecutor();
    if (this.worker && (companyId !== this.worker.scope.companyId || (this.boundRoomId && String(roomId) !== this.boundRoomId)))
      throw new RuntimeError(403, "Participant is outside this worker room.");
    const catalog = await tx.doc(CatalogDoc);
    const pinnedRevision = revision ?? (!this.boundRoomId ? this.worker?.initialAgentRevisions?.[definitionId] : undefined);
    const saved = pinnedRevision === undefined ? this.findAgent(catalog, { companyId }, definitionId)
      : catalog.agents.find(item => item.companyId === companyId && item.id === definitionId && item.revision === pinnedRevision);
    if (!saved) throw new RuntimeError(409, "Pinned worker agent revision is unavailable.");
    // Worker MCP selection is applied from the authoritative membership, not historical
    // definition names which may no longer have installed implementations after a rollout.
    const agent = this.worker ? { ...saved, extensions: (saved.extensions ?? []).filter(name => !isMcpExtension(name)), tools: (saved.tools ?? []).filter(name => !isMcpTool(name)) } : saved;
    this.validateAgent(agent);
    const { extensions, tools, snapshots } = this.resolveConfiguration(catalog, companyId, agent);
    const room = await tx.doc(SharedDoc, roomId);
    const project = room.sharedProjectId ? (await tx.doc(ProjectsDoc)).projects[room.sharedProjectId] : undefined;
    if (room.sharedProjectId && (!project || project.companyId !== companyId)) throw new RuntimeError(404, "Project not found.");
    const workspaceDefault = this.worker ? this.workspaceDir : project?.cwd ?? this.workspaceDir;
    const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
    if (snapshots.length) (await tx.doc(SkillBindingsDoc, record.id)).skills = snapshots;
    const cwd = agent.extensions?.some(name => name === CodingTools.name || name === "dispatch-image-gen") ? workspaceDefault : undefined;
    await configure(tx, record.id, { model: { provider: agent.provider, modelId: agent.modelId }, instructions: agent.instructions, thinkingLevel: agent.thinkingLevel, extensions, tools, ...(cwd ? { cwd } : {}) });
    if (!this.worker) await this.connections.bind(tx, record.id, definitionId, false, managedIds(agent));
    return { id: randomUUID(), kind: "agent", workspaceDefault, name: agent.name, joinedAt: Date.now(), agentDefinitionId: agent.id, agentRevision: agent.revision, conversationId: record.id, status: "idle", agent: { ...publicAgent(agent), extensions: extensions.map(extension => extension.name), tools: tools.map(tool => tool.name), ...(cwd ? { cwd } : {}) } };
  }

  private async configureConnections(companyId: string) {
    await this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      const latest = latestAgents(catalog, companyId);
      for (const agent of latest.values()) {
        const connections = this.connections.forAgent(agent.id, managedIds(agent));
        if (!connections.length && !agent.connections?.length) continue;
        const selection = this.connections.selection(agent.id, managedIds(agent));
        const extensions = [...(agent.extensions ?? []).filter(name => !isMcpExtension(name)), ...selection.extensions];
        const tools = [...(agent.tools ?? []).filter(name => !isMcpTool(name)), ...selection.tools];
        if (JSON.stringify([agent.connections, agent.extensions, agent.tools]) !== JSON.stringify([connections, extensions, tools])) {
          const { saveRequestId: _request, saveFingerprint: _fingerprint, savedBy: _savedBy, ...configuration } = agent;
          catalog.agents.push({ ...configuration, connections, extensions, tools, revision: agent.revision + 1, updatedAt: Date.now() });
        }
      }
      for (const chat of catalog.chats.filter(chat => chat.companyId === companyId)) {
        if (this.directoryOnly) {
          // Discovery refreshes tools for previously selected connections; it never grants
          // a latest definition's newly attached connection to older pinned participants.
          let changed = false;
          for (const actor of (await tx.doc(WorkerActorsDoc)).actors[chat.id] ?? []) {
            if (actor.membership && actor.membership !== "active") continue;
            const connections = this.connections.forAgent(actor.definitionId, managedIds(actor.configuration))
              .filter(current => actor.configuration.connections?.some(selected => selected.id === current.id && selected.extension === current.extension));
            const extensions = connections.map(connection => connection.extension);
            const tools = extensions.flatMap(name => this.registry.snapshot().extension(name)?.tools?.map(tool => tool.name) ?? []);
            changed = setWorkerMcpSelection(actor, { connections, extensions, tools }) || changed;
          }
          if (changed) (await tx.doc(WorkerInvitationsDoc)).rooms[chat.id].revision++;
          continue;
        }
        const room = await tx.doc(SharedDoc, nativeId(chat.id));
        for (const member of room.members) {
          if (member.kind !== "agent" || !member.conversationId || !member.agentDefinitionId || !member.agent) continue;
          if (!this.connections.has(member.agentDefinitionId) && !member.agent.extensions.some(isMcpExtension)) continue;
          if (member.membership && member.membership !== "active") continue;
          member.connectionsRefreshPending = true;
        }
      }
    }, context);
  }

  private async migrateWorkspaces(companyId: string) {
    const catalog = (await this.harness.snapshot(CatalogDoc, context))!;
    for (const chat of catalog.chats.filter(chat => chat.companyId === companyId)) {
      await this.harness.commit(async tx => {
        const roomId = nativeId(chat.id);
        const room = await tx.doc(SharedDoc, roomId);
        // Recovered deliveries and tools must keep the directory they were admitted against.
        if (await hasUnfinishedTasks(tx, roomId)) return;
        for (const member of room.members) {
          if (!member.conversationId || !member.agent?.extensions.includes(CodingTools.name) || member.workspaceDefault !== undefined) continue;
          const native = await tx.doc(AgentDoc, member.conversationId);
          if (native.cwd !== join(this.owner.directory, "workspaces", String(member.conversationId))) continue;
          if ((await tx.doc(InboxDoc, member.conversationId)).items.length) continue;
          if (await hasUnfinishedTasks(tx, member.conversationId)) continue;
          await configure(tx, member.conversationId, { cwd: this.workspaceDir });
          member.agent.cwd = this.workspaceDir;
        }
      }, context);
    }
  }

  private async initializePublicSummaries() {
    const catalog = (await this.harness.snapshot(CatalogDoc, context))!;
    for (const chat of catalog.chats) {
      while (!await this.harness.commit(tx => this.shared.initializeSummary(tx, nativeId(chat.id)), context)) {
        // Each page and cursor commit atomically. Restart resumes at the next page, before serving clients.
      }
    }
  }

  private async migrateChats() {
    const catalog = (await this.harness.snapshot(CatalogDoc, context))!;
    for (const chat of catalog.chats) {
      const roomId = nativeId(chat.id);
      await this.harness.commit(async tx => {
        await this.shared.turns.migrate(tx, roomId);
        await this.shared.migrateReplyHistory(tx, roomId);
        // Collaboration tools are application capabilities, including bounded attachment reads.
        for (const member of (await tx.doc(SharedDoc, roomId)).members) {
          if (member.kind === "agent" && member.conversationId) await this.shared.enable(tx, member.conversationId);
        }
      }, context);
      if ((await this.harness.snapshot(SharedDoc, roomId, context))?.companyId) continue;
      // Preserve orphaned historical authors without authorizing any new human identity.
      const human = await this.peopleDirectory?.get(chat.companyId, chat.userId) ?? { id: chat.userId, name: "Former member" };
      const conversation = (await this.harness.conversation(roomId, context))!;
      const native = await conversation.agent(context);
      const definition = catalog.agents.find(agent => agent.companyId === chat.companyId && agent.id === chat.agentDefinitionId && agent.revision === chat.agentRevision);
      const legacy: Member = { id: `agent:${chat.id}`, kind: "agent", name: chat.agentName ?? definition?.name ?? "Saved agent", joinedAt: chat.createdAt, agentDefinitionId: chat.agentDefinitionId, agentRevision: chat.agentRevision, conversationId: roomId, status: "idle", agent: { name: chat.agentName ?? definition?.name ?? "Saved agent", description: definition?.description ?? "", instructions: native.instructions ?? "", provider: native.model?.provider ?? "", modelId: native.model?.modelId ?? "", thinkingLevel: native.thinkingLevel ?? "off", extensions: native.extensions.map(extension => extension.name), tools: native.tools.map(tool => tool.name), ...(native.cwd ? { cwd: native.cwd } : {}) } };
      await this.harness.commit(tx => this.shared.migrate(tx, roomId, human, legacy, chat.companyId, { pinned: chat.pinned ?? false, archived: chat.archived ?? false }), context);
    }
  }

  private findAgent(catalog: Catalog, scope: Pick<RuntimeScope, "companyId">, id: string) {
    const agent = latestAgent(catalog, scope.companyId, id);
    if (!agent || agent.archived) throw new RuntimeError(404, "Agent not found.");
    return agent;
  }

  private validateAgent(agent: AgentDraft) {
    requireText(agent.name, "Agent name", 100);
    requireText(agent.description, "Description", 500, true);
    requireText(agent.instructions, "Instructions", 50_000, true);
    requireText(agent.provider, "Provider", 100);
    if (agent.provider === "openai-codex") throw new RuntimeError(400, "Select an OpenAI model.");
    requireText(agent.modelId, "Model", 200);
    const model = this.models.getModel(agent.provider, agent.modelId);
    if (!model) throw new RuntimeError(400, "This model is not available from the configured providers.");
    if (!getSupportedThinkingLevels(model).includes(agent.thinkingLevel)) throw new RuntimeError(400, "This model does not support the selected thinking level.");
  }
}

function managementReceipt(receipt: ManagementReceipt) {
  const { operationId, targetId, beforeRevision, afterRevision, at, grantVersion } = receipt;
  return { operationId, targetId, beforeRevision, afterRevision, at, grantVersion };
}

// Catalog revisions are append-only. Keep archived latest revisions in the lookup;
// callers decide whether their operation permits an archived definition.
function latestAgent(catalog: Catalog, companyId: string, id: string) {
  return catalog.agents.findLast(agent => agent.companyId === companyId && agent.id === id);
}

function latestAgents(catalog: Catalog, companyId: string) {
  const latest = new Map<string, StoredAgent>();
  for (const agent of catalog.agents) {
    if (agent.companyId === companyId) latest.set(agent.id, agent);
  }
  return latest;
}

function productionModels() {
  const models = createModels();
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  return models;
}

async function hasUnfinishedTasks(tx: Tx, conversationId: ConversationId) {
  for (const status of ["pending", "running", "waiting", "completing"] as const) {
    if ((await tx.scanTasks({ conversationId, status }, 1)).items.length) return true;
  }
  return false;
}

function nativeId(id: string): ConversationId {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new RuntimeError(404, "Conversation not found.");
  return Number(id) as ConversationId;
}

function owns(scope: RuntimeScope, chat: RuntimeScope) { return scope.companyId === chat.companyId && scope.userId === chat.userId; }
function publicAgent({ companyId: _companyId, savedBy: _savedBy, saveRequestId: _request, saveFingerprint: _fingerprint, ...agent }: StoredAgent): AgentDefinition {
  // Nested catalog values may be transaction proxies; detach before the transaction settles.
  return detached({ ...agent, extensions: agent.extensions ?? [], tools: agent.tools ?? [],
    capabilities: agentCapabilities(agent) });
}
function agentCapabilities(agent: Pick<StoredAgent, "extensions">) {
  return capabilityDefinitions.filter(item => agent.extensions?.includes(item.marker)
    || (agent.extensions?.includes("dispatch-web") && (item.id === "web-reading" || item.id === "web-search"))).map(item => item.id);
}
function workerMcpSelection(agent: Pick<AgentDefinition, "connections" | "extensions" | "tools">): WorkerMcpSelection {
  return detached({ connections: agent.connections ?? [], extensions: agent.extensions.filter(isMcpExtension), tools: agent.tools.filter(isMcpTool) });
}
function setWorkerMcpSelection(actor: Pick<ManagementActor, "configuration">, selection: WorkerMcpSelection): boolean {
  if (fingerprint(workerMcpSelection(actor.configuration)) === fingerprint(selection)) return false;
  actor.configuration.connections = detached(selection.connections);
  actor.configuration.extensions = [...actor.configuration.extensions.filter(name => !isMcpExtension(name)), ...selection.extensions];
  actor.configuration.tools = [...actor.configuration.tools.filter(name => !isMcpTool(name)), ...selection.tools];
  return true;
}
function managedIds(agent: Pick<AgentDefinition, "connections">) { return (agent.connections ?? []).filter(isManagedConnection).map(connection => connection.id); }
function requireText(value: unknown, field: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) throw new RuntimeError(400, `${field} must be ${allowEmpty ? "at most" : "between 1 and"} ${max} characters.`);
}

function requestConflict() { return new RuntimeError(409, "This request ID was already used with different content. Use a new request ID."); }

function publicSkill({ companyId: _company, savedBy: _user, requestId: _request, fingerprint: _fingerprint, ...skill }: StoredSkill): SkillDefinition { return skill; }

/** Explicit capability selections only; importing never installs registry code. */
function capabilitySelection(capabilities: readonly string[]) {
  const selected = capabilityDefinitions.filter(item => capabilities.includes(item.id));
  return { extensions: selected.flatMap(item => item.extensions), tools: selected.flatMap(item => item.tools) };
}

function sameNames(left: string[], right: string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function bundleFingerprint(bundle: PortableBundle) {
  // Fixed field order makes retries independent of JSON object property ordering.
  return createHash("sha256").update(JSON.stringify([bundle.formatVersion, bundle.id, bundle.version,
    bundle.agents.map(agent => [agent.key, agent.name, agent.description, agent.instructions, agent.provider,
      agent.modelId, agent.thinkingLevel, agent.capabilities, agent.skills, agent.omittedConnections]),
    bundle.skills.map(skill => [skill.key, skill.name, skill.description, skill.instructions])])).digest("hex");
}

function publicInstallation(item: TrackedBundle): GitHubInstallation {
  const { id, revision, packageId, packageVersion, source, digest, updatedAt } = item;
  return detached({ id, revision, packageId, packageVersion, source, digest, updatedAt });
}
function portableSkill(key: string, skill: Pick<StoredSkill, "name" | "description" | "instructions">): PortableSkill {
  return { key, name: skill.name, description: skill.description, instructions: skill.instructions };
}
function skillContent(skill: Pick<StoredSkill, "name" | "description" | "instructions">) {
  return JSON.stringify([skill.name, skill.description, skill.instructions]);
}
function agentContent(agent: Pick<StoredAgent, "name" | "description" | "instructions" | "provider" | "modelId" | "thinkingLevel" | "skills" | "extensions" | "tools">) {
  return { name: agent.name, description: agent.description, instructions: agent.instructions, provider: agent.provider,
    modelId: agent.modelId, thinkingLevel: agent.thinkingLevel, skills: agent.skills ?? [],
    extensions: (agent.extensions ?? []).filter(name => !isMcpExtension(name)).sort(), tools: (agent.tools ?? []).filter(name => !isMcpTool(name)).sort() };
}
function agentUpstreamContent(agent: PortableAgent) {
  return JSON.stringify([agent.name, agent.description, agent.instructions, agent.provider, agent.modelId, agent.thinkingLevel,
    [...agent.capabilities].sort(), agent.skills]);
}
function portableTrackedAgent(key: string, agent: StoredAgent, skills: TrackedBundleEntry[]): PortableAgent {
  return { key, name: agent.name, description: agent.description, instructions: agent.instructions, provider: agent.provider,
    modelId: agent.modelId, thinkingLevel: agent.thinkingLevel, capabilities: publicAgent(agent).capabilities ?? [],
    skills: (agent.skills ?? []).map(selection => {
      const entry = skills.find(item => item.id === selection.id);
      return entry ? `${entry.key} (local revision ${selection.revision})` : `local skill (revision ${selection.revision})`;
    }), omittedConnections: agent.connections?.length ?? 0 };
}

/** Stable JSON identity across object-key order; arrays preserve semantically meaningful order. */
function fingerprint(value: unknown): string {
  const ordered = (input: unknown): unknown => Array.isArray(input) ? input.map(ordered)
    : input !== null && typeof input === "object" ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, ordered(value)])) : input;
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}
