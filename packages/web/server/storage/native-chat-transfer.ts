import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ConversationId, DocumentId, JsonObject, Storage, StorageWrite } from "@earendil-works/pi-durable";
import type { AgentDefinition, ChatSummary, SkillDefinition } from "../../src/shared/contracts.js";
import type { SharedState } from "../collaboration/shared.js";
import type { StoredAttachment } from "../attachments.js";
import type { SharedProjectRecord } from "../project-access.js";
import type { BackendWorkerActor } from "../workers/participant-identity.js";
import type { WorkerRoute } from "../workers/routes.js";

type Chat = Pick<ChatSummary, "id" | "title" | "createdAt" | "agentDefinitionId" | "agentRevision"> & {
  companyId: string; userId: string; requestId: string; agentName?: string; displayTitle?: string;
  creationTitleExplicit?: boolean; creationAgentIds?: string[]; creationAgentsOmitted?: boolean;
  creationFingerprint?: string; creationProjectId?: string | null; pinned?: boolean; archived?: boolean;
};
type StoredAgent = AgentDefinition & { companyId: string };
type StoredSkill = SkillDefinition & { companyId: string; savedBy: string; requestId: string; fingerprint: string };
type Catalog = { chats: Chat[]; agents: StoredAgent[]; skills?: StoredSkill[]; connectionOwners?: Record<string, string> };
type Document = NonNullable<Awaited<ReturnType<Storage["document"]>>>;
export type TransferInspection = {
  company: string; dir: { storeId: string }; config: { installationId: string; configurationRevision: string };
  users: { id: string; name: string; email: string; status: string }[];
  documents: Document[];
};
export type TransferConfig = {
  batchId: string; sourceStoreId: string; sourceProjectId: string; targetProjectId: string;
  userMap: Record<string, string>; workspaceDir: string;
};
export type TableReceipt = { rows: number; sha256: string };
export const nativeTables = ["record_ids", "conversations", "entries", "tasks", "submissions", "documents", "document_revisions"] as const;
export type TransferChat = {
  sourceId: string; directoryId: string; storeId: string; file: string; fileSha256: string;
  catalog: Chat; directoryRoom: SharedState; actors: BackendWorkerActor[]; route: WorkerRoute;
  nativeConversations: number[]; sourceTables: Record<string, TableReceipt>; targetTables: Record<string, TableReceipt>;
  attachments: { id: string; size: number; sha256: string }[];
};
export type TransferPlan = {
  format: "dispatch-archived-native-transfer"; version: 1; config: TransferConfig; createdAt: string;
  sourceMetadata: { next_id: number; next_seq: number }; targetCompany: string; targetDirectoryStoreId: string;
  targetCatalogSourceId: string; archivedUserIds: string[]; agents: StoredAgent[]; skills: StoredSkill[];
  chats: TransferChat[]; directoryNextId: number;
};

export function stableFingerprint(value: unknown): string {
  const ordered = (x: unknown): unknown => Array.isArray(x) ? x.map(ordered)
    : x !== null && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, ordered(v)])) : x;
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}
export function contentDigest(bytes: string | Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function deterministicUuid(batch: string, key: string) {
  const bytes = createHash("sha256").update(JSON.stringify([batch, key])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const h = bytes.toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object<T>(value: unknown): T { return structuredClone(value) as T; }
function columns(db: DatabaseSync, table: string) { return db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)); }
export function sqliteTableReceipts(db: DatabaseSync): Record<string, TableReceipt> {
  return Object.fromEntries(nativeTables.map(table => {
    const fields = columns(db, table); const hash = createHash("sha256"); let rows = 0;
    for (const row of db.prepare(`SELECT ${fields.join(",")} FROM ${table} ORDER BY ${table === "document_revisions" ? "document_id,seq" : "id"}`).iterate()) {
      hash.update(JSON.stringify(fields.map(key => row[key])) + "\n"); rows++;
    }
    return [table, { rows, sha256: hash.digest("hex") }];
  }));
}
async function currentDocuments(db: DatabaseSync, storage: Storage) {
  const result: Document[] = [];
  for (const row of db.prepare("SELECT id FROM documents WHERE retired_at IS NULL ORDER BY id").iterate()) {
    const doc = await storage.document(Number(row.id) as DocumentId, "current", BACKGROUND_CONTEXT);
    requireValue(doc, "A current document could not be materialized"); result.push(doc);
  }
  return result;
}
export function requiredDocument<T>(docs: Document[], kind: string): T {
  const matches = docs.filter(d => d.record.kind === kind && d.record.scope.kind === "session");
  requireValue(matches.length === 1, `Expected exactly one ${kind} document`); return object<T>(matches[0].value);
}
function sanitizeAgent<T extends AgentDefinition>(agent: T, id: string, companyId: string, skillIds: Record<string, string>, workspace: string): T {
  return { ...structuredClone(agent), id, companyId, archived: true, cwd: workspace,
    skills: agent.skills?.map(value => ({ ...value, id: skillIds[value.id] ?? value.id })),
    connections: [], extensions: (agent.extensions ?? []).filter(name => !name.startsWith("dispatch-mcp-")),
    tools: (agent.tools ?? []).filter(name => !name.startsWith("mcp_")),
  };
}
function mapAttachmentUrls(value: unknown, directoryId: string, userMap: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map(v => mapAttachmentUrls(v, directoryId, userMap));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => {
    if (key === "url" && typeof v === "string" && /^\/api\/chats\/[^/]+\/attachments\/[a-f0-9-]{36}$/.test(v))
      return [key, v.replace(/^\/api\/chats\/[^/]+\//, `/api/chats/${directoryId}/`)];
    if (["authorId", "uploaderId"].includes(key) && typeof v === "string") {
      const human = v.startsWith("human:") ? userMap[v.slice(6)] : undefined;
      return [key, human ? `human:${human}` : userMap[v] ?? v];
    }
    if (key === "mentions" && Array.isArray(v)) return [key, v.map(id => typeof id === "string" && id.startsWith("human:") && userMap[id.slice(6)] ? `human:${userMap[id.slice(6)]}` : id)];
    return [key, mapAttachmentUrls(v, directoryId, userMap)];
  }));
}
async function putDocument(storage: Storage, docs: Document[], writes: StorageWrite[], kind: string, value: unknown) {
  const prior = docs.find(d => d.record.kind === kind && d.record.scope.kind === "session");
  if (prior) writes.push({ type: "document.change", id: prior.record.id, content: { kind: "base", version: prior.version, value: value as JsonObject } });
  else writes.push({ type: "document.create", record: { id: await storage.mintId<DocumentId>(), kind, scope: { kind: "session" } }, content: { kind: "base", version: 1, value: value as JsonObject } });
}

/** Offline preparation only: source is copied; no Harness, model, worker or external credential is opened. */
export async function prepareNativeChatTransfer(sourceDirectory: string, inspection: TransferInspection, config: TransferConfig, output: string,
  progress: (value: unknown) => void = () => {}) {
  requireValue(/^[a-f0-9-]{36}$/.test(config.batchId), "Batch identity must be a UUID");
  requireValue(config.workspaceDir.startsWith("/"), "Target workspace must be absolute");
  const sourcePath = resolve(sourceDirectory, "source.sqlite");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const sourceStorage = await openNodeSqliteStorage(sourcePath);
  const sourceDocs: Document[] = [];
  try {
    requireValue(source.prepare("PRAGMA quick_check").get()?.quick_check === "ok", "Source integrity check failed");
    requireValue(source.prepare("SELECT version FROM durable_schema WHERE singleton=1").get()?.version === 1, "Unsupported source schema");
    requireValue(!source.prepare("SELECT 1 FROM tasks WHERE status!='terminal' LIMIT 1").get()
      && !source.prepare("SELECT 1 FROM submissions WHERE status IN ('queued','placed') LIMIT 1").get(), "Source has unsettled work");
    for (const row of source.prepare("SELECT id FROM documents WHERE retired_at IS NULL AND (scope_kind='session' OR kind=?) ORDER BY id").iterate(JSON.stringify("dispatch.shared-conversation"))) {
      const doc = await sourceStorage.document(Number(row.id) as DocumentId, "current", BACKGROUND_CONTEXT); requireValue(doc, "Source document unavailable"); sourceDocs.push(doc);
    }
    const sourceCatalog = requiredDocument<Catalog>(sourceDocs, "dispatch.catalog");
    const sourceProjects = requiredDocument<{ projects: Record<string, SharedProjectRecord> }>(sourceDocs, "dispatch.projects");
    const sourceProject = sourceProjects.projects[config.sourceProjectId]; requireValue(sourceProject, "Source project not found");
    const targetProjects = requiredDocument<{ projects: Record<string, SharedProjectRecord> }>(inspection.documents, "dispatch.projects");
    const targetProject = targetProjects.projects[config.targetProjectId];
    requireValue(targetProject?.companyId === inspection.company, "Target project not found in the expected company");
    const targetSource = requiredDocument<{ sourceId: string }>(inspection.documents, "dispatch.worker-catalog-exports").sourceId;
    requireValue(targetSource, "Target worker catalog identity is missing");
    const archivedUserIds = inspection.users.map(u => u.id).sort();
    requireValue(archivedUserIds.length && Object.values(config.userMap).every(id => archivedUserIds.includes(id)), "Mapped users must exist at the destination");
    const selected = sourceDocs.filter(d => d.record.kind === "dispatch.shared-conversation" && object<SharedState>(d.value).sharedProjectId === config.sourceProjectId);
    requireValue(selected.length, "Source project has no chats");
    const metadata = source.prepare("SELECT next_id,next_seq FROM durable_metadata WHERE singleton=1").get()!;
    const plan: TransferPlan = { format: "dispatch-archived-native-transfer", version: 1, config, createdAt: new Date().toISOString(),
      sourceMetadata: { next_id: Number(metadata.next_id), next_seq: Number(metadata.next_seq) },
      targetCompany: inspection.company, targetDirectoryStoreId: inspection.dir.storeId, targetCatalogSourceId: targetSource,
      archivedUserIds, agents: [], skills: [], chats: [], directoryNextId: Number(metadata.next_id) };
    requireValue(Number.isSafeInteger(plan.directoryNextId), "Invalid source allocator");
    const namespace = `import-${config.batchId.slice(0, 8)}-`;
    const usedAgents = new Set(selected.flatMap(d => object<SharedState>(d.value).members.flatMap(m => m.agentDefinitionId ? [m.agentDefinitionId] : [])));
    const agentIds = Object.fromEntries([...usedAgents].map(id => [id, namespace + id]));
    const usedSkills = new Set(sourceCatalog.agents.filter(a => usedAgents.has(a.id)).flatMap(a => (a.skills ?? []).map(s => s.id)));
    const skillIds = Object.fromEntries([...usedSkills].map(id => [id, namespace + id]));
    plan.skills = (sourceCatalog.skills ?? []).filter(s => usedSkills.has(s.id)).map(s => ({ ...s, id: skillIds[s.id], companyId: inspection.company,
      savedBy: config.userMap[s.savedBy] ?? "import", requestId: `import:${config.batchId}:${s.id}:${s.revision}`, fingerprint: "imported-snapshot" }));
    plan.agents = sourceCatalog.agents.filter(a => usedAgents.has(a.id)).map(a => sanitizeAgent(a, agentIds[a.id], inspection.company, skillIds, config.workspaceDir));
    requireValue([...usedAgents].every(id => plan.agents.some(a => a.id === agentIds[id])), "A participant definition is missing");
    await mkdir(output, { recursive: false, mode: 0o700 }); await mkdir(join(output, "stores"), { mode: 0o700 });
    await mkdir(join(output, "attachments"), { mode: 0o700 });
    await writeFile(join(output, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
    const attachmentCopies = new Set<string>();
    const allRoomOwners = new Map<number, number>();
    for (const doc of sourceDocs.filter(d => d.record.kind === "dispatch.shared-conversation")) {
      requireValue(doc.record.scope.kind === "conversation", "Invalid source room scope");
      const owner = doc.record.scope.conversationId;
      for (const id of new Set([owner, ...object<SharedState>(doc.value).members.flatMap(m => m.conversationId ? [m.conversationId] : [])])) {
        requireValue(!allRoomOwners.has(id), `Native conversation ${id} belongs to rooms ${allRoomOwners.get(id)} and ${owner}`); allRoomOwners.set(id, owner);
      }
    }
    // This importer deliberately refuses forks/ownership graphs it has not qualified.
    for (const row of source.prepare("SELECT record FROM conversations").iterate())
      requireValue(Object.keys(JSON.parse(String(row.record))).every(key => key === "id"), "Source has a fork or owned conversation requiring explicit extraction");
    for (const roomDoc of selected) {
      requireValue(roomDoc.record.scope.kind === "conversation", "Invalid room scope");
      const roomId = roomDoc.record.scope.conversationId; const originalRoom = object<SharedState>(roomDoc.value);
      const originalChat = sourceCatalog.chats.find(c => c.id === String(roomId)); requireValue(originalChat, "Source chat has no catalog record");
      requireValue(originalChat.companyId === sourceProject.companyId && originalRoom.companyId === originalChat.companyId, "Source company mismatch");
      requireValue(config.userMap[originalChat.userId], "Source creator needs an explicit destination account mapping");
      const nativeConversations = [...new Set([roomId, ...originalRoom.members.flatMap(m => m.conversationId ? [m.conversationId] : [])])].sort((a, b) => a - b);
      const directoryId = String(plan.directoryNextId++), storeId = `conversation-${deterministicUuid(config.batchId, String(roomId))}`;
      const file = `stores/${roomId}.sqlite`, filename = join(output, file);
      const empty = await openNodeSqliteStorage(filename); await empty.close(BACKGROUND_CONTEXT);
      const target = new DatabaseSync(filename);
      target.exec("PRAGMA journal_mode=DELETE"); target.prepare("ATTACH DATABASE ? AS source").run(sourcePath);
      target.exec("BEGIN");
      const ids = nativeConversations.join(",");
      target.exec(`INSERT INTO conversations SELECT * FROM source.conversations WHERE id IN (${ids});
        INSERT INTO entries SELECT * FROM source.entries WHERE conversation_id IN (${ids});
        INSERT INTO tasks SELECT * FROM source.tasks WHERE conversation_id IN (${ids});
        INSERT INTO submissions SELECT * FROM source.submissions WHERE conversation_id IN (${ids});
        INSERT INTO documents SELECT * FROM source.documents WHERE (scope_kind='conversation' AND owner_id IN (${ids})) OR (scope_kind='task' AND owner_id IN (SELECT id FROM tasks));
        INSERT INTO document_revisions SELECT * FROM source.document_revisions WHERE document_id IN (SELECT id FROM documents);
        INSERT INTO record_ids SELECT * FROM source.record_ids WHERE id IN (SELECT id FROM conversations UNION ALL SELECT id FROM entries UNION ALL SELECT id FROM tasks UNION ALL SELECT id FROM submissions UNION ALL SELECT id FROM documents);`);
      target.prepare("UPDATE durable_metadata SET next_id=?,next_seq=? WHERE singleton=1").run(metadata.next_id!, metadata.next_seq!);
      const sourceTables = sqliteTableReceipts(target);
      // Public author and download addresses are installation references, never arbitrary prose.
      const updateEntry = target.prepare("UPDATE entries SET record=? WHERE id=?");
      for (const row of target.prepare("SELECT id,record FROM entries").iterate()) {
        const old = String(row.record), entry = JSON.parse(old);
        if (entry.kind !== "dispatch.public-message") continue;
        const next = JSON.stringify(mapAttachmentUrls(entry, directoryId, config.userMap));
        if (next !== old) updateEntry.run(next, row.id!);
      }
      target.exec("COMMIT; DETACH DATABASE source"); target.close();
      const storage = await openNodeSqliteStorage(filename); const reader = new DatabaseSync(filename, { readOnly: true });
      try {
        const docs = await currentDocuments(reader, storage); const writes: StorageWrite[] = [];
        const room = object<SharedState>(mapAttachmentUrls(originalRoom, directoryId, config.userMap));
        room.companyId = inspection.company; room.sharedProjectId = config.targetProjectId;
        room.preferences = Object.fromEntries(archivedUserIds.map(id => [id, { pinned: false, archived: true }]));
        if (room.legacyCreatorId) room.legacyCreatorId = config.userMap[room.legacyCreatorId] ?? room.legacyCreatorId;
        for (const member of room.members) {
          if (member.kind === "human") {
            requireValue(member.userId && config.userMap[member.userId], "A historical human needs account mapping");
            member.userId = config.userMap[member.userId]; member.id = `human:${member.userId}`;
          } else {
            requireValue(member.agentDefinitionId && member.agent, "Historical agent configuration is missing");
            member.agentDefinitionId = agentIds[member.agentDefinitionId];
            member.agent = sanitizeAgent(member.agent as AgentDefinition, member.agentDefinitionId, inspection.company, skillIds, config.workspaceDir);
            member.workspaceDefault = config.workspaceDir;
            delete member.pendingConnectionIds; delete member.pendingWorkerMcp; delete member.connectionsRefreshPending;
            requireValue(member.membership !== "removing", "Participant removal is unfinished");
          }
        }
        for (const member of targetProject.members) {
          if (room.members.some(m => m.userId === member.userId)) continue;
          const user = inspection.users.find(u => u.id === member.userId); requireValue(user, "Target project contains an unavailable person");
          room.members.push({ id: `human:${user.id}`, kind: "human", userId: user.id, name: user.name, joinedAt: Date.now(), status: "idle" });
        }
        const chat: Chat = { ...originalChat, id: String(roomId), companyId: inspection.company, userId: config.userMap[originalChat.userId],
          requestId: `import:${config.batchId}:${roomId}`, creationTitleExplicit: true, creationAgentsOmitted: false,
          creationAgentIds: room.members.flatMap(m => m.agentDefinitionId ? [m.agentDefinitionId] : []),
          agentDefinitionId: agentIds[originalChat.agentDefinitionId] ?? "", creationProjectId: config.targetProjectId };
        delete chat.creationFingerprint; delete chat.archived; delete chat.pinned;
        const publicSummary = docs.find(d => d.record.kind === "dispatch.public-summary" && d.record.scope.kind === "conversation" && d.record.scope.conversationId === roomId);
        const summary = object<{ first?: { text: string }; updatedAt?: number }>(publicSummary?.value ?? {});
        if (!chat.displayTitle) chat.displayTitle = chat.title === "New conversation" && !originalChat.creationTitleExplicit ? summary.first?.text || "New chat" : chat.title;
        const catalog = { chats: [chat], agents: plan.agents, skills: plan.skills, connectionOwners: {} };
        const scope = { companyId: inspection.company, userId: chat.userId };
        const input = { requestId: chat.requestId, title: chat.title, agentDefinitionIds: chat.creationAgentIds!, sharedProjectId: config.targetProjectId };
        const actors: BackendWorkerActor[] = [];
        const mappings: Record<string, { participantId: string; instanceId: string; desiredRevision: number }> = {};
        for (const member of room.members.filter(m => m.kind === "agent")) {
          requireValue(member.agentDefinitionId && member.agentRevision && member.conversationId && member.agent, "Incomplete historical participant");
          requireValue(plan.agents.some(a => a.id === member.agentDefinitionId && a.revision === member.agentRevision), "A historical agent revision is missing");
          const actor: BackendWorkerActor = { companyId: inspection.company, definitionId: member.agentDefinitionId, revision: member.agentRevision,
            instanceId: plan.directoryNextId++ as ConversationId, roomId: Number(directoryId) as ConversationId,
            participantId: member.id, configuration: member.agent as AgentDefinition, membership: member.membership ?? "active", legacy: true,
            appliedRevision: member.agentRevision, desiredRevision: member.agentRevision,
            worker: { storeId, roomId: String(roomId), participantId: member.id, instanceId: String(member.conversationId) },
            ...(member.membership === "removed" ? { removedByUserId: chat.userId } : {}) };
          actors.push(actor); mappings[member.id] = { participantId: member.id, instanceId: String(member.conversationId), desiredRevision: member.agentRevision };
        }
        const attachments: TransferChat["attachments"] = [];
        for (const doc of docs) {
          let value: unknown = doc.value;
          if (doc.record.kind === "dispatch.shared-conversation") value = room;
          if (doc.record.kind === "pi.agent") {
            const agent = object<Record<string, unknown>>(value); agent.cwd = config.workspaceDir;
            if (Array.isArray(agent.extensions)) agent.extensions = agent.extensions.filter(name => typeof name !== "string" || !name.startsWith("dispatch-mcp-"));
            if (Array.isArray(agent.tools)) agent.tools = agent.tools.filter(name => typeof name !== "string" || !name.startsWith("mcp_"));
            value = agent;
          }
          if (doc.record.kind === "dispatch.mcp-bindings") value = { connections: [] };
          if (doc.record.kind === "dispatch.skill-bindings") {
            const binding = object<{ skills: SkillDefinition[] }>(value); binding.skills = binding.skills.map(s => ({ ...s, id: skillIds[s.id] ?? s.id })); value = binding;
          }
          if (doc.record.kind === "dispatch.evaluation-binding") {
            const binding = object<Record<string, unknown>>(value);
            if (typeof binding.definitionId === "string" && agentIds[binding.definitionId]) binding.definitionId = agentIds[binding.definitionId]; value = binding;
          }
          if (doc.record.kind === "dispatch.project-instructions-binding") value = { projectId: targetProject.id, instructionsRevision: targetProject.instructionsRevision ?? 0, markdown: targetProject.instructions ?? "" };
          if (doc.record.kind === "dispatch.attachments") {
            value = mapAttachmentUrls(value, directoryId, config.userMap);
            for (const item of Object.values(object<{ records: Record<string, StoredAttachment> }>(value).records)) {
              requireValue(/^[a-f0-9-]{36}$/.test(item.id), "Invalid attachment identity");
              const bytes = await readFile(join(sourceDirectory, "attachments", item.id)); requireValue(bytes.length === item.size, "Attachment size mismatch");
              attachments.push({ id: item.id, size: bytes.length, sha256: contentDigest(bytes) });
              if (!attachmentCopies.has(item.id)) { await copyFile(join(sourceDirectory, "attachments", item.id), join(output, "attachments", item.id)); attachmentCopies.add(item.id); }
            }
          }
          if (stableFingerprint(value) !== stableFingerprint(doc.value)) writes.push({ type: "document.change", id: doc.record.id, content: { kind: "base", version: doc.version, value: value as JsonObject } });
        }
        await putDocument(storage, docs, writes, "dispatch.catalog", catalog);
        await putDocument(storage, docs, writes, "dispatch.projects", { projects: { [targetProject.id]: targetProject }, requests: {}, instructionsRequests: {} });
        await putDocument(storage, docs, writes, "dispatch.runtime-mode", { mode: "conversation", worker: { conversationKey: directoryId, storeId, companyId: inspection.company,
          creationFingerprint: stableFingerprint([scope, input]), roomId: String(roomId), sourceId: targetSource, catalogRevision: 0, catalogFingerprint: "" } });
        await putDocument(storage, docs, writes, "dispatch.worker-instance-identity", { mappings });
        await putDocument(storage, docs, writes, "dispatch.import-source", { batchId: config.batchId, storeId: config.sourceStoreId, projectId: config.sourceProjectId, roomId: String(roomId), sourceTables });
        await storage.commit(writes, BACKGROUND_CONTEXT);
        const attemptId = deterministicUuid(config.batchId, `attempt:${roomId}`);
        const route: WorkerRoute = { conversationId: directoryId, companyId: inspection.company, storeId, attemptId,
          configurationRevision: inspection.config.configurationRevision, nativeRoomId: String(roomId), scope, input, phase: "sleeping",
          summary: { attemptId, value: { revision: 0, updatedAt: Math.max(chat.createdAt, summary.updatedAt ?? 0), status: "idle", suggestedTitle: chat.displayTitle.slice(0, 80) } } };
        const directoryRoom = object<SharedState>(room); directoryRoom.members = directoryRoom.members.filter(m => m.kind === "human");
        directoryRoom.deliveries = []; directoryRoom.requests = {}; delete directoryRoom.stopping; delete directoryRoom.legacyQueued;
        const targetTables = sqliteTableReceipts(reader);
        requireValue(targetTables.tasks.rows === sourceTables.tasks.rows && targetTables.entries.rows === sourceTables.entries.rows
          && targetTables.conversations.rows === nativeConversations.length, "Native content count changed");
        plan.chats.push({ sourceId: String(roomId), directoryId, storeId, file, fileSha256: "", catalog: { ...chat, id: directoryId },
          directoryRoom, actors, route, nativeConversations, sourceTables, targetTables, attachments });
      } finally { reader.close(); await storage.close(BACKGROUND_CONTEXT); }
      plan.chats.at(-1)!.fileSha256 = contentDigest(await readFile(filename));
      progress({ prepared: plan.chats.length, total: selected.length, sourceId: String(roomId) });
    }
    await writeFile(join(output, "plan.json"), JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" });
    return { chats: plan.chats.length, attachments: attachmentCopies.size, nativeConversations: plan.chats.reduce((n, c) => n + c.nativeConversations.length, 0), plan: join(output, "plan.json") };
  } finally { source.close(); await sourceStorage.close(BACKGROUND_CONTEXT); }
}
