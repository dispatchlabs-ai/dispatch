import { createHash, randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { configure, createRegistry, defineDoc, Harness, type ConversationId, type ConversationView, type Cursor, type HarnessSettings, type LiveState, type Storage, type SubmissionRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AgentDefinition, AgentDraft, ChatSnapshot, ChatSummary, RuntimeScope } from "../src/shared/contracts.js";
import { acquireRuntimeOwner } from "./runtime-owner.js";

const context = BACKGROUND_CONTEXT;
type StoredChat = Omit<ChatSummary, "status" | "error" | "updatedAt"> & { companyId: string; userId: string; requestId: string };
type StoredAgent = { [Key in keyof AgentDefinition]: AgentDefinition[Key] } & { companyId: string };
type Catalog = { chats: StoredChat[]; agents: StoredAgent[] };
const CatalogDoc = defineDoc<Catalog>({
  kind: "dispatch.catalog", version: 1, scope: "session",
  initial: () => ({ chats: [], agents: [] }),
});
const RequestFingerprintsDoc = defineDoc<{ fingerprints: Record<string, string> }>({
  kind: "dispatch.request-fingerprints", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ fingerprints: {} }),
});

export class RuntimeError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type RuntimeOptions = {
  stateDir: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: AgentDraft["thinkingLevel"];
  models?: Models;
  settings?: HarnessSettings;
};

/** Authentication supplies the scope; Pi remains the only owner of transcripts and work. */
export class DispatchRuntime {
  private harness: Harness;
  private storage: Storage;
  private models: Models;
  private defaultAgent: AgentDefinition;
  private owner: Awaited<ReturnType<typeof acquireRuntimeOwner>>;
  private closed = false;

  private constructor(harness: Harness, storage: Storage, models: Models, owner: Awaited<ReturnType<typeof acquireRuntimeOwner>>, defaultAgent: AgentDefinition) {
    this.harness = harness;
    this.storage = storage;
    this.models = models;
    this.owner = owner;
    this.defaultAgent = defaultAgent;
  }

  static async open(options: RuntimeOptions) {
    const owner = await acquireRuntimeOwner(options.stateDir);
    let storage: Storage | undefined;
    try {
      const models = options.models ?? productionModels();
      const filename = join(owner.directory, "pi.sqlite");
      storage = await openNodeSqliteStorage(filename);
      await chmod(filename, 0o600);
      const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: options.settings }, context);
      await harness.commit(async (tx) => { await tx.doc(CatalogDoc); }, context);
      const defaultAgent: AgentDefinition = {
        id: "default", name: "Dispatch", description: "General-purpose conversation assistant.",
        instructions: "You are Dispatch, a thoughtful assistant helping people solve problems. Be accurate, direct, and useful. Explain uncertainty and never claim to have performed actions you cannot perform.",
        provider: options.provider ?? "openai",
        modelId: options.modelId ?? "gpt-6-sol",
        thinkingLevel: options.thinkingLevel ?? "off", revision: 1, archived: false,
        createdAt: 1790985600000, updatedAt: 1790985600000,
      };
      const runtime = new DispatchRuntime(harness, storage, models, owner, defaultAgent);
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
    const summaries = await Promise.all(catalog!.chats.filter((chat) => owns(scope, chat)).map(async (chat) => (await this.getChat(scope, chat.id)).conversation));
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createChat(scope: RuntimeScope, input: { agentDefinitionId?: string; title?: string; requestId: string }): Promise<ChatSnapshot> {
    requireText(input.requestId, "Request ID", 200);
    const title = input.title?.trim() || "New conversation";
    requireText(title, "Title", 200);
    // Admission and catalog insertion share Pi's atomic transaction, including request deduplication.
    const id = await this.harness.commit(async (tx) => {
      const catalog = await tx.doc(CatalogDoc);
      const existing = catalog.chats.find((chat) => owns(scope, chat) && chat.requestId === input.requestId);
      if (existing) {
        if (existing.title !== title || existing.agentDefinitionId !== (input.agentDefinitionId ?? "default")) throw requestConflict();
        return existing.id;
      }
      const agent = this.findAgent(catalog, scope, input.agentDefinitionId ?? "default");
      this.validateAgent(agent);
      const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, record.id, { model: { provider: agent.provider, modelId: agent.modelId }, instructions: agent.instructions, thinkingLevel: agent.thinkingLevel, extensions: [], tools: [] });
      const id = String(record.id);
      catalog.chats.push({ id, title, createdAt: Date.now(), agentDefinitionId: agent.id, agentRevision: agent.revision, companyId: scope.companyId, userId: scope.userId, requestId: input.requestId });
      return id;
    }, context);
    return this.getChat(scope, id);
  }

  async getChat(scope: RuntimeScope, id: string): Promise<ChatSnapshot> {
    await this.authorize(scope, id);
    const conversation = (await this.harness.conversation(nativeId(id), context))!;
    const view = await conversation.viewState(context);
    try {
      // Keep native view and settlements on the same commit line, including failures before a first token.
      return await this.harness.commit(async (tx) => {
        const catalog = await tx.doc(CatalogDoc);
        const chat = catalog.chats.find((item) => item.id === id && owns(scope, item));
        if (!chat) throw new RuntimeError(404, "Conversation not found.");
        const submissions = await this.readSubmissions(conversation.id);
        return { conversation: summary(chat, view.value, submissions), view: view.value, submissions };
      }, context);
    } finally { view.dispose(); }
  }

  async watchChat(scope: RuntimeScope, id: string) {
    await this.authorize(scope, id);
    const conversation = (await this.harness.conversation(nativeId(id), context))!;
    const watch = await conversation.watch(context);
    try {
      let value = await this.getChat(scope, id);
      return {
        get value() { return value; },
        start: (listener: (snapshot: ChatSnapshot) => Promise<void>) => watch.start(async () => {
          value = await this.getChat(scope, id);
          await listener(value);
        }),
        stop: () => watch.stop(),
        closed: watch.closed,
      };
    } catch (error) { await watch.stop(); throw error; }
  }

  async submit(scope: RuntimeScope, id: string, input: { requestId: string; text: string }): Promise<SubmissionRecord> {
    requireText(input.requestId, "Request ID", 200);
    requireText(input.text, "Message", 100_000);
    await this.authorize(scope, id);
    const conversation = (await this.harness.conversation(nativeId(id), context))!;
    const prior = await this.harness.commit((tx) => tx.submissionByRequest(conversation.id, input.requestId), context);
    // Pi authenticates provider calls server-side. Do not convert a missing key into a pretend answer.
    const agent = await conversation.agent(context);
    if (!prior && (!agent.model || !await this.models.getAuth(agent.model.provider))) {
      throw new RuntimeError(503, "The model provider is not configured. Configure its credentials on the Dispatch service.");
    }
    // Pi drops a withdrawn inbox item's payload. Keep only an intent hash, never another transcript or run state.
    const existing = await this.harness.commit(async (tx) => {
      const admitted = await tx.submissionByRequest(conversation.id, input.requestId);
      const fingerprints = await tx.doc(RequestFingerprintsDoc, conversation.id);
      const key = fingerprint(input.requestId);
      const hash = fingerprint(input.text);
      const reserved = fingerprints.fingerprints[key];
      if (reserved && reserved !== hash) throw requestConflict();
      if (!reserved && admitted) throw new RuntimeError(409, "This older request no longer has a verifiable input. Use a new request ID.");
      fingerprints.fingerprints[key] = hash;
      return admitted;
    }, context);
    if (existing) return existing;
    // A crash between hash reservation and admission leaves no app-owned pending state: a retry calls submit again.
    const submission = await conversation.submit({ type: "input", content: input.text, requestId: input.requestId, whenBusy: "followUp" }, context);
    return submission.status(context);
  }

  async stop(scope: RuntimeScope, id: string) {
    await this.authorize(scope, id);
    const conversation = (await this.harness.conversation(nativeId(id), context))!;
    await conversation.abort(context);
    return this.getChat(scope, id);
  }

  async listAgents(scope: RuntimeScope): Promise<AgentDefinition[]> {
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    const current = new Map<string, AgentDefinition>();
    for (const agent of catalog!.agents) if (agent.companyId === scope.companyId) current.set(agent.id, publicAgent(agent));
    return [this.defaultAgent, ...current.values()];
  }

  async saveAgent(scope: RuntimeScope, input: AgentDraft & { id?: string; expectedRevision?: number }): Promise<AgentDefinition> {
    this.validateAgent(input);
    if (input.id === "default") throw new RuntimeError(400, "The default agent is configured by the service. Create a named agent to customize it.");
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
    nativeId(id);
    const catalog = await this.harness.snapshot(CatalogDoc, context);
    if (!catalog!.chats.some((chat) => chat.id === id && owns(scope, chat))) throw new RuntimeError(404, "Conversation not found.");
  }

  private findAgent(catalog: Catalog, scope: RuntimeScope, id: string) {
    const agent = id === "default" ? this.defaultAgent : [...catalog.agents].reverse().find((item) => item.id === id && item.companyId === scope.companyId);
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

  private async readSubmissions(conversationId: ConversationId) {
    const records: SubmissionRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanSubmissions({ conversationId }, 200, cursor, context);
      records.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return records;
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
function publicAgent({ companyId: _companyId, ...agent }: StoredAgent): AgentDefinition { return agent; }
function requireText(value: unknown, field: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) throw new RuntimeError(400, `${field} must be ${allowEmpty ? "at most" : "between 1 and"} ${max} characters.`);
}

function fingerprint(value: string) { return createHash("sha256").update(value).digest("hex"); }
function requestConflict() { return new RuntimeError(409, "This request ID was already used with different content. Use a new request ID."); }

function summary(chat: StoredChat, view: ConversationView, submissions: readonly SubmissionRecord[]): ChatSummary {
  const latest = submissions.filter((submission) => submission.type === "input" && (submission.status === "done" || submission.status === "unanswered")).at(-1);
  const live = view.docs["pi.live"] as LiveState | undefined;
  let status: ChatSummary["status"] = "idle";
  let error: string | undefined;
  if (live?.run) status = "running";
  else if (latest?.status === "unanswered") {
    status = latest.reason === "aborted" ? "stopped" : "failed";
    if (status === "failed") error = typeof latest.detail === "string" ? latest.detail : `The response ended: ${latest.reason}.`;
  }
  const messages = view.entries.flatMap((entry) => entry.model ?? []);
  const lastTimestamp = messages.reduce((latest, message) => "timestamp" in message ? Math.max(latest, message.timestamp) : latest, chat.createdAt);
  const firstInput = messages.find((message) => message.role === "user");
  const firstText = firstInput?.role === "user" ? (typeof firstInput.content === "string" ? firstInput.content : firstInput.content.filter((part) => part.type === "text").map((part) => part.text).join(" ")) : "";
  const title = chat.title === "New conversation" && firstText ? firstText.slice(0, 80) : chat.title;
  return { id: chat.id, title, createdAt: chat.createdAt, updatedAt: lastTimestamp, agentDefinitionId: chat.agentDefinitionId, agentRevision: chat.agentRevision, status, ...(error ? { error } : {}) };
}
