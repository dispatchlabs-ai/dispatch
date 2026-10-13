import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { AuthPrincipal } from "./auth.js";

export const managementFields = ["instructions", "provider", "modelId", "thinkingLevel"] as const;
const id = z.string().min(1).max(200);
export const grantInputSchema = z.object({
  editorId: id, targetId: id, expectedVersion: z.number().int().nonnegative(), requestId: id,
  reason: z.string().trim().min(1).max(2000),
  policy: z.object({
    editorRevision: z.number().int().positive(), action: z.enum(["read", "save"]),
    fields: z.array(z.enum(managementFields)).max(4).refine(items => new Set(items).size === items.length),
    maxSavesPerHour: z.number().int().min(1).max(100),
  }).strict().nullable(),
}).strict();
export type GrantInput = z.infer<typeof grantInputSchema>;
export type Grant = { companyId: string; editorId: string; targetId: string; version: number; policy: GrantInput["policy"] };
type GrantChange = { companyId: string; userId?: string; at: number; requestId: string; fingerprint: string; reason: string; before: Grant | null; after: Grant;
  source?: "self-save"; actor?: { definitionId: string; instanceId: string; operationId: string } };
const GrantsDoc = defineDoc<{ grants: Grant[]; changes: GrantChange[] }>({
  kind: "dispatch.agent-management-grants", version: 1, scope: "session", initial: () => ({ grants: [], changes: [] }),
});
export class ManagementError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const detached = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Return detached values: agent operations cannot obtain a writable grant document.
export async function readGrants(tx: Tx, companyId: string): Promise<Grant[]> {
  return detached((await tx.doc(GrantsDoc)).grants.filter(grant => grant.companyId === companyId));
}
export async function grantHistory(tx: Tx, principal: AuthPrincipal) {
  return detached((await tx.doc(GrantsDoc)).changes.filter(change => change.companyId === principal.companyId));
}

// Continuity is technical access, not a new approval. Only a successful authorized
// self-save calls this, on the same commit line as its revision and retry receipt.
export async function advanceSelfGrant(tx: Tx, prior: Grant, editorRevision: number, actor: { definitionId: string; instanceId: string; operationId: string }, at: number) {
  const doc = await tx.doc(GrantsDoc);
  const current = doc.grants.find(grant => grant.companyId === prior.companyId && grant.editorId === actor.definitionId && grant.targetId === actor.definitionId);
  if (!current?.policy || current.version !== prior.version) throw new ManagementError(409, "The self-grant changed before the save.");
  const before = detached(current);
  current.policy.editorRevision = editorRevision;
  current.version++;
  doc.changes.push({ companyId: current.companyId, at, source: "self-save", actor,
    requestId: `self-save:${actor.operationId}`, fingerprint: JSON.stringify([actor, before.version, editorRevision]),
    reason: "Automatic self-grant continuity after an agent-authored save; not manager approval.", before, after: detached(current) });
}

/** Only the human-session route calls this writer; no native tool receives it. */
export async function writeGrant(tx: Tx, principal: AuthPrincipal, raw: unknown, validate: (input: GrantInput) => Promise<void>) {
  if (!principal.sessionId || !principal.userId) throw new ManagementError(403, "Human session required for grant administration.");
  const input = grantInputSchema.parse(raw);
  const fingerprint = JSON.stringify([input.editorId, input.targetId, input.expectedVersion, input.reason, input.policy && { ...input.policy, fields: [...input.policy.fields].sort() }]);
  const doc = await tx.doc(GrantsDoc);
  const receipt = doc.changes.find(change => change.companyId === principal.companyId && change.userId === principal.userId && change.requestId === input.requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw new ManagementError(409, "Request ID was already used with different content.");
    return detached(receipt.after);
  }
  const before = doc.grants.find(grant => grant.companyId === principal.companyId && grant.editorId === input.editorId && grant.targetId === input.targetId);
  if ((before?.version ?? 0) !== input.expectedVersion) throw new ManagementError(409, "The grant changed. Reload it before saving.");
  if (input.policy) await validate(input);
  const after: Grant = { companyId: principal.companyId, editorId: input.editorId, targetId: input.targetId, version: input.expectedVersion + 1, policy: input.policy };
  doc.changes.push({ companyId: principal.companyId, userId: principal.userId, at: Date.now(), requestId: input.requestId, fingerprint, reason: input.reason, before: before ? detached(before) : null, after });
  if (before) Object.assign(before, after); else doc.grants.push(after);
  return detached(after);
}
