import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { StorageRequestError } from "@earendil-works/pi-durable";
import {
  parseRequest,
  type StorageReply,
  type StorageRequest,
} from "@dispatch/remote";
import { PostgresStorage, RemoteStorageConflict } from "./storage.js";
import type { PostgresStorageOptions } from "./database.js";

/** Service-only. Authorization maps a worker/run/agent to an exact store before this call. */
export class PostgresStorageService {
  private stores = new Map<string, Promise<PostgresStorage>>();
  private tails = new Map<string, Promise<unknown>>();
  private closed = false;
  private failed = new Set<string>();
  constructor(
    private options: Omit<PostgresStorageOptions, "storeId">,
    private authorize: (store: string) => boolean,
  ) {}
  private store(id: string) {
    if (this.closed || !this.authorize(id))
      throw new Error("Store is not authorized.");
    let store = this.stores.get(id);
    if (!store) {
      store = PostgresStorage.open({ ...this.options, storeId: id });
      this.stores.set(id, store);
    }
    return store;
  }
  async request(id: string, value: unknown): Promise<StorageReply> {
    const request = parseRequest(value);
    const operation = (this.tails.get(id) ?? Promise.resolve()).then(
      async (): Promise<StorageReply> => {
        if (this.failed.has(id))
          return {
            status: "fatal",
            error: "Store requires operator recovery.",
          };
        const storage = await this.store(id);
        try {
          if (request.method === "open") {
            await storage.claimRemoteSession(request.session);
            return { status: "ok" };
          }
          if (request.sequence !== undefined) {
            const result = await storage.remoteMutation(
              {
                attemptId: request.session,
                sessionId: request.session,
                method: request.method as "commit" | "mintId" | "close",
                sequence: request.sequence,
                ...(request.method === "commit"
                  ? {
                      batches: request.args[0] as Parameters<
                        PostgresStorage["commit"]
                      >[0],
                    }
                  : {}),
              },
              () => {},
            );
            return { status: "ok", value: result };
          }
          await storage.assertRemoteSession(request.session, request.session);
          const method = storage[
            request.method as Exclude<StorageRequest["method"], "open">
          ] as (...args: unknown[]) => Promise<unknown>;
          return {
            status: "ok",
            value: await method.call(
              storage,
              ...request.args.map((arg) => (arg === null ? undefined : arg)),
              context,
            ),
          };
        } catch (error) {
          if (error instanceof RemoteStorageConflict)
            return { status: "conflict", error: error.message };
          if (
            error instanceof StorageRequestError &&
            request.sequence === undefined
          )
            return { status: "rejected", error: error.message };
          this.failed.add(id);
          return {
            status: "fatal",
            error:
              "Storage failed; retain executor identity and reconcile native receipts before recovery.",
          };
        }
      },
    );
    this.tails.set(
      id,
      operation.catch(() => {}),
    );
    return operation;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.tails.values());
    await Promise.all(
      [...this.stores.values()].map(async (value) =>
        (await value).close(context),
      ),
    );
  }
}
