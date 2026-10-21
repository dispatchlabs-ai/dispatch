import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, DocumentId, JsonObject, StorageWrite } from "@earendil-works/pi-durable";
import { PostgresStorage } from "./postgres/storage.js";
import { verifiedPostgresConfig } from "./postgres/tls.js";
import { importSqlite } from "./import-sqlite.js";
import { WorkerStoreProvisioner } from "../workers/postgres-stores.js";
import { WorkerRoutes } from "../workers/routes.js";
import { contentDigest, stableFingerprint, requiredDocument, type TransferPlan, type TransferInspection } from "./native-chat-transfer.js";

type Options = {
  directory: { connectionString: string; storeId: string }; workersConnectionString: string;
  authConnectionString: string; routingConnectionString: string; ca: string;
  companyId: string; installationId: string; credentialKey: string; configurationRevision: string;
  artifacts: { bucket: string; region: string; prefix: string }; stagingPrefix: string; temporaryDirectory: string;
};
const context = BACKGROUND_CONTEXT;
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Operator-only publication while the backend is stopped. New stores precede routing;
 * the directory transaction is the visibility boundary. A retry verifies retained stores.
 */
export async function publishNativeChatTransfer(plan: TransferPlan, options: Options, progress: (value: unknown) => void) {
  requireValue(plan.format === "dispatch-archived-native-transfer" && plan.version === 1, "Unsupported transfer plan");
  requireValue(options.companyId === plan.targetCompany && options.directory.storeId === plan.targetDirectoryStoreId, "Wrong destination");
  requireValue(options.configurationRevision.trim().length > 0, "Current deployment configuration revision is required");
  const planHash = stableFingerprint(plan);
  const s3 = new S3Client({ region: options.artifacts.region, maxAttempts: 1 });
  const clients: Client[] = [];
  let storage: PostgresStorage | undefined, provisioner: WorkerStoreProvisioner | undefined, routes: WorkerRoutes | undefined;
  const readObject = async (Key: string) => {
    const result = await s3.send(new GetObjectCommand({ Bucket: options.artifacts.bucket, Key }));
    requireValue(result.Body, "Object has no body"); return Buffer.from(await result.Body.transformToByteArray());
  };
  const putVerified = async (Key: string, bytes: Buffer) => {
    try { await s3.send(new PutObjectCommand({ Bucket: options.artifacts.bucket, Key, Body: bytes, IfNoneMatch: "*" })); }
    catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error; }
    requireValue(contentDigest(await readObject(Key)) === contentDigest(bytes), "Object readback mismatch");
  };
  const open = async (url: string) => {
    const client = new Client(verifiedPostgresConfig(url, options.ca)); clients.push(client); await client.connect(); return client;
  };
  try {
    const auth = await open(options.authConnectionString);
    const users = (await auth.query("SELECT id FROM dispatch_auth.auth_users WHERE company_id=$1 ORDER BY id", [options.companyId])).rows.map(r => r.id);
    requireValue(stableFingerprint(users) === stableFingerprint(plan.archivedUserIds), "Destination account inventory changed; prepare again");
    storage = await PostgresStorage.open({ ...options.directory, ca: options.ca });
    const db = await open(options.directory.connectionString);
    const docs: TransferInspection["documents"] = [];
    for (const row of (await db.query("SELECT id FROM dispatch_pi.documents WHERE store_id=$1 AND retired_at IS NULL ORDER BY id", [options.directory.storeId])).rows) {
      const doc = await storage.document(Number(row.id) as DocumentId, "current", context); requireValue(doc, "Directory document unavailable"); docs.push(doc);
    }
    const prior = docs.find(d => d.record.kind === "dispatch.archived-chat-import" && d.value.batchId === plan.config.batchId);
    if (prior) {
      requireValue(prior.value.planHash === planHash, "Published batch has a different plan");
      return { alreadyPublished: true, chats: plan.chats.length, planHash };
    }
    requireValue(requiredDocument<{ mode: string }>(docs, "dispatch.runtime-mode").mode === "directory", "Destination is not a directory");
    requireValue(requiredDocument<{ sourceId: string }>(docs, "dispatch.worker-catalog-exports").sourceId === plan.targetCatalogSourceId, "Catalog identity changed");
    const project = requiredDocument<{ projects: Record<string, { companyId: string; members: { userId: string }[] }> }>(docs, "dispatch.projects").projects[plan.config.targetProjectId];
    requireValue(project?.companyId === options.companyId, "Destination project changed");
    requireValue(project.members.every(m => users.includes(m.userId)), "Project has an unavailable member");
    const ids = plan.chats.flatMap(c => [Number(c.directoryId), ...c.actors.map(a => a.instanceId)]);
    requireValue(ids.every(Number.isSafeInteger) && new Set(ids).size === ids.length, "Duplicate directory identities");
    requireValue(!(await db.query("SELECT 1 FROM dispatch_pi.record_ids WHERE store_id=$1 AND id=ANY($2::bigint[]) LIMIT 1", [options.directory.storeId, ids])).rowCount, "Directory ID collision");
    await putVerified(`${options.stagingPrefix}/directory-before-${stableFingerprint(docs)}.json`, Buffer.from(JSON.stringify(docs)));
    provisioner = await WorkerStoreProvisioner.open({ connectionString: options.workersConnectionString, ca: options.ca,
      installationId: options.installationId, credentialKey: options.credentialKey });
    for (const [index, chat] of plan.chats.entries()) {
      requireValue(/^stores\/[0-9]+\.sqlite$/.test(chat.file), "Invalid store snapshot path");
      const bytes = await readObject(`${options.stagingPrefix}/${chat.file}`);
      requireValue(contentDigest(bytes) === chat.fileSha256, "Store snapshot digest mismatch");
      const filename = join(options.temporaryDirectory, `${chat.sourceId}.sqlite`);
      await writeFile(filename, bytes, { mode: 0o600 });
      try {
        const worker = await provisioner.ensure(chat.storeId);
        const receipt = await importSqlite(filename, worker.connectionString, chat.storeId, { ca: options.ca, access: "worker" });
        requireValue(stableFingerprint(receipt.tables) === stableFingerprint(chat.targetTables), "Native store receipt mismatch");
      } finally { await unlink(filename); }
      for (const attachment of chat.attachments) {
        requireValue(/^[a-f0-9-]{36}$/.test(attachment.id), "Invalid attachment path");
        const bytes = await readObject(`${options.stagingPrefix}/attachments/${attachment.id}`);
        requireValue(bytes.length === attachment.size && contentDigest(bytes) === attachment.sha256, "Attachment snapshot mismatch");
        const key = `${options.artifacts.prefix.replace(/\/$/, "")}/${contentDigest(chat.storeId)}/${attachment.id}`;
        await putVerified(key, bytes);
      }
      progress({ kind: "store-verified", completed: index + 1, total: plan.chats.length });
    }
    routes = await WorkerRoutes.openPostgres({ database: verifiedPostgresConfig(options.routingConnectionString, options.ca), installationId: options.installationId });
    await putVerified(`${options.stagingPrefix}/routes-before-${stableFingerprint(routes.list())}.json`, Buffer.from(JSON.stringify(routes.list())));
    const writes: StorageWrite[] = [];
    const change = (kind: string, value: unknown) => {
      const doc = docs.find(d => d.record.kind === kind && d.record.scope.kind === "session"); requireValue(doc, `Missing directory document ${kind}`);
      writes.push({ type: "document.change", id: doc.record.id, content: { kind: "base", version: doc.version, value: value as JsonObject } });
    };
    const catalog = requiredDocument<{ chats: TransferPlan["chats"][number]["catalog"][]; agents: TransferPlan["agents"]; skills?: TransferPlan["skills"] }>(docs, "dispatch.catalog");
    requireValue(!catalog.agents.some(a => plan.agents.some(b => b.id === a.id)), "Agent namespace collision");
    requireValue(!(catalog.skills ?? []).some(a => plan.skills.some(b => b.id === a.id)), "Skill namespace collision");
    catalog.chats.push(...plan.chats.map(c => c.catalog)); catalog.agents.push(...plan.agents); (catalog.skills ??= []).push(...plan.skills);
    change("dispatch.catalog", catalog);
    const actors = requiredDocument<{ actors: Record<string, TransferPlan["chats"][number]["actors"]> }>(docs, "dispatch.worker-actors");
    const invitations = requiredDocument<{ rooms: Record<string, JsonObject> }>(docs, "dispatch.worker-invitations");
    const instances = requiredDocument<{ rooms: Record<string, JsonObject> }>(docs, "dispatch.worker-instances");
    for (const c of plan.chats) {
      actors.actors[c.directoryId] = c.actors;
      invitations.rooms[c.directoryId] = { revision: 1, instances: true, mcpSelections: true, requests: {}, events: [] };
      instances.rooms[c.directoryId] = { requests: {} };
    }
    change("dispatch.worker-actors", actors); change("dispatch.worker-invitations", invitations); change("dispatch.worker-instances", instances);
    for (const chat of plan.chats) {
      for (const id of [Number(chat.directoryId), ...chat.actors.map(a => a.instanceId)]) writes.push({ type: "conversation", value: { id: id as ConversationId } });
      const id = await storage.mintId<DocumentId>(); requireValue(!ids.includes(id), "Document allocation collision");
      writes.push({ type: "document.create", record: { id, kind: "dispatch.shared-conversation", history: "latest", fork: "initial", scope: { kind: "conversation", conversationId: Number(chat.directoryId) as ConversationId } },
        content: { kind: "base", version: 1, value: chat.directoryRoom as unknown as JsonObject } });
      await routes.importPending({ ...chat.route, phase: "pending", configurationRevision: options.configurationRevision });
    }
    const receiptId = await storage.mintId<DocumentId>(); requireValue(!ids.includes(receiptId), "Receipt allocation collision");
    writes.push({ type: "document.create", record: { id: receiptId, kind: "dispatch.archived-chat-import", scope: { kind: "session" } },
      content: { kind: "base", version: 1, value: { batchId: plan.config.batchId, planHash, chats: plan.chats.map(c => c.directoryId), archivedUserIds: users } } });
    const seq = await storage.commit(writes, context);
    for (const write of writes) {
      if (write.type !== "document.change" && write.type !== "document.create") continue;
      const id = write.type === "document.create" ? write.record.id : write.id;
      const doc = await storage.document(id, "current", context);
      requireValue(doc && write.content.kind === "base" && stableFingerprint(doc.value) === stableFingerprint(write.content.value), "Published directory readback mismatch");
    }
    const changed = new Set(writes.flatMap(w => w.type === "document.change" ? [w.id] : []));
    for (const before of docs.filter(d => !changed.has(d.record.id))) {
      requireValue(stableFingerprint(await storage.document(before.record.id, "current", context)) === stableFingerprint(before), "Unrelated directory document changed");
    }
    const result = { kind: "published", batchId: plan.config.batchId, planHash, seq, chats: plan.chats.length, users: users.length,
      attachments: plan.chats.reduce((n, c) => n + c.attachments.length, 0), unrelatedDocumentsUnchanged: docs.length - changed.size };
    await putVerified(`${options.stagingPrefix}/publication-receipt.json`, Buffer.from(JSON.stringify(result)));
    progress(result); return result;
  } finally {
    const cleanup = await Promise.allSettled([routes?.close(), provisioner?.close(), storage?.close(context), ...clients.map(client => client.end())]);
    s3.destroy();
    const failed = cleanup.find(result => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
  }
}
