import type { Context } from "@earendil-works/chord";
import type { Storage, Id, EntryId, ConversationId } from "@earendil-works/pi-durable";
import { setTimeout as delay } from "node:timers/promises";

export const storageReadMethods = ["conversation", "scanConversations", "entry", "findLatestHeadMarker", "scanEntries",
  "task", "scanTasks", "submission", "scanSubmissions", "submissionByRequest", "findDocument", "document", "scanDocuments"] as const;
export type StorageReadMethod = typeof storageReadMethods[number];
export type RemoteStorageReply = { outcome: "ok"; value?: unknown } | { outcome: "conflict" };
export type RemoteStorageRequest = { sessionId: string; method: StorageReadMethod | "open" | "commit" | "mintId" | "close";
  args: unknown[]; sequence?: number };
export type RemoteStorageConfig = { kind: "remote"; storeId: string; sessionId: string;
  request(input: RemoteStorageRequest): Promise<RemoteStorageReply>; fatal(): void };

/** Stock Pi's public Storage interface over the bound worker API. Only storage
 * operations retry; this does not retry tools, model requests or external effects. */
export class RemoteStorage implements Storage {
  private tail: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private failure?: Error;
  private closing?: Promise<void>;

  private constructor(private readonly config: RemoteStorageConfig) {}

  static async open(config: RemoteStorageConfig): Promise<RemoteStorage> {
    const storage = new RemoteStorage(config);
    await storage.send("open", []);
    return storage;
  }

  private async send(method: RemoteStorageRequest["method"], args: unknown[]): Promise<unknown> {
    if (this.failure) throw this.failure;
    const mutation = method === "commit" || method === "mintId" || method === "close";
    const input = { sessionId: this.config.sessionId, method, args, ...(mutation ? { sequence: this.sequence + 1 } : {}) };
    const deadline = performance.now() + 180_000;
    let backoff = 100;
    for (;;) {
      let reply: RemoteStorageReply;
      try { reply = await this.config.request(input); }
      catch (error) {
        const status = (error as { status?: number })?.status;
        if ((status === undefined || status >= 500) && performance.now() < deadline) {
          await delay(Math.min(backoff, Math.max(1, deadline - performance.now())));
          backoff = Math.min(2000, backoff * 2);
          continue;
        }
        return this.fail();
      }
      if (reply.outcome !== "ok") return this.fail();
      if (mutation) this.sequence++;
      return reply.value;
    }
  }

  private fail(): never {
    this.failure ??= new Error("Remote storage is unavailable; this worker must retire before replacement.");
    this.config.fatal();
    throw this.failure;
  }

  private call<T>(method: RemoteStorageRequest["method"], args: unknown[]): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Remote storage is closed."));
    const work = this.tail.then(() => this.send(method, args)) as Promise<T>;
    this.tail = work.catch(() => {});
    return work;
  }

  commit: Storage["commit"] = (writes, _context) => this.call("commit", [writes]);
  mintId<I extends Id<string>>(): Promise<I> { return this.call("mintId", []); }
  conversation: Storage["conversation"] = (id, _context) => this.call("conversation", [id]);
  scanConversations: Storage["scanConversations"] = (query, limit, cursor, _context) => this.call("scanConversations", [query, limit, cursor]);
  entry(id: EntryId, context: Context): ReturnType<Storage["entry"]>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): ReturnType<Storage["entry"]>;
  entry(id: ConversationId | EntryId, second: Context | EntryId, context?: Context): ReturnType<Storage["entry"]> {
    return this.call("entry", context === undefined ? [id] : [id, second]);
  }
  findLatestHeadMarker: Storage["findLatestHeadMarker"] = (id, cutoff, _context) => this.call("findLatestHeadMarker", [id, cutoff]);
  scanEntries: Storage["scanEntries"] = (query, limit, cursor, _context) => this.call("scanEntries", [query, limit, cursor]);
  task: Storage["task"] = (id, _context) => this.call("task", [id]);
  scanTasks: Storage["scanTasks"] = (query, limit, cursor, _context) => this.call("scanTasks", [query, limit, cursor]);
  submission: Storage["submission"] = (id, _context) => this.call("submission", [id]);
  scanSubmissions: Storage["scanSubmissions"] = (query, limit, cursor, _context) => this.call("scanSubmissions", [query, limit, cursor]);
  submissionByRequest: Storage["submissionByRequest"] = (id, request, _context) => this.call("submissionByRequest", [id, request]);
  findDocument: Storage["findDocument"] = (address, at, _context) => this.call("findDocument", [address, at]);
  document: Storage["document"] = (id, at, _context) => this.call("document", [id, at]);
  scanDocuments: Storage["scanDocuments"] = (query, limit, cursor, _context) => this.call("scanDocuments", [query, limit, cursor]);
  close(_context: Context): Promise<void> {
    return this.closing ??= this.tail.then(async () => { await this.send("close", []); });
  }
}
