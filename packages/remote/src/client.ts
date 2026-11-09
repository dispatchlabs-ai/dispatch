import { randomUUID } from "node:crypto";
import { StorageRequestError, type Storage, type Id, type Seq } from "@earendil-works/pi-durable";
import type { ReadMethod, ReadResult, StorageRequest, StorageTransport } from "./protocol.js";

/** One process owns this instance. Transport retries never repeat inference or tools. */
export class RemoteStorage implements Storage {
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  private failed = false;
  private closing?: Promise<void>;
  private constructor(readonly session: string, private transport: StorageTransport) {}

  static async open(transport: StorageTransport) {
    const storage = new RemoteStorage(randomUUID(), transport);
    await storage.send({ session: storage.session, method: "open", args: [] });
    return storage;
  }
  private enqueue<T>(work: () => Promise<T>, read = false): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Storage is closed."));
    const result = this.tail.then(() => {
      if (this.failed) throw this.failure;
      return work();
    });
    this.tail = result.catch(error => {
      if (!read || !(error instanceof StorageRequestError)) { this.failed = true; this.failure = error; }
    });
    return result;
  }
  private async send(request: StorageRequest): Promise<unknown> {
    const deadline = Date.now() + 180_000;
    let delay = 100;
    for (;;) {
      let reply;
      try { reply = await this.transport(request); }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 2_000);
        continue;
      }
      if (reply.status === "ok") return reply.value;
      if (reply.status === "rejected" && request.sequence === undefined) throw new StorageRequestError(reply.error);
      throw new Error(reply.error);
    }
  }
  private read<M extends ReadMethod>(method: M, args: unknown[]): Promise<ReadResult<M>> {
    return this.enqueue(() => this.send({ session: this.session, method, args }) as Promise<ReadResult<M>>, true);
  }
  private mutate(method: "commit" | "mintId" | "close", args: unknown[]) {
    const request: StorageRequest = { session: this.session, method, args, sequence: this.sequence + 1 };
    return this.send(request).then(value => { this.sequence = request.sequence!; return value; });
  }
  commit: Storage["commit"] = (batches, receive) => this.enqueue(async () => {
    const value = await this.mutate("commit", [batches]) as { stored: number; seqs: Seq[]; refused?: { message: string } };
    if (!value || !Number.isSafeInteger(value.stored) || value.stored < 0 || value.stored > batches.length
      || !Array.isArray(value.seqs) || value.seqs.length !== value.stored
      || value.seqs.some((seq, index) => !Number.isSafeInteger(seq) || seq < 1 || index > 0 && seq <= value.seqs[index - 1])
      || (value.stored < batches.length
        ? !value.refused || typeof value.refused.message !== "string"
        : Object.hasOwn(value, "refused"))) {
      throw new Error("Invalid durable commit receipt; operator recovery is required.");
    }
    for (const [index, seq] of value.seqs.entries()) receive(index, seq);
    return { stored: value.stored, ...(value.refused !== undefined ? { refused: new Error(value.refused.message) } : {}) };
  });
  mintId<I extends Id<string>>(): Promise<I> {
    return this.enqueue(async () => {
      const value = await this.mutate("mintId", []);
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 2)
        throw new Error("Invalid durable ID receipt; operator recovery is required.");
      return value as I;
    });
  }
  conversation: Storage["conversation"] = id => this.read("conversation", [id]);
  scanConversations: Storage["scanConversations"] = (query, limit, cursor) => this.read("scanConversations", [query, limit, cursor]);
  entry: Storage["entry"] = ((...args: unknown[]) => this.read("entry", args.slice(0, typeof args[1] === "number" ? 2 : 1))) as Storage["entry"];
  findLatestHeadMarker: Storage["findLatestHeadMarker"] = (id, before) => this.read("findLatestHeadMarker", [id, before]);
  scanEntries: Storage["scanEntries"] = (query, limit, cursor) => this.read("scanEntries", [query, limit, cursor]);
  task: Storage["task"] = id => this.read("task", [id]);
  scanTasks: Storage["scanTasks"] = (query, limit, cursor) => this.read("scanTasks", [query, limit, cursor]);
  submission: Storage["submission"] = id => this.read("submission", [id]);
  scanSubmissions: Storage["scanSubmissions"] = (query, limit, cursor) => this.read("scanSubmissions", [query, limit, cursor]);
  submissionByRequest: Storage["submissionByRequest"] = (id, request) => this.read("submissionByRequest", [id, request]);
  findDocument: Storage["findDocument"] = (address, at) => this.read("findDocument", [address, at]);
  document: Storage["document"] = (id, at) => this.read("document", [id, at]);
  scanDocuments: Storage["scanDocuments"] = (query, limit, cursor) => this.read("scanDocuments", [query, limit, cursor]);
  close(): Promise<void> {
    return this.closing ??= this.tail.then(async () => {
      // An uncertain mutation must retain ownership for explicit operator recovery.
      if (!this.failed) await this.mutate("close", []);
    });
  }
}
