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
import { AgentDoc, configure, createRegistry, defineDoc, Harness, InboxDoc, LiveDoc, type CommitPublication, type ConversationId, type HarnessSettings, type RegistryReader, type Storage, type Tx } from "@earendil-works/pi-durable";
import { openPiStorage, type PiStorageConfig } from "./storage/open.js";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { CreateAgentInstanceInput, CreateAgentInstanceResult, AddParticipantsInput, CompanyPerson, SendMessageInput, AgentDefinition, AgentDraft, ChatSnapshot, ChatSummary, CreateChatInput, CreateProjectInput, Project, RuntimeScope, SaveAgentInput, UpdateChatInput, ManagedConnection, SkillDefinition, SaveSkillInput, SaveProjectInput } from "../src/shared/contracts.js";
import type { BundleExportInput, BundleImportResult, BundlePreview, PortableBundle, PortableAgent, PortableSkill } from "../src/shared/bundles.js";
import type { GitHubInstallation, GitHubBundleSource, GitHubBundlePreview, GitHubBundleApplyInput, GitHubBundleApplyResult } from "../src/shared/github-bundles.js";
import { isManagedConnection } from "../src/shared/contracts.js";
import { AttachmentsDoc, AttachmentStore, AttachmentError, attachmentMetadata } from "./attachments.js";
import { acquireRuntimeOwner } from "./runtime-owner.js";
import { ProjectsDoc, projectAccess, requireProjectAccess, type SharedProjectRecord } from "./project-access.js";
import { createWebResearch } from "./extensions/web.js";
import { createWebBackend } from "./web/backend.js";
import { Skills, SkillBindingsDoc } from "./extensions/skills.js";
import { imageGenerationSkill } from "./skills/image-generation.js";
import { agentBrowserSkill, dogfoodSkill } from "./skills/agent-browser/index.js";
import { createImageGen } from "./extensions/image-gen.js";
import { Coding } from "./extensions/coding.js";
import { SharedConversations, SharedDoc, type Member, type PeopleDirectory } from "./collaboration/shared.js";
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
  { id: "files-and-commands", marker: CodingTools.name, extensions: [Coding.name, CodingTools.name], tools: ["read", "write", "edit", "bash"] },
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
type ManagementReceipt = {
  companyId: string; definitionId: string; revision: number; instanceId: string; participantId: string; roomId: string;
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
};

/** Authentication supplies the scope; Pi remains the only owner of transcripts and work. */
export class DispatchRuntime {
  private harness: Harness;
  private models: Models;
  private registry: RegistryReader;
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

  private constructor(harness: Harness, storage: Storage, models: Models, owner: Awaited<ReturnType<typeof acquireRuntimeOwner>>, registry: RegistryReader, shared: SharedConversations, connections: AgentConnections, private readonly workspaceDir: string, private readonly attachments: AttachmentStore, peopleDirectory?: PeopleDirectory) {
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

  static async open(options: RuntimeOptions) {
    if (!(await stat(options.workspaceDir)).isDirectory()) throw new Error("DISPATCH_WORKSPACE_DIR must point to an existing directory.");
    const owner = await acquireRuntimeOwner(options.stateDir);
    let storage: Storage | undefined;
    let connections: AgentConnections | undefined;
    try {
      options.mcpConnections?.initialize();
      const models = options.models ?? productionModels();
      storage = await openPiStorage(owner.directory, options.piStorage ?? { kind: "sqlite" });
      const registry = createRegistry();
      let runtime: DispatchRuntime;
      const attachments = new AttachmentStore(join(owner.directory, "attachments"));
      const shared = new SharedConversations((tx, roomId, companyId, definitionId) => runtime.createParticipant(tx, roomId, companyId, definitionId), attachments, {
        read: (tx, instance, input) => runtime.readManagedAgent(tx, instance, input),
        save: (tx, instance, callId, input) => runtime.saveManagedAgent(tx, instance, callId, input),
      });
      registry.install(shared.extension);
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
          return { companyId: actor.companyId, definitionId: actor.definitionId };
        }, context);
        signal?.throwIfAborted();
        return authorized;
      };
      const web = createWebResearch(createWebBackend(), {
        authorize: async (instanceId, capability, signal) => Boolean(await authorizeWeb(instanceId, capability, signal)),
        search: async (instanceId, query, signal) => {
          const authorized = await authorizeWeb(instanceId, "web-search", signal);
          const key = authorized ? options.mcpConnections?.resolveSearchSecret(authorized.companyId, authorized.definitionId) : undefined;
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
      runtime = new DispatchRuntime(harness, storage, models, owner, registry, shared, connections, options.workspaceDir, attachments, options.peopleDirectory);
      runtime.managed = options.mcpConnections;
      runtime.readAllProjectUserIds = new Set(options.readAllProjectUserIds ?? []);
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
      await runtime.migrateChats();
      await runtime.initializePublicSummaries();
      await runtime.migrateWorkspaces(options.companyId);
      await connections.open(harness);
      await runtime.configureConnections(options.companyId);
      connections.onChanged = () => runtime.configureConnections(options.companyId);
      await runtime.reconcileUpgrades();
      runtime.unsubscribeUpgrades = harness.subscribeCommits(publication => runtime.queueUpgrades(publication));
      harness.resume();
      return runtime;
    } catch (error) {
      await connections?.close();
      await storage?.close(context);
      owner.release();
      throw error;
    }
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
    return { id: project.id, name: project.name, ...(project.cwd ? { cwd: project.cwd } : {}), createdAt: project.createdAt, kind: "shared", revision: project.revision,
      members: project.members.map(({ userId, role }) => ({ userId, role })), defaultAgentDefinitionIds: [...project.defaultAgentDefinitionIds], canManage: access.manage, canParticipate: access.participate };
  }

  async createProject(scope: RuntimeScope, input: CreateProjectInput): Promise<Project> {
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

  private get projectArchiveStore() { return new ProjectArchiveStore(join(this.owner.directory, "project-archives")); }

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
        const presentation = await this.shared.presentation(tx, nativeId(chatId));
        const attachments = await tx.doc(AttachmentsDoc, nativeId(chatId));
        for (const message of presentation.messages) for (const file of message.attachments ?? []) {
          if (!attachments.records[file.id] || attachments.records[file.id].private) throw new RuntimeError(409, "Public attachment metadata is unavailable.");
        }
        chats.push({ id: chatId, title: stored.displayTitle ?? stored.title, messages: presentation.messages,
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

  async saveProject(scope: RuntimeScope, id: string, input: SaveProjectInput): Promise<Project> {
    const cwd = input.cwd === undefined ? undefined : input.cwd?.trim() || null;
    if (cwd && (cwd.length > 4096 || cwd.includes("\0") || !isAbsolute(cwd))) {
      throw new RuntimeError(400, "Working directory must be an absolute path on the service host.");
    }
    const key = JSON.stringify([scope.companyId, scope.userId, id, input.requestId]);
    // Preserve pre-cwd fingerprints for clients that omit the new field.
    const fields = [input.expectedRevision, input.name, input.members, input.defaultAgentDefinitionIds];
    const fingerprint = JSON.stringify(cwd === undefined ? fields : [...fields, cwd]);
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
    await Promise.all(input.members.map(member => this.person(scope.companyId, member.userId)));
    return this.harness.commit(async tx => {
      const prior = await replay(tx);
      if (prior) return prior;
      const current = await requireProjectAccess(tx, scope, id, "manage", this.readAll(scope));
      if (current.revision !== input.expectedRevision) throw new RuntimeError(409, "Project changed. Reload before saving.");
      const catalog = await tx.doc(CatalogDoc);
      for (const agentId of input.defaultAgentDefinitionIds) this.findAgent(catalog, scope, agentId);
      const project: SharedProjectRecord = { ...current, name: input.name, members: input.members, defaultAgentDefinitionIds: input.defaultAgentDefinitionIds,
        revision: current.revision + 1, updatedAt: Date.now() };
      if (cwd !== undefined) {
        if (cwd === null) delete project.cwd;
        else project.cwd = normalize(cwd);
      }
      const doc = await tx.doc(ProjectsDoc);
      doc.projects[id] = project; doc.requests[key] = { fingerprint, projectId: project.id };
      return this.projectSummary(project, scope);
    }, context);
  }

  async createChat(scope: RuntimeScope, input: CreateChatInput): Promise<ChatSnapshot> {
    requireText(input.requestId, "Request ID", 200);
    const explicitTitle = Boolean(input.title?.trim());
    const title = input.title?.trim() || "New conversation";
    const requestedAgents = input.agentDefinitionIds ?? (input.agentDefinitionId ? [input.agentDefinitionId] : undefined);
    let agentIds = [...new Set(requestedAgents ?? [DEFAULT_AGENT_ID])];
    const creationFingerprint = input.sharedProjectId ? JSON.stringify([title, input.sharedProjectId, requestedAgents ?? null]) : undefined;
    for (const agentId of agentIds) requireText(agentId, "Agent ID", 200);
    requireText(title, "Title", 200);
    const human = await this.person(scope.companyId, scope.userId);
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
        const project = await requireProjectAccess(tx, scope, input.sharedProjectId, "participate", this.readAll(scope));
        agentIds = [...new Set(requestedAgents ?? project.defaultAgentDefinitionIds)];
      }
      for (const agentId of agentIds) this.validateAgent(this.findAgent(catalog, scope, agentId));
      const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await this.shared.initialize(tx, record.id, scope.companyId, human, agentIds, { pinned: false, archived: false }, input.sharedProjectId ?? undefined);
      const first = agentIds.length ? this.findAgent(catalog, scope, agentIds[0]) : undefined;
      const id = String(record.id);
      catalog.chats.push({ ...(creationFingerprint ? { creationFingerprint } : {}), id, title, creationTitleExplicit: explicitTitle, ...(explicitTitle ? { displayTitle: title } : {}), creationAgentIds: agentIds, creationAgentsOmitted: requestedAgents === undefined, createdAt: Date.now(), agentDefinitionId: first?.id ?? "", agentRevision: first?.revision ?? 0, agentName: first?.name ?? "People", companyId: scope.companyId, userId: scope.userId, requestId: input.requestId });
      return id;
    }, context);
    return this.getChat(scope, id);
  }

  async updateChat(scope: RuntimeScope, id: string, input: UpdateChatInput): Promise<ChatSnapshot> {
    await this.authorize(scope, id);
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
    await this.authorize(scope, id);
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
    await this.authorize(scope, id);
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
    // Authorize and read all participating streams on the same native commit line.
    return this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      const chat = catalog.chats.find(item => item.id === id && item.companyId === scope.companyId)!;
      const room = await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      const presentation = await this.shared.presentation(tx, nativeId(id), {});
      delete presentation.page;
      for (const participant of presentation.participants) {
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
    return this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      return { ...(await this.shared.presentation(tx, nativeId(id), query)).page!, revision: this.commitRevision };
    }, context);
  }

  async publicDetail(scope: RuntimeScope, id: string, kind: "message" | "activity", itemId: string) {
    return this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      const presentation = await this.shared.presentation(tx, nativeId(id));
      const value = kind === "message" ? presentation.messages.find(item => item.id === itemId || item.aliases?.includes(itemId)) : presentation.activities.find(item => item.id === itemId);
      if (!value) throw new RuntimeError(404, "History item unavailable.");
      return value;
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
      deliver: (emit: () => void) => this.harness.commit(async tx => {
        await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
        emit();
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
    const attachment = await this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "read", this.readAll(scope));
      const record = (await tx.doc(AttachmentsDoc, nativeId(id))).records[attachmentId];
      if (!record || record.private) throw new AttachmentError(404, "Attachment not found.");
      return attachmentMetadata(record);
    }, context);
    return { attachment, bytes: await this.attachments.read(attachment) };
  }

  async submit(scope: RuntimeScope, id: string, input: SendMessageInput) {
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

  async composing(scope: RuntimeScope, id: string, input: { clientId: string; sequence: number; active: boolean }) {
    await this.authorize(scope, id);
    const person = await this.person(scope.companyId, scope.userId);
    await this.harness.commit(async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      await this.shared.ensureHuman(tx, nativeId(id), person);
      await this.shared.turns.composing(tx, nativeId(id), `human:${scope.userId}`, input.clientId, input.sequence, input.active);
    }, context);
  }

  async addParticipants(scope: RuntimeScope, id: string, input: AddParticipantsInput) {
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
    requireText(participantId, "Participant ID", 200);
    await this.authorize(scope, id);
    const person = await this.person(scope.companyId, scope.userId);
    await this.shared.remove(nativeId(id), participantId, `human:${scope.userId}`, async tx => {
      await this.shared.authorize(tx, scope, nativeId(id), "participate", this.readAll(scope));
      await this.shared.ensureHuman(tx, nativeId(id), person);
    });
    return this.getChat(scope, id);
  }

  async stop(scope: RuntimeScope, id: string) {
    await this.authorize(scope, id);
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

  async refreshMcpConnections(id?: string) { await this.connections.reloadManaged(id); }

  async saveAgent(scope: RuntimeScope, input: SaveAgentInput): Promise<AgentDefinition> {
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
    const catalog = await tx.doc(CatalogDoc);
    const receipts = await tx.doc(ManagementReceiptsDoc);
    const fingerprint = JSON.stringify([input.targetId, input.expectedRevision, input.reason, input.evidence ?? [], input.restoreRevision ?? null,
      input.patch ? managementFields.filter(field => input.patch![field] !== undefined).map(field => [field, input.patch![field]]) : null]);
    // Durable call identity catches transport replay; operation identity also catches a new call retry.
    const receipt = receipts.receipts.find(item => item.companyId === actor.companyId && item.instanceId === String(actor.instanceId) &&
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
      operationId: input.operationId, callId, fingerprint, targetId: target.id, beforeRevision: target.revision, afterRevision: next.revision,
      at: now, reason: input.reason, evidence: input.evidence ?? [], fields, grantVersion: grant.version,
      ...(input.restoreRevision ? { restoreRevision: input.restoreRevision } : {}) };
    receipts.receipts.push(outcome);
    return managementReceipt(outcome);
  }

  async archiveAgent(scope: RuntimeScope, id: string, expectedRevision: number): Promise<AgentDefinition> {
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

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeUpgrades?.();
    await this.upgradeDrain;
    try { await this.harness.close(context); } finally {
      try { await this.connections.close(); } finally { this.owner.release(); }
    }
  }

  private async authorize(scope: RuntimeScope, id: string) {
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
        if (change.record.kind === CatalogDoc.definition.kind) this.upgradeCatalogDirty = true;
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
    for (const chat of catalog.chats) {
      const roomId = nativeId(chat.id);
      if (rooms && !rooms.has(roomId)) continue;
      const room = await this.harness.snapshot(SharedDoc, roomId, context);
      for (const member of room?.members ?? []) {
        if (member.conversationId) this.pendingUpgradeRooms.delete(member.conversationId);
        if (member.kind !== "agent" || !member.agentDefinitionId || (member.membership && member.membership !== "active")) continue;
        const latest = latestAgent(catalog, chat.companyId, member.agentDefinitionId);
        if ((!latest || latest.archived || latest.revision === member.agentRevision) && !member.pendingConnectionIds && !member.connectionsRefreshPending) continue;
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
    const agent = latest && !latest.archived ? latest : undefined;
    const updateBase = agent && agent.revision !== member.agentRevision;
    if (!updateBase && !member.pendingConnectionIds && !member.connectionsRefreshPending) return;
    const id = member.conversationId;
    if ((await tx.doc(LiveDoc, id)).run || (await tx.doc(InboxDoc, id)).items.length || await this.hasUnfinishedAgentWork(tx, id, roomId)) return;
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
    if (member.upgradeError) delete member.upgradeError;
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

  private async createParticipant(tx: Tx, roomId: ConversationId, companyId: string, definitionId: string): Promise<Member> {
    const catalog = await tx.doc(CatalogDoc);
    const agent = this.findAgent(catalog, { companyId }, definitionId);
    this.validateAgent(agent);
    const { extensions, tools, snapshots } = this.resolveConfiguration(catalog, companyId, agent);
    const room = await tx.doc(SharedDoc, roomId);
    const project = room.sharedProjectId ? (await tx.doc(ProjectsDoc)).projects[room.sharedProjectId] : undefined;
    if (room.sharedProjectId && (!project || project.companyId !== companyId)) throw new RuntimeError(404, "Project not found.");
    const workspaceDefault = project?.cwd ?? this.workspaceDir;
    const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
    if (snapshots.length) (await tx.doc(SkillBindingsDoc, record.id)).skills = snapshots;
    const cwd = agent.extensions?.some(name => name === CodingTools.name || name === "dispatch-image-gen") ? workspaceDefault : undefined;
    await configure(tx, record.id, { model: { provider: agent.provider, modelId: agent.modelId }, instructions: agent.instructions, thinkingLevel: agent.thinkingLevel, extensions, tools, ...(cwd ? { cwd } : {}) });
    await this.connections.bind(tx, record.id, definitionId, false, managedIds(agent));
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
