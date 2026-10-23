import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { identifier } from "./protocol.js";

export type StorageRoute = { host: string; alias: string; storage: string; store: string };
type Pending = { host: WebSocket; storage: WebSocket; originalId: string; timer: ReturnType<typeof setTimeout> };
export const send = (socket: WebSocket | undefined, value: unknown) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
};

/** Attach to an application's authenticated host sockets; pairing remains application-owned. */
export function createStorageRelay(routes: readonly StorageRoute[]) {
  const keys = new Set<string>();
  for (const route of routes) {
    if (![route.host, route.alias, route.storage, route.store].every(identifier)) throw new Error("Invalid storage route.");
    const key = `${route.host}:${route.alias}`;
    if (keys.has(key)) throw new Error("Duplicate storage route.");
    keys.add(key);
  }
  const storageHosts = new Map<string, WebSocket>();
  const pending = new Map<string, Pending>();
  function disconnected(socket: WebSocket) {
    for (const [id, host] of storageHosts) if (host === socket) storageHosts.delete(id);
    for (const [id, call] of pending) {
      if (call.storage !== socket && call.host !== socket) continue;
      clearTimeout(call.timer);
      pending.delete(id);
      if (call.host !== socket) send(call.host, { type: "storage-response", id: call.originalId, error: "Storage host disconnected." });
    }
  }
  return {
    connected(id: string, socket: WebSocket) {
      const old = storageHosts.get(id);
      if (old) { disconnected(old); old.terminate(); }
      storageHosts.set(id, socket);
    },
    disconnected,
    message(role: "host" | "storage", id: string, socket: WebSocket, value: Record<string, unknown>): boolean {
      if (role === "storage") {
        if (storageHosts.get(id) !== socket) return true;
        if (value.type !== "storage-response" || typeof value.id !== "string") return true;
        const call = pending.get(value.id);
        if (!call || call.storage !== socket) return true;
        pending.delete(value.id);
        clearTimeout(call.timer);
        send(call.host, { type: "storage-response", id: call.originalId, reply: value.reply, error: value.error });
        return true;
      }
      if (value.type !== "storage-request") return false;
      if (!identifier(value.id) || !identifier(value.alias)) return true;
      const route = routes.find(route => route.host === id && route.alias === value.alias);
      if (!route) {
        send(socket, { type: "storage-response", id: value.id, reply: { status: "conflict", error: "Storage alias is not authorized." } });
        return true;
      }
      const storage = storageHosts.get(route.storage);
      if (!storage) {
        send(socket, { type: "storage-response", id: value.id, error: "Storage host is offline." });
        return true;
      }
      const callId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(callId);
        send(socket, { type: "storage-response", id: value.id, error: "Storage response expired." });
      }, 30_000);
      timer.unref();
      pending.set(callId, { host: socket, storage, originalId: value.id, timer });
      send(storage, { type: "storage-request", id: callId, store: route.store, request: value.request });
      return true;
    },
  };
}
