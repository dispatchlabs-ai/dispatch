import { createHash, randomUUID } from "node:crypto";
import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { RuntimeScope } from "../src/shared/contracts.js";
import type { EvaluationProfile, EvaluationProfileResponse, SaveEvaluationProfileInput } from "../src/shared/evaluations.js";

export class EvaluationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const nonblank = (max: number) => z.string().max(max).refine(value => value.trim().length > 0, "Enter a value.");
const guidance = z.string().max(10_000);
const caseText = z.string().max(20_000);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const criterionSchema = z.object({
  id: z.string().uuid(), description: nonblank(2_000), gradingMethod: z.enum(["direct", "judge", "human"]),
  criticalFailure: z.boolean(), gradingGuidance: guidance,
}).strict();
const caseSchema = z.object({
  id: z.string().uuid(), name: nonblank(200), enabled: z.boolean(), prompt: nonblank(20_000),
  startingConditions: caseText,
  inputArtifacts: z.array(z.object({ name: nonblank(200), reference: nonblank(2_048), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).max(20),
  expectedOutcome: nonblank(20_000), criterionIds: z.array(z.string().uuid()).min(1).max(100),
  gradingGuidance: guidance, evaluatorOnly: z.object({ referenceAnswer: caseText, checks: caseText }).strict(),
}).strict();
const saveSchema = z.object({
  expectedRevision: revision.nullable(), requestId: nonblank(200), changeReason: nonblank(1_000),
  responsibilities: nonblank(10_000), expectedBehavior: nonblank(10_000), prohibitedActions: guidance,
  criteria: z.array(criterionSchema).min(1).max(100), cases: z.array(caseSchema).max(100),
}).strict().superRefine((input, ctx) => {
  const ids = new Set(input.criteria.map(item => item.id));
  if (ids.size !== input.criteria.length) ctx.addIssue({ code: "custom", path: ["criteria"], message: "Criterion IDs must be unique." });
  if (new Set(input.cases.map(item => item.id)).size !== input.cases.length)
    ctx.addIssue({ code: "custom", path: ["cases"], message: "Case IDs must be unique." });
  input.cases.forEach((item, index) => {
    if (new Set(item.criterionIds).size !== item.criterionIds.length || item.criterionIds.some(id => !ids.has(id)))
      ctx.addIssue({ code: "custom", path: ["cases", index, "criterionIds"], message: "Choose unique criteria from this profile." });
  });
});

export function parseEvaluationProfile(input: unknown): SaveEvaluationProfileInput {
  const parsed = saveSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > 200 * 1024)
    throw new EvaluationError(413, "Evaluation profile exceeds 200 KiB. Reduce its text or reference external fixtures.");
  return parsed;
}

export function parseEvaluationRevision(input: unknown): number {
  return revision.parse(Number(input));
}

type StoredProfile = EvaluationProfile & { requestId: string; fingerprint: string };
// Schema version is not the content revision. Explicit immutable records preserve author history and retry receipts.
const ProfilesDoc = defineDoc<{ records: StoredProfile[] }>({
  kind: "dispatch.evaluation-profiles", version: 1, scope: "session", initial: () => ({ records: [] }),
});

function publicProfile(record: StoredProfile): EvaluationProfile {
  const { requestId: _requestId, fingerprint: _fingerprint, ...profile } = record;
  // Nested Chord drafts cannot escape the commit that owns their overlay.
  return JSON.parse(JSON.stringify(profile)) as EvaluationProfile;
}

/** The runtime checks agent/company authority in the same transaction before calling these operations. */
export async function readEvaluationProfile(tx: Tx, scope: RuntimeScope, agentId: string): Promise<EvaluationProfileResponse> {
  const records = (await tx.doc(ProfilesDoc)).records.filter(record => record.companyId === scope.companyId && record.agentDefinitionId === agentId);
  const latest = records.at(-1);
  return {
    profile: latest ? publicProfile(latest) : null,
    revisions: records.map(record => ({ revision: record.revision, updatedAt: record.updatedAt, savedBy: record.savedBy, changeReason: record.changeReason })).reverse(),
  };
}

export async function readEvaluationProfileRevision(tx: Tx, scope: RuntimeScope, agentId: string, revision: number): Promise<EvaluationProfile> {
  const record = (await tx.doc(ProfilesDoc)).records.find(record => record.companyId === scope.companyId && record.agentDefinitionId === agentId && record.revision === revision);
  if (!record) throw new EvaluationError(404, "Evaluation profile revision not found.");
  return publicProfile(record);
}

export async function saveEvaluationProfile(tx: Tx, scope: RuntimeScope, agentId: string, archived: boolean, input: SaveEvaluationProfileInput): Promise<EvaluationProfile> {
  const { expectedRevision, requestId, changeReason, ...draft } = input;
  const fingerprint = createHash("sha256").update(JSON.stringify([agentId, expectedRevision, changeReason, draft])).digest("hex");
  const doc = await tx.doc(ProfilesDoc);
  const records = doc.records.filter(record => record.companyId === scope.companyId);
  const replay = records.find(record => record.savedBy === scope.userId && record.requestId === requestId);
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw new EvaluationError(409, "This request ID was already used for different evaluation data.");
    return publicProfile(replay);
  }
  if (archived) throw new EvaluationError(409, "This agent is archived. Its evaluation profile is read-only.");
  const previous = records.findLast(record => record.agentDefinitionId === agentId);
  if ((previous?.revision ?? null) !== expectedRevision)
    throw new EvaluationError(409, "The evaluation profile has changed. Reload the latest revision before saving.");
  if (previous?.revision === Number.MAX_SAFE_INTEGER) throw new EvaluationError(409, "Evaluation revision limit reached.");
  const now = Date.now();
  const record: StoredProfile = {
    ...draft, id: previous?.id ?? randomUUID(), companyId: scope.companyId, agentDefinitionId: agentId,
    revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
    savedBy: scope.userId, changeReason, requestId, fingerprint,
  };
  doc.records.push(record);
  return publicProfile(record);
}
