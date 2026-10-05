import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { configure, createRegistry, defineDoc, Harness, type ConversationId, type HarnessSettings, type RegistryReader, type Storage, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { AddParticipantsInput, CompanyPerson, SendMessageInput, AgentDefinition, AgentDraft, ChatSnapshot, ChatSummary, CreateChatInput, CreateProjectInput, Project, RuntimeScope, UpdateChatInput } from "../src/shared/contracts.js";
import { acquireRuntimeOwner } from "./runtime-owner.js";
import { Coding } from "./extensions/coding.js";
import { SharedConversations, SharedDoc, type Member, type PeopleDirectory } from "./collaboration/shared.js";

const context = BACKGROUND_CONTEXT;
type StoredChat = Omit<ChatSummary, "status" | "error" | "updatedAt" | "revision" | "agentName" | "pinned" | "archived" | "projectId"> & { pinned?: boolean; archived?: boolean; agentName?: string; projectId?: string | null; creationProjectId?: string | null; companyId: string; userId: string; requestId: string; creationAgentIds?: string[] };
type StoredAgent = Omit<AgentDefinition, "extensions" | "tools"> & { companyId: string; extensions?: string[]; tools?: string[] };
type StoredProject = Project & { companyId: string; userId: string; requestId: string };
type Catalog = { chats: StoredChat[]; agents: StoredAgent[]; projects?: StoredProject[]; runtimeInstance?: string };
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
  companyId: string;
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
  private shared: SharedConversations;
  private peopleDirectory?: PeopleDirectory;

  private constructor(harness: Harness, storage: Storage, models: Models, owner: Awaited<ReturnType<typeof acquireRuntimeOwner>>, registry: RegistryReader, shared: SharedConversations, peopleDirectory?: PeopleDirectory) {
    this.shared = shared;
    this.peopleDirectory = peopleDirectory;
    shared.bind(harness, storage);
    shared.availableAgents = async companyId => (await this.listAgents({ companyId, userId: "" })).filter(agent => !agent.archived).map(({id,name,description}) => ({id,name,description}));
    this.harness = harness;
    this.models = models;
    this.registry = registry;
    this.owner = owner;
    harness.subscribeCommits((publication) => { this.commitRevision = publication.seq; });
  }

  static async open(options: RuntimeOptions) {
    const owner = await acquireRuntimeOwner(options.stateDir);
    let storage: Storage | undefined;
    try {
      const models = options.models ?? productionModels();
      const filename = join(owner.directory, "pi.sqlite");
      storage = await openNodeSqliteStorage(filename);
      await chmod(filename, 0o600);
      const registry = createRegistry();
      let runtime: DispatchRuntime;
      const shared = new SharedConversations((tx, roomId, companyId, definitionId) => runtime.createParticipant(tx, roomId, companyId, definitionId));
      registry.install(shared.extension);
      registry.install(CodingTools);
      registry.install(Coding);
      const harness = await Harness.open(storage, {
        models, registry, settings: options.settings,
        env: async ({ cwd }) => {
          if (!cwd) return undefined;
          await mkdir(cwd, { recursive: true, mode: 0o700 });
          // A local working directory organizes files; it is not a filesystem or process sandbox.
          return new NodeExecutionEnv({ cwd });
        },
      }, context);
      runtime = new DispatchRuntime(harness, storage, models, owner, registry, shared, options.peopleDirectory);
      // Seed once and publish a real commit before recovery so snapshots use Pi's persisted sequence.
      await harness.commit(async (tx) => {
        const catalog = await tx.doc(CatalogDoc);
        if (!catalog.agents.some(agent => agent.companyId === options.companyId && agent.id === "default")) {
          const now = Date.now();
          const agent: StoredAgent = {
            id: "default", companyId: options.companyId, name: "Dispatch", description: "General-purpose conversation assistant.",
            instructions: "You are Dispatch, a thoughtful assistant helping people solve problems. Be accurate, direct, and useful. Explain uncertainty and never claim to have performed actions you cannot perform.",
            provider: options.provider ?? "openai", modelId: options.modelId ?? "gpt-6-sol",
            thinkingLevel: options.thinkingLevel ?? "off", revision: 1, archived: false,
            createdAt: now, updatedAt: now,
          };
          runtime.validateAgent(agent);
          catalog.agents.push(agent);
        }
        if (!catalog.agents.some(agent => agent.companyId === options.companyId && agent.id === "developer")) {
          const defaults = runtime.findAgent(catalog, { companyId: options.companyId }, "default");
          const now = Date.now();
          catalog.agents.push({
            id: "developer", companyId: options.companyId, name: "Developer",
            description: "Builds, debugs, and improves software in a coding workspace.",
            instructions: "Inspect the project and its instructions before changing code. Make focused changes, preserve existing work, and explain what changed and how it was checked. Be clear about anything you could not verify.",
            provider: defaults.provider, modelId: defaults.modelId, thinkingLevel: defaults.thinkingLevel,
            extensions: [Coding.name, CodingTools.name], tools: ["read", "write", "edit", "bash"],
            revision: 1, archived: false, createdAt: now, updatedAt: now,
          });
        }
        catalog.runtimeInstance = randomUUID();
      }, context);
      await runtime.migrateChats();
      harness.resume();
      return runtime;
    } catch (error) {
      await storage?.close(context);
      owner.release();
      throw error;
    }
  }

  async listChats(scope: RuntimeScope): Promise<ChatSummary[]> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    const visible = [];
    for (const chat of catalog!.chats.filter(chat => chat.companyId === scope.companyId)) {
      const state = await this.harness.snapshot(SharedDoc, nativeId(chat.id), context);
      if (state?.members.some(member => member.userId === scope.userId)) visible.push(chat);
    }
    const summaries = await Promise.all(visible.map(async chat => (await this.getChat(scope, chat.id)).conversation));
    return summaries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }

  async listProjects(scope: RuntimeScope): Promise<Project[]> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    return (catalog!.projects ?? []).filter(project => owns(scope, project)).map(projectSummary)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProject(scope: RuntimeScope, input: CreateProjectInput): Promise<Project> {
    requireText(input.requestId, "Request ID", 200);
    const name = input.name.trim();
    requireText(name, "Project name", 100);
    return this.harness.commit(async (tx) => {
      const catalog = await tx.doc(CatalogDoc);
      if (!catalog.projects) catalog.projects = [];
      const projects = catalog.projects;
      const existing = projects.find(project => owns(scope, project) && project.requestId === input.requestId);
      if (existing) {
        if (existing.name !== name) throw requestConflict();
        return projectSummary(existing);
      }
      const project = { id: randomUUID(), name, createdAt: Date.now(), companyId: scope.companyId, userId: scope.userId, requestId: input.requestId };
      projects.push(project);
      return projectSummary(project);
    }, context);
  }

  async createChat(scope: RuntimeScope, input: CreateChatInput): Promise<ChatSnapshot> {
    requireText(input.requestId, "Request ID", 200);
    const title = input.title?.trim() || "New conversation";
    const projectId = input.projectId ?? null;
    const agentIds = [...new Set(input.agentDefinitionIds ?? [input.agentDefinitionId ?? "default"])];
    for (const agentId of agentIds) requireText(agentId, "Agent ID", 200);
    requireText(title, "Title", 200);
    const human = await this.person(scope.companyId, scope.userId);
    const id = await this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      const existing = catalog.chats.find(chat => owns(scope, chat) && chat.requestId === input.requestId);
      if (existing) {
        if (existing.title !== title || JSON.stringify([...(existing.creationAgentIds ?? [existing.agentDefinitionId])].sort()) !== JSON.stringify([...agentIds].sort()) || (existing.creationProjectId ?? null) !== projectId) throw requestConflict();
        return existing.id;
      }
      if (projectId !== null) this.findProject(catalog, scope, projectId);
      for (const agentId of agentIds) this.validateAgent(this.findAgent(catalog, scope, agentId));
      const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await this.shared.initialize(tx, record.id, scope.companyId, human, agentIds, { projectId, pinned: false, archived: false });
      const first = agentIds.length ? this.findAgent(catalog, scope, agentIds[0]) : undefined;
      const id = String(record.id);
      catalog.chats.push({ id, title, projectId, creationProjectId: projectId, creationAgentIds: agentIds, createdAt: Date.now(), agentDefinitionId: first?.id ?? "", agentRevision: first?.revision ?? 0, agentName: first?.name ?? "People", companyId: scope.companyId, userId: scope.userId, requestId: input.requestId });
      return id;
    }, context);
    return this.getChat(scope, id);
  }

  async updateChat(scope: RuntimeScope, id: string, input: UpdateChatInput): Promise<ChatSnapshot> {
    await this.authorize(scope, id);
    await this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      const room = await tx.doc(SharedDoc, nativeId(id));
      const preference = room.preferences[scope.userId];
      if (input.projectId !== undefined) {
        if (input.projectId !== null) this.findProject(catalog, scope, input.projectId);
        preference.projectId = input.projectId;
      }
      if (input.pinned !== undefined) preference.pinned = input.pinned;
      if (input.archived !== undefined) preference.archived = input.archived;
    }, context);
    return this.getChat(scope, id);
  }

  private findProject(catalog: Catalog, scope: RuntimeScope, id: string): StoredProject {
    const project = catalog.projects?.find(project => project.id === id && owns(scope, project));
    if (!project) throw new RuntimeError(404, "Project not found.");
    return project;
  }

  async getChat(scope: RuntimeScope, id: string): Promise<ChatSnapshot> {
    await this.authorize(scope, id);
    // Hold the native commit line while reading all participating streams. No read commits write state.
    return this.harness.commit(async tx => {
      const catalog = await tx.doc(CatalogDoc);
      const chat = catalog.chats.find(item => item.id === id && item.companyId === scope.companyId)!;
      const room = await tx.doc(SharedDoc, nativeId(id));
      if (!room.members.some(member => member.userId === scope.userId)) throw new RuntimeError(404, "Conversation not found.");
      const presentation = await this.shared.presentation(tx, nativeId(id));
      const preference = room.preferences[scope.userId];
      const first = presentation.messages.find(message => message.kind === "message");
      const agents = presentation.participants.filter(member => member.kind === "agent");
      const status = agents.some(agent => agent.status === "working") ? "running" : agents.some(agent => agent.status === "failed") ? "failed" : agents.some(agent => agent.status === "stopped") ? "stopped" : "idle";
      const error = agents.find(agent => agent.status === "failed")?.error;
      const conversation: ChatSummary = {
        id, title: chat.title === "New conversation" && first?.text ? first.text.slice(0, 80) : chat.title,
        projectId: preference.projectId, pinned: preference.pinned, archived: preference.archived,
        createdAt: chat.createdAt, updatedAt: presentation.messages.reduce((latest, message) => Math.max(latest, message.createdAt), chat.createdAt), revision: this.commitRevision,
        agentDefinitionId: chat.agentDefinitionId, agentRevision: chat.agentRevision, agentName: chat.agentName ?? "Saved agent", status,
        ...(error ? { error } : {}),
      };
      // Compatibility carries no private native transcript, inbox, reasoning or agent context.
      return { conversation, ...presentation, view: { conversation: (await tx.conversation(nativeId(id)))!, entries: [], docs: {} }, submissions: [] } as ChatSnapshot;
    }, context);
  }

  async watchChat(scope: RuntimeScope, id: string) {
    await this.authorize(scope, id);
    let value = await this.getChat(scope, id);
    let listener: ((snapshot: ChatSnapshot) => Promise<void>) | undefined;
    let running = false; let dirty = false; let stopped = false;
    let finish!: (value: { reason: "stopped" | "listener_error" | "session_closed" }) => void;
    const closed = new Promise<{ reason: "stopped" | "listener_error" | "session_closed" }>(resolve => { finish = resolve; });
    const drain = async () => {
      if (running || stopped || !listener) return;
      running = true;
      try {
        while (dirty && !stopped) { dirty = false; value = await this.getChat(scope, id); await listener(value); }
      } catch { stopped = true; unsubscribe(); unsubscribeClose(); finish({ reason: "listener_error" }); }
      finally { running = false; }
    };
    const unsubscribe = this.harness.subscribeCommits(publication => {
      // Read-only snapshots produce no changes and cannot recursively wake themselves.
      if (!publication.changes.length || stopped) return;
      dirty = true; void drain();
    });
    const unsubscribeClose = this.harness.subscribeClose(() => { stopped = true; unsubscribe(); finish({ reason: "session_closed" }); });
    return { get value() { return value; }, start: (next: (snapshot: ChatSnapshot) => Promise<void>) => { listener = next; dirty = true; void drain(); }, stop: async () => { stopped = true; unsubscribe(); unsubscribeClose(); finish({ reason: "stopped" }); return closed; }, closed };
  }

  async submit(scope: RuntimeScope, id: string, input: SendMessageInput) {
    requireText(input.requestId, "Request ID", 200);
    requireText(input.text, "Message", 100_000);
    await this.authorize(scope, id);
    return this.harness.commit(tx => this.shared.post(tx, nativeId(id), `human:${scope.userId}`, input), context);
  }

  async addParticipants(scope: RuntimeScope, id: string, input: AddParticipantsInput) {
    requireText(input.requestId, "Request ID", 200);
    await this.authorize(scope, id);
    const people = await Promise.all((input.userIds ?? []).map(userId => this.person(scope.companyId, userId)));
    await this.harness.commit(tx => this.shared.invite(tx, nativeId(id), `human:${scope.userId}`, input, people), context);
    return this.getChat(scope, id);
  }

  async stop(scope: RuntimeScope, id: string) {
    await this.authorize(scope, id);
    await this.shared.stop(nativeId(id));
    return this.getChat(scope, id);
  }

  async getDefaultAgent(companyId: string): Promise<AgentDefinition> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    return publicAgent(this.findAgent(catalog!, { companyId }, "default"));
  }

  async listAgents(scope: RuntimeScope): Promise<AgentDefinition[]> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    const current = new Map<string, AgentDefinition>();
    for (const agent of catalog!.agents) if (agent.companyId === scope.companyId) current.set(agent.id, publicAgent(agent));
    return [...current.values()];
  }

  async saveAgent(scope: RuntimeScope, input: AgentDraft & { id?: string; expectedRevision?: number }): Promise<AgentDefinition> {
    this.validateAgent(input);
    return this.harness.commit(async (tx) => {
      const catalog = await tx.doc(CatalogDoc);
      const prior = input.id ? [...catalog.agents].reverse().find((agent) => agent.id === input.id && agent.companyId === scope.companyId) : undefined;
      if (input.id && !prior) throw new RuntimeError(404, "Agent not found.");
      if (prior?.archived) throw new RuntimeError(409, "This agent is archived. Create a new agent to use its configuration again.");
      if (prior && prior.revision !== input.expectedRevision) throw new RuntimeError(409, "The agent has changed. Reload it before saving.");
      const now = Date.now();
      const agent: StoredAgent = {
        id: prior?.id ?? randomUUID(), name: input.name.trim(), description: input.description.trim(),
        instructions: input.instructions, provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel,
        extensions: prior?.extensions ?? [], tools: prior?.tools ?? [],
        revision: (prior?.revision ?? 0) + 1, archived: false, createdAt: prior?.createdAt ?? now, updatedAt: now, companyId: scope.companyId,
      };
      catalog.agents.push(agent);
      return publicAgent(agent);
    }, context);
  }

  async archiveAgent(scope: RuntimeScope, id: string, expectedRevision: number): Promise<AgentDefinition> {
    if (id === "default") throw new RuntimeError(400, "The default agent cannot be archived.");
    return this.harness.commit(async (tx) => {
      const catalog = await tx.doc(CatalogDoc);
      const prior = [...catalog.agents].reverse().find((agent) => agent.id === id && agent.companyId === scope.companyId);
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
    try { await this.harness.close(context); } finally { this.owner.release(); }
  }

  private async authorize(scope: RuntimeScope, id: string) {
    await this.shared.authorized(scope, nativeId(id));
  }

  private async person(companyId: string, userId: string): Promise<CompanyPerson> {
    const person = await this.peopleDirectory?.get(companyId, userId);
    if (!person) throw new RuntimeError(404, "Company member not found.");
    return person;
  }

  private async createParticipant(tx: Tx, _roomId: ConversationId, companyId: string, definitionId: string): Promise<Member> {
    const catalog = await tx.doc(CatalogDoc);
    const agent = this.findAgent(catalog, { companyId }, definitionId);
    this.validateAgent(agent);
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
    const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const cwd = agent.extensions?.includes(CodingTools.name) ? join(this.owner.directory, "workspaces", String(record.id)) : undefined;
    await configure(tx, record.id, { model: { provider: agent.provider, modelId: agent.modelId }, instructions: agent.instructions, thinkingLevel: agent.thinkingLevel, extensions, tools, ...(cwd ? { cwd } : {}) });
    return { id: randomUUID(), kind: "agent", name: agent.name, joinedAt: Date.now(), agentDefinitionId: agent.id, agentRevision: agent.revision, conversationId: record.id, status: "idle", reported: [], agent: { ...publicAgent(agent), ...(cwd ? { cwd } : {}) } };
  }

  private async migrateChats() {
    const catalog = (await this.harness.snapshot(CatalogDoc, context))!;
    for (const chat of catalog.chats) {
      const roomId = nativeId(chat.id);
      if ((await this.harness.snapshot(SharedDoc, roomId, context))?.companyId) continue;
      // Preserve orphaned historical authors without authorizing any new human identity.
      const human = await this.peopleDirectory?.get(chat.companyId, chat.userId) ?? { id: chat.userId, name: "Former member" };
      const conversation = (await this.harness.conversation(roomId, context))!;
      const native = await conversation.agent(context);
      const definition = catalog.agents.find(agent => agent.companyId === chat.companyId && agent.id === chat.agentDefinitionId && agent.revision === chat.agentRevision);
      const legacy: Member = { id: `agent:${chat.id}`, kind: "agent", name: chat.agentName ?? definition?.name ?? "Saved agent", joinedAt: chat.createdAt, agentDefinitionId: chat.agentDefinitionId, agentRevision: chat.agentRevision, conversationId: roomId, status: "idle", reported: [], agent: { name: chat.agentName ?? definition?.name ?? "Saved agent", description: definition?.description ?? "", instructions: native.instructions ?? "", provider: native.model?.provider ?? "", modelId: native.model?.modelId ?? "", thinkingLevel: native.thinkingLevel ?? "off", extensions: native.extensions.map(extension => extension.name), tools: native.tools.map(tool => tool.name), ...(native.cwd ? { cwd: native.cwd } : {}) } };
      await this.harness.commit(tx => this.shared.migrate(tx, roomId, human, legacy, chat.companyId, { projectId: chat.projectId ?? null, pinned: chat.pinned ?? false, archived: chat.archived ?? false }), context);
    }
  }

  private findAgent(catalog: Catalog, scope: Pick<RuntimeScope, "companyId">, id: string) {
    const agent = [...catalog.agents].reverse().find((item) => item.id === id && item.companyId === scope.companyId);
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

function productionModels() {
  const models = createModels();
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  return models;
}

function nativeId(id: string): ConversationId {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new RuntimeError(404, "Conversation not found.");
  return Number(id) as ConversationId;
}

function owns(scope: RuntimeScope, chat: RuntimeScope) { return scope.companyId === chat.companyId && scope.userId === chat.userId; }
function projectSummary(project: StoredProject): Project {
  return { id: project.id, name: project.name, createdAt: project.createdAt };
}
function publicAgent({ companyId: _companyId, ...agent }: StoredAgent): AgentDefinition {
  return { ...agent, extensions: agent.extensions ?? [], tools: agent.tools ?? [] };
}
function requireText(value: unknown, field: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) throw new RuntimeError(400, `${field} must be ${allowEmpty ? "at most" : "between 1 and"} ${max} characters.`);
}

function requestConflict() { return new RuntimeError(409, "This request ID was already used with different content. Use a new request ID."); }
