import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { StorageReply, StorageRequest } from "./protocol.js";
import type { SqliteStorageService } from "./sqlite.js";
import { send } from "./relay.js";

/** Uses an existing runner connection, so a storage connection cannot displace its phone socket. */
export function storageRpc(outbound: (value: unknown) => void) {
  const calls = new Map<string, { resolve: (reply: StorageReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  return {
    call(alias: string, request: StorageRequest): Promise<StorageReply> {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          calls.delete(id); reject(new Error("Storage response timed out."));
        }, 15_000);
        calls.set(id, { resolve, reject, timer });
        try { outbound({ type: "storage-request", id, alias, request }); }
        catch (error) { clearTimeout(timer); calls.delete(id); reject(error); }
      });
    },
    receive(value: Record<string, unknown>) {
      if (value.type !== "storage-response") return false;
      const id = String(value.id);
      const call = calls.get(id);
      if (!call) return true;
      clearTimeout(call.timer); calls.delete(id);
      if (value.error || !value.reply) call.reject(new Error(String(value.error ?? "Missing storage reply.")));
      else call.resolve(value.reply as StorageReply);
      return true;
    },
    disconnected() {
      for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error("Relay disconnected.")); }
      calls.clear();
    },
  };
}

export function connectStorageHost(options: {
  relay: string; token: string; service: SqliteStorageService; allowLoopback?: boolean;
  onConnection?: (online: boolean) => void; onError?: (error: unknown) => void;
}) {
  const url = new URL("/connect", options.relay);
  if (url.protocol !== "https:" && !(options.allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1"))
    throw new Error("Relay must use HTTPS.");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false, backoff = 500;
  function connect() {
    const current = new WebSocket(url, { headers: { authorization: `Bearer ${options.token}` },
      followRedirects: false, maxPayload: 4 * 1024 * 1024 });
    socket = current;
    current.on("open", () => { backoff = 500; options.onConnection?.(true); });
    current.on("error", error => options.onError?.(error));
    current.on("message", async raw => {
      let value;
      try {
        value = JSON.parse(String(raw));
        if (value.type !== "storage-request") return;
        const reply = await options.service.request(value.store, value.request);
        send(current, { type: "storage-response", id: value.id, reply });
      } catch (error) {
        options.onError?.(error);
        if (value?.type === "storage-request") send(current, { type: "storage-response", id: value.id,
          reply: { status: "fatal", error: "Storage host could not open the authorized store." } });
      }
    });
    current.on("close", () => {
      options.onConnection?.(false);
      if (!stopped) {
        timer = setTimeout(connect, backoff + Math.random() * 300);
        backoff = Math.min(backoff * 2, 30_000);
      }
    });
  }
  connect();
  return { close: async () => {
    stopped = true; clearTimeout(timer); socket?.terminate();
    await options.service.close();
  } };
}
