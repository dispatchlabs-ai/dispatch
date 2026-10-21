import { createHmac, timingSafeEqual } from "node:crypto";
import type { LaunchRequest } from "./launcher.js";

export function workerToken(key: string, installationId: string, request: LaunchRequest): string {
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(key)) throw new Error("Worker signing key must be at least 32 random bytes encoded as base64url.");
  return createHmac("sha256", key).update(JSON.stringify([
    "dispatch-worker-v1", installationId, request.attemptId, request.conversationId, request.storeId, request.configurationRevision,
  ])).digest("base64url");
}
export function tokenMatches(expected: string, authorization: string | undefined): boolean {
  const received = Buffer.from(authorization ?? "");
  const value = Buffer.from(`Bearer ${expected}`);
  return received.length === value.length && timingSafeEqual(received, value);
}
