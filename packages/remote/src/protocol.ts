import type { Storage } from "@earendil-works/pi-durable";

export const reads = {
  conversation: [1], scanConversations: [3], entry: [1, 2], findLatestHeadMarker: [2],
  scanEntries: [3], task: [1], scanTasks: [3], submission: [1],
  scanSubmissions: [3], submissionByRequest: [2], findDocument: [2],
  document: [2], scanDocuments: [3],
} as const;
export type ReadMethod = keyof typeof reads;
export type StorageMethod = ReadMethod | "open" | "commit" | "mintId" | "close";
export type StorageRequest = {
  session: string; method: StorageMethod; args: unknown[]; sequence?: number;
};
export type StorageReply =
  | { status: "ok"; value?: unknown }
  | { status: "rejected" | "conflict" | "fatal"; error: string };
export type StorageTransport = (request: StorageRequest) => Promise<StorageReply>;
export type ReadResult<M extends ReadMethod> = Awaited<ReturnType<Storage[M]>>;
export const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

/** Validate at the authenticated service boundary. Native Pi validates storage records. */
export function parseRequest(value: unknown): StorageRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid storage request.");
  const r = value as StorageRequest;
  if (!identifier(r.session) || typeof r.method !== "string" || !Array.isArray(r.args)) throw new Error("Invalid session or arguments.");
  const count = Object.hasOwn(reads, r.method) ? reads[r.method as ReadMethod] as readonly number[]
    : r.method === "commit" ? [1] : ["open", "mintId", "close"].includes(r.method) ? [0] : [];
  if (!count.includes(r.args.length)) throw new Error("Invalid storage method or argument count.");
  const mutation = ["commit", "mintId", "close"].includes(r.method);
  if (mutation ? !Number.isSafeInteger(r.sequence) || r.sequence! < 1 : r.sequence !== undefined)
    throw new Error("Invalid storage sequence.");
  if (r.method === "commit" && !Array.isArray(r.args[0])) throw new Error("Invalid commit.");
  return r;
}
