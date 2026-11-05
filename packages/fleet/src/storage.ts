/** Pi storage over the installation's run-bound Unix proxy. No cloud credential enters the worker. */
import { request } from "node:http";
import { join } from "node:path";
import { StorageRequestError, type Storage, type CommitResult, type Seq } from "@earendil-works/pi-durable";

type Reply = { ok: boolean; result?: any; error?: { name?: string; message?: string } | string };
type Receipt = { index: number; seq: Seq };


function storageSocket() {
  if (process.env.DISPATCH_STORAGE_SOCKET) return process.env.DISPATCH_STORAGE_SOCKET;
  if (!process.env.RUNTIME_DIRECTORY) throw new Error("Use the fleet worker's run-bound storage proxy.");
  return join(process.env.RUNTIME_DIRECTORY, "relay.sock");
}

function remoteError(value: Reply["error"]): Error {
  if (typeof value === "string") return new Error(value);
  const message = value?.message ?? "The coordinator storage operation failed.";
  return value?.name === "StorageRequestError" ? new StorageRequestError(message) : new Error(message);
}

/** One instance belongs to one harness. A failed write has an unknown outcome and is never retried here. */
export function createRemoteStorage(role: string, socketPath = storageSocket()): Storage {
  if (!/^[a-z][a-z0-9_-]*$/.test(role)) throw new Error("Unknown fleet storage role.");
  let closed = false;
  let closing: Promise<void> | undefined;
  const call = (operation: string, args: unknown[]): Promise<any> => {
    if (closed) return Promise.reject(new Error("Remote storage is closed."));
    const body = JSON.stringify({ operation, args });
    return new Promise((resolve, reject) => {
      const outgoing = request({ socketPath, path: `/storage/${role}`, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Coordinator storage response was interrupted; the outcome may be unknown.")));
        response.on("end", () => {
          try {
            const reply: Reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (response.statusCode !== 200 || reply.ok !== true) throw remoteError(reply.error);
            resolve(reply.result);
          } catch (error) { reject(error); }
        });
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };

  const storage: Storage = {
    async commit(batches, receive) {
      const value: { result: CommitResult; receipts: Receipt[] } = await call("commit", [batches]);
      if (!value || !Array.isArray(value.receipts) || !Number.isSafeInteger(value.result?.stored)
          || value.result.stored < 0 || value.result.stored > batches.length
          || value.receipts.length !== value.result.stored
          || value.receipts.some((receipt, index) => receipt.index !== index || !Number.isSafeInteger(receipt.seq)
            || receipt.seq < 1 || index > 0 && receipt.seq <= value.receipts[index - 1].seq)) {
        throw new Error("Invalid coordinator commit receipt; reopen the native store before continuing.");
      }
      // Receipt callbacks are synchronous and ordered, after durable confirmation.
      for (const receipt of value.receipts) receive(receipt.index, receipt.seq);
      return { ...value.result, ...(value.result.refused !== undefined
        ? { refused: remoteError(value.result.refused as Reply["error"]) } : {}) };
    },
    mintId: () => call("mintId", []),
    conversation: (id) => call("conversation", [id]),
    scanConversations: (query, limit, cursor) => call("scanConversations", [query, limit, cursor]),
    entry: ((...args: unknown[]) => call("entry", args.slice(0, args.length - 1))) as Storage["entry"],
    findLatestHeadMarker: (conversation, cutoff) => call("findLatestHeadMarker", [conversation, cutoff]),
    scanEntries: (query, limit, cursor) => call("scanEntries", [query, limit, cursor]),
    task: (id) => call("task", [id]),
    scanTasks: (query, limit, cursor) => call("scanTasks", [query, limit, cursor]),
    submission: (id) => call("submission", [id]),
    scanSubmissions: (query, limit, cursor) => call("scanSubmissions", [query, limit, cursor]),
    submissionByRequest: (conversation, key) => call("submissionByRequest", [conversation, key]),
    findDocument: (address, at) => call("findDocument", [address, at]),
    document: (id, at) => call("document", [id, at]),
    scanDocuments: (query, limit, cursor) => call("scanDocuments", [query, limit, cursor]),
    close() {
      if (!closing) {
        closing = call("close", []).then(() => undefined);
        closed = true;
      }
      return closing;
    },
  };
  return storage;
}
