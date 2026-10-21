import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { StorageRejected, type StorageWrite } from "@earendil-works/pi-durable";
import { z } from "zod";
import { PostgresStorage, RemoteStorageConflict } from "../storage/postgres/storage.js";
import { storageReadMethods, type RemoteStorageReply, type StorageReadMethod } from "../storage/remote.js";
import type { WorkerStoreProvisioner } from "./postgres-stores.js";
import type { WorkerRoute } from "./routes.js";

const requestSchema = z.object({
  sessionId: z.string().uuid(), method: z.enum(["open", "commit", "mintId", "close", ...storageReadMethods]),
  args: z.array(z.json()), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
const argumentCounts: Record<StorageReadMethod, number[]> = {
  conversation: [1], scanConversations: [3], entry: [1, 2], findLatestHeadMarker: [2], scanEntries: [3],
  task: [1], scanTasks: [3], submission: [1], scanSubmissions: [3], submissionByRequest: [2],
  findDocument: [2], document: [2], scanDocuments: [3],
};

/** Database credentials and connections stay in the main service. Each open uses
 * the existing store-scoped PostgreSQL role as a second isolation boundary. */
export class WorkerStorageGateway {
  private readonly owners = new Map<string, { attemptId: string; storage: Promise<PostgresStorage> }>();
  private closing = false;

  constructor(private readonly stores: WorkerStoreProvisioner) {}

  private async owner(route: WorkerRoute, assertCurrent: () => void): Promise<PostgresStorage> {
    assertCurrent();
    if (this.closing) throw new Error("Storage gateway is closing.");
    const existing = this.owners.get(route.storeId);
    if (existing) {
      const storage = await existing.storage;
      if (existing.attemptId === route.attemptId && storage.healthy) return storage;
      await storage.close(BACKGROUND_CONTEXT);
      if (this.owners.get(route.storeId) === existing) this.owners.delete(route.storeId);
      return this.owner(route, assertCurrent);
    }
    const entry = { attemptId: route.attemptId, storage: (async () => {
      const config = await this.stores.ensure(route.storeId);
      assertCurrent();
      return PostgresStorage.open(config);
    })() };
    this.owners.set(route.storeId, entry);
    try { return await entry.storage; }
    catch (error) { if (this.owners.get(route.storeId) === entry) this.owners.delete(route.storeId); throw error; }
  }

  async authenticateSession(route: WorkerRoute, sessionId: string, assertCurrent: () => void): Promise<void> {
    z.string().uuid().parse(sessionId);
    const storage = await this.owner(route, assertCurrent);
    await storage.claimRemoteSession(route.attemptId, sessionId, assertCurrent);
    assertCurrent();
  }

  async call(route: WorkerRoute, input: unknown, assertCurrent: () => void): Promise<RemoteStorageReply> {
    const request = requestSchema.parse(input);
    const { method, sessionId, sequence } = request;
    const mutation = method === "commit" || method === "mintId" || method === "close";
    if (mutation !== (sequence !== undefined)) throw new Error("Invalid remote storage sequence.");
    const expected = method === "commit" ? [1] : method === "open" || method === "mintId" || method === "close" ? [0] : argumentCounts[method];
    if (!expected.includes(request.args.length)) throw new Error("Invalid remote storage arguments.");
    if (method === "commit") z.array(z.object({ type: z.enum(["conversation", "entry", "task", "submission", "document.create", "document.copy", "document.change", "document.retire"]) }).passthrough()).parse(request.args[0]);
    // JSON has no undefined array element. Only optional positional arguments
    // use null on this wire; document/query payloads are left untouched.
    const args = request.args.map(value => value === null ? undefined : value);
    const storage = await this.owner(route, assertCurrent);
    try {
      await storage.claimRemoteSession(route.attemptId, sessionId, assertCurrent);
      if (method === "open") return { outcome: "ok" };
      let value: unknown;
      if (mutation) {
        value = await storage.remoteMutation({ attemptId: route.attemptId, sessionId, sequence: sequence!, method,
          ...(method === "commit" ? { writes: args[0] as unknown as StorageWrite[] } : {}) }, assertCurrent);
      } else {
        await storage.assertRemoteSession(route.attemptId, sessionId);
        assertCurrent();
        // The enum and argument counts above are the dispatch allowlist. Neither
        // database methods nor caller-selected stores cross this boundary.
        const read = storage[method] as (...args: unknown[]) => Promise<unknown>;
        value = await read.apply(storage, [...args, BACKGROUND_CONTEXT]);
      }
      if (method === "close") {
        const entry = this.owners.get(route.storeId);
        await storage.close(BACKGROUND_CONTEXT);
        if (entry && this.owners.get(route.storeId) === entry) this.owners.delete(route.storeId);
      }
      return { outcome: "ok", value };
    } catch (error) {
      if (error instanceof StorageRejected) return { outcome: "rejected" };
      if (error instanceof RemoteStorageConflict) return { outcome: "conflict" };
      throw error;
    }
  }

  async prune(routes: readonly WorkerRoute[]): Promise<void> {
    const active = new Set(routes.filter(route => route.phase !== "retiring" && route.phase !== "sleeping").map(route => route.attemptId));
    for (const [storeId, owner] of this.owners) {
      if (active.has(owner.attemptId)) continue;
      await (await owner.storage).close(BACKGROUND_CONTEXT);
      if (this.owners.get(storeId) === owner) this.owners.delete(storeId);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled([...this.owners.values()].map(async entry => (await entry.storage).close(BACKGROUND_CONTEXT)));
    this.owners.clear();
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Storage gateway close failed.");
  }
}
