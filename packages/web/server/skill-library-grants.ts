import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { ManagementError, detached } from "./agent-grants.js";
import type { AuthPrincipal } from "./auth.js";

const id = z.string().min(1).max(200);
export const skillLibraryGrantInputSchema = z.object({
  editorId: id, expectedVersion: z.number().int().nonnegative(), requestId: id,
  // Legacy fields remain accepted for identical retries of pre-update requests.
  reason: z.string().trim().max(2000).optional(),
  policy: z.object({
    // Reading needs no grant; earlier read-only grants may remain stored but cannot be newly issued.
    editorRevision: z.number().int().positive(), action: z.literal("save"),
    maxSavesPerHour: z.number().int().min(1).max(100).optional(),
  }).strict().nullable(),
}).strict();
export type SkillLibraryGrantInput = z.infer<typeof skillLibraryGrantInputSchema>;
type StoredPolicy = Omit<NonNullable<SkillLibraryGrantInput["policy"]>, "action"> & { action: "read" | "save" };
export type SkillLibraryGrant = { companyId: string; editorId: string; version: number; policy: StoredPolicy | null };
type SkillLibraryGrantChange = { companyId: string; userId: string; at: number; requestId: string; fingerprint: string; reason?: string; before: SkillLibraryGrant | null; after: SkillLibraryGrant };
const SkillLibraryGrantsDoc = defineDoc<{ grants: SkillLibraryGrant[]; changes: SkillLibraryGrantChange[] }>({
  checkpointWhen: () => false,
  kind: "dispatch.skill-library-grants", version: 1, scope: "session", initial: () => ({ grants: [], changes: [] }),
});

// Return detached values: agent operations cannot obtain a writable grant document.
export async function readSkillLibraryGrants(tx: Tx, companyId: string): Promise<SkillLibraryGrant[]> {
  return detached((await tx.doc(SkillLibraryGrantsDoc)).grants.filter(grant => grant.companyId === companyId));
}
export async function skillLibraryGrantHistory(tx: Tx, principal: AuthPrincipal) {
  return detached((await tx.doc(SkillLibraryGrantsDoc)).changes.filter(change => change.companyId === principal.companyId));
}

/** Only the human-session route calls this writer; no native tool receives it. */
export async function writeSkillLibraryGrant(tx: Tx, principal: AuthPrincipal, raw: unknown, validate: (input: SkillLibraryGrantInput) => Promise<void>) {
  if (!principal.sessionId || !principal.userId) throw new ManagementError(403, "Human session required for grant administration.");
  const input = skillLibraryGrantInputSchema.parse(raw);
  const fingerprint = JSON.stringify([input.editorId, input.expectedVersion, input.reason, input.policy]);
  const doc = await tx.doc(SkillLibraryGrantsDoc);
  const receipt = doc.changes.find(change => change.companyId === principal.companyId && change.userId === principal.userId && change.requestId === input.requestId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw new ManagementError(409, "Request ID was already used with different content.");
    return detached(receipt.after);
  }
  const before = doc.grants.find(grant => grant.companyId === principal.companyId && grant.editorId === input.editorId);
  if ((before?.version ?? 0) !== input.expectedVersion) throw new ManagementError(409, "The grant changed. Reload it before saving.");
  if (input.policy) await validate(input);
  const after: SkillLibraryGrant = { companyId: principal.companyId, editorId: input.editorId, version: input.expectedVersion + 1, policy: input.policy };
  doc.changes.push({ companyId: principal.companyId, userId: principal.userId, at: Date.now(), requestId: input.requestId, fingerprint, ...(input.reason === undefined ? {} : { reason: input.reason }), before: before ? detached(before) : null, after });
  if (before) Object.assign(before, after); else doc.grants.push(after);
  return detached(after);
}
