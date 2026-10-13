import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { sep } from "node:path";
import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { RuntimeScope } from "../src/shared/contracts.js";
import type { AppendEvaluationResultInput, CreateEvaluationComparisonInput, EvaluationComparisonCaseView, EvaluationComparisonResponse, EvaluationCriterion, EvaluationExposure, EvaluationFixtureBinding, EvaluationGate, EvaluationMeasurements, EvaluationProfile, EvaluationProfileResponse, EvaluationResult, EvaluationRun, EvaluationVariantKind, SaveEvaluationProfileInput } from "../src/shared/evaluations.js";

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
  id: z.string().uuid(), name: nonblank(200), enabled: z.boolean(), split: z.enum(["tuning", "held_out"]), prompt: nonblank(20_000),
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
  const parsed = JSON.parse(JSON.stringify(profile)) as EvaluationProfile;
  // Profiles saved before `split` existed are tuning cases; never infer held-out intent.
  for (const item of parsed.cases) if (item.split !== "tuning" && item.split !== "held_out") item.split = "tuning";
  return parsed;
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

// --- Comparison creation, judgments, and reads (contract v1) ---

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const measurementsSchema = z.object({
  totalTokens: z.number().nonnegative().nullable(), cachedInputTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(), elapsedSeconds: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
}).strict();
const emptyMeasurements: EvaluationMeasurements = { totalTokens: null, cachedInputTokens: null, outputTokens: null, elapsedSeconds: null, costUsd: null };

const createComparisonSchema = z.object({
  operationId: nonblank(200), profileRevision: revision, expectedAgentRevision: revision,
  caseIds: z.array(z.string().uuid()).min(1).max(100), candidateInstructions: z.string().max(100_000),
  fixtures: z.record(z.string().uuid(), z.object({
    fixtureId: nonblank(200),
    scriptedMessages: z.array(z.object({ authorLabel: nonblank(200), text: nonblank(20_000) }).strict()).max(50),
  }).strict()),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.caseIds).size !== input.caseIds.length)
    ctx.addIssue({ code: "custom", path: ["caseIds"], message: "Case IDs must be unique." });
  for (const caseId of input.caseIds)
    if (!input.fixtures[caseId]) ctx.addIssue({ code: "custom", path: ["fixtures", caseId], message: "Every selected case needs a fixture binding." });
});

export function parseCreateEvaluationComparison(input: unknown): CreateEvaluationComparisonInput {
  return createComparisonSchema.parse(input);
}

const appendResultSchema = z.object({
  operationId: nonblank(200),
  criteria: z.array(z.object({
    criterionId: z.string().uuid(),
    verdict: z.enum(["pass", "fail", "insufficient", "not_applicable", "not_evaluated"]),
    reason: nonblank(10_000),
    evidenceReferences: z.array(nonblank(2_048)).max(50),
  }).strict()).min(1).max(100),
  agentUsage: measurementsSchema.optional(), evaluatorUsage: measurementsSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.criteria.map(item => item.criterionId)).size !== input.criteria.length)
    ctx.addIssue({ code: "custom", path: ["criteria"], message: "Criterion rows must be unique." });
});

export function parseAppendEvaluationResult(input: unknown): AppendEvaluationResultInput {
  return appendResultSchema.parse(input);
}

/** Operator-provisioned fixture list; the client names a fixture, the server verifies it. */
type FixtureRegistryEntry = {
  id: string; definitionSha256: string; capturedState: string[];
  instances: Record<EvaluationVariantKind, { instanceId: string; path: string }>;
};
const fixtureRegistrySchema = z.array(z.object({
  id: nonblank(200), definitionSha256: z.string().regex(/^[0-9a-f]{64}$/),
  capturedState: z.array(nonblank(2_048)).max(100),
  instances: z.object({
    baseline: z.object({ instanceId: nonblank(200), path: nonblank(4_096) }).strict(),
    candidate: z.object({ instanceId: nonblank(200), path: nonblank(4_096) }).strict(),
  }).strict(),
}).strict()).max(100);

/** Resolves each selected case to two independently prepared, existing fixture instances. */
export async function resolveEvaluationFixtures(input: CreateEvaluationComparisonInput): Promise<Record<string, Record<EvaluationVariantKind, EvaluationFixtureBinding>>> {
  const file = process.env.DISPATCH_EVAL_FIXTURES_FILE;
  if (!file) throw new EvaluationError(409, "No evaluation fixture registry is configured (DISPATCH_EVAL_FIXTURES_FILE). Fixtures are operator-provisioned; comparisons cannot start without one.");
  let registry: FixtureRegistryEntry[];
  try { registry = fixtureRegistrySchema.parse(JSON.parse(await readFile(file, "utf8"))) as FixtureRegistryEntry[]; }
  catch { throw new EvaluationError(409, "The evaluation fixture registry is unreadable or invalid. Fix DISPATCH_EVAL_FIXTURES_FILE before starting a comparison."); }
  const resolved: Record<string, Record<EvaluationVariantKind, EvaluationFixtureBinding>> = {};
  // Canonical paths across the whole request: aliased or nested instances are not independent.
  const claimed: string[] = [];
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
  for (const caseId of input.caseIds) {
    const entry = registry.find(item => item.id === input.fixtures[caseId]!.fixtureId);
    if (!entry) throw new EvaluationError(409, `Fixture "${input.fixtures[caseId]!.fixtureId}" is not in the operator-provisioned registry.`);
    const bindings = {} as Record<EvaluationVariantKind, EvaluationFixtureBinding>;
    for (const variant of ["baseline", "candidate"] as const) {
      const instance = entry.instances[variant];
      const info = await stat(instance.path).catch(() => null);
      if (!info?.isDirectory()) throw new EvaluationError(409, `Fixture "${entry.id}" ${variant} instance is not an existing directory: ${instance.path}`);
      const canonical = await realpath(instance.path);
      if (claimed.some(path => overlaps(path, canonical)))
        throw new EvaluationError(409, `Fixture "${entry.id}" ${variant} instance overlaps another instance in this comparison: ${instance.path}`);
      claimed.push(canonical);
      bindings[variant] = { fixtureId: entry.id, definitionSha256: entry.definitionSha256, instanceId: instance.instanceId, effectivePath: canonical, capturedState: [...entry.capturedState] };
    }
    resolved[caseId] = bindings;
  }
  return resolved;
}

type FrozenCase = {
  caseId: string; name: string; split: "tuning" | "held_out"; exposure: EvaluationExposure;
  criteria: { criterionId: string; description: string; criticalFailure: boolean; gradingMethod: EvaluationCriterion["gradingMethod"] }[];
  /** Server-only: projected to the tested agent at admission; never in public reads beyond this store. */
  prompt: string; startingConditions: string; inputArtifacts: { name: string; reference: string; sha256: string }[];
  scriptedMessages: { authorLabel: string; text: string }[];
};
type StoredComparison = {
  id: string; companyId: string; agentDefinitionId: string; agentRevision: number;
  profileId: string; profileRevision: number; candidateInstructions: string;
  cases: FrozenCase[]; createdAt: number; requestedBy: string; operationId: string; fingerprint: string;
};
type StoredRun = EvaluationRun;
type StoredResult = EvaluationResult & { operationId: string; fingerprint: string; agentDefinitionId: string };
const ComparisonsDoc = defineDoc<{ comparisons: StoredComparison[]; runs: StoredRun[]; results: StoredResult[] }>({
  kind: "dispatch.evaluation-comparisons", version: 1, scope: "session",
  initial: () => ({ comparisons: [], runs: [], results: [] }),
});

export type FrozenRunConfiguration = EvaluationRun["configuration"];
export type EvaluationComparisonReceipt = { comparisonId: string; runs: { caseId: string; variant: EvaluationVariantKind; runId: string }[] };

function comparisonFingerprint(agentId: string, input: CreateEvaluationComparisonInput): string {
  return sha256(JSON.stringify([agentId, input.profileRevision, input.expectedAgentRevision, input.caseIds, sha256(input.candidateInstructions), input.fixtures]));
}

function comparisonReceipt(doc: { runs: StoredRun[] }, comparison: StoredComparison): EvaluationComparisonReceipt {
  return { comparisonId: comparison.id, runs: doc.runs.filter(run => run.comparisonId === comparison.id)
    .map(run => ({ caseId: run.source.kind === "standalone" ? run.source.caseId : "", variant: run.variant.kind, runId: run.id })) };
}

/**
 * Scoped retry lookup, checked after caller authorization but before any fresh-admission
 * prerequisite (fixture readiness, archived state, agent revision): a committed creation
 * whose response was lost must return its original receipt, not a prerequisite failure.
 */
export async function findEvaluationComparisonReplay(tx: Tx, scope: RuntimeScope, agentId: string, input: CreateEvaluationComparisonInput): Promise<EvaluationComparisonReceipt | null> {
  const doc = await tx.doc(ComparisonsDoc);
  const replay = doc.comparisons.find(item => item.companyId === scope.companyId && item.requestedBy === scope.userId && item.operationId === input.operationId);
  if (!replay) return null;
  if (replay.fingerprint !== comparisonFingerprint(agentId, input)) throw new EvaluationError(409, "This operation ID was already used for a different comparison.");
  return comparisonReceipt(doc, replay);
}

/**
 * Atomically persists the admission manifest and every expected run as pending.
 * Admission/execution is a separate runtime step; pending here never implies a run happened.
 * The runtime verifies agent authority, archived state, and expectedAgentRevision in the same transaction first.
 */
export async function createEvaluationComparison(tx: Tx, scope: RuntimeScope, agentId: string, input: CreateEvaluationComparisonInput,
  resolved: { fixtures: Record<string, Record<EvaluationVariantKind, EvaluationFixtureBinding>>; agentRevision: number;
    configuration: Record<EvaluationVariantKind, FrozenRunConfiguration>; baselineInstructions: string }): Promise<{ comparisonId: string; runs: { caseId: string; variant: EvaluationVariantKind; runId: string }[] }> {
  const profile = await readEvaluationProfileRevision(tx, scope, agentId, input.profileRevision);
  const fingerprint = comparisonFingerprint(agentId, input);
  const doc = await tx.doc(ComparisonsDoc);
  // Second line of defense for a concurrent identical creation; the runtime checks replay first.
  const replay = doc.comparisons.find(item => item.companyId === scope.companyId && item.requestedBy === scope.userId && item.operationId === input.operationId);
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw new EvaluationError(409, "This operation ID was already used for a different comparison.");
    return comparisonReceipt(doc, replay);
  }
  const now = Date.now();
  const comparisonId = randomUUID();
  const frozenCases: FrozenCase[] = [];
  const runs: StoredRun[] = [];
  for (const caseId of input.caseIds) {
    const item = profile.cases.find(entry => entry.id === caseId);
    if (!item) throw new EvaluationError(409, `Case ${caseId} is not in profile revision ${input.profileRevision}.`);
    if (!item.enabled) throw new EvaluationError(409, `Case "${item.name}" is disabled in profile revision ${input.profileRevision}.`);
    // Server-derived provenance: held_out_clean stays unavailable until an evaluator-controlled
    // mechanism can substantiate that the tested agent never saw the case.
    const exposure: EvaluationExposure = item.split === "tuning" ? "tuning" : "previously_exposed_validation";
    const criteria = item.criterionIds.map(criterionId => {
      const criterion = profile.criteria.find(entry => entry.id === criterionId)!;
      return { criterionId, description: criterion.description, criticalFailure: criterion.criticalFailure, gradingMethod: criterion.gradingMethod };
    });
    frozenCases.push({ caseId, name: item.name, split: item.split, exposure, criteria,
      prompt: item.prompt, startingConditions: item.startingConditions, inputArtifacts: item.inputArtifacts,
      scriptedMessages: input.fixtures[caseId]!.scriptedMessages });
    for (const variant of ["baseline", "candidate"] as const) {
      runs.push({
        id: randomUUID(), companyId: scope.companyId, agentDefinitionId: agentId, agentRevision: resolved.agentRevision,
        profileId: profile.id, profileRevision: profile.revision, comparisonId,
        variant: { kind: variant, instructionsSha256: sha256(variant === "candidate" ? input.candidateInstructions : resolved.baselineInstructions) },
        caseSplit: item.split, exposure, fixture: resolved.fixtures[caseId]![variant],
        attempt: { taskId: null, roomId: null, participantId: null, entryBoundary: null },
        source: { kind: "standalone", caseId, agentConversationId: null },
        configuration: resolved.configuration[variant], status: "pending", output: "unknown",
        requestedBy: scope.userId, operationId: input.operationId, createdAt: now,
        startedAt: null, finishedAt: null, error: null, evidenceReferences: [], coverageLimitations: [],
      });
    }
  }
  doc.comparisons.push({ id: comparisonId, companyId: scope.companyId, agentDefinitionId: agentId,
    agentRevision: resolved.agentRevision, profileId: profile.id, profileRevision: profile.revision,
    candidateInstructions: input.candidateInstructions, cases: frozenCases, createdAt: now,
    requestedBy: scope.userId, operationId: input.operationId, fingerprint });
  doc.runs.push(...runs);
  return { comparisonId, runs: runs.map(run => ({ caseId: run.source.kind === "standalone" ? run.source.caseId : "", variant: run.variant.kind, runId: run.id })) };
}

const terminalRun = (run: EvaluationRun) => run.status === "completed" || run.status === "failed" || run.status === "cancelled";

/** Append-only human judgment. Evidence references must resolve to evidence recorded on the run. */
export async function appendEvaluationResult(tx: Tx, scope: RuntimeScope, agentId: string, runId: string, input: AppendEvaluationResultInput): Promise<EvaluationResult> {
  const doc = await tx.doc(ComparisonsDoc);
  const run = doc.runs.find(item => item.companyId === scope.companyId && item.agentDefinitionId === agentId && item.id === runId);
  if (!run) throw new EvaluationError(404, "Evaluation run not found.");
  const fingerprint = sha256(JSON.stringify([runId, input.criteria, input.agentUsage ?? null, input.evaluatorUsage ?? null]));
  const replay = doc.results.find(item => item.companyId === scope.companyId && item.runId === runId && item.operationId === input.operationId
    && item.criteria[0]?.grader.identity === scope.userId);
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw new EvaluationError(409, "This operation ID was already used for a different judgment.");
    return publicResult(replay);
  }
  if (!terminalRun(run)) throw new EvaluationError(409, "Only a finished run can be graded.");
  const comparison = doc.comparisons.find(item => item.id === run.comparisonId);
  const frozen = comparison?.cases.find(item => run.source.kind === "standalone" && item.caseId === run.source.caseId);
  if (!comparison || !frozen) throw new EvaluationError(409, "This run has no frozen comparison manifest to grade against.");
  const allowed = new Map(frozen.criteria.map(item => [item.criterionId, item]));
  for (const row of input.criteria) {
    if (!allowed.has(row.criterionId)) throw new EvaluationError(409, "Judgments must use the criteria frozen at comparison creation.");
    if ((row.verdict === "pass" || row.verdict === "fail") && row.evidenceReferences.length === 0)
      throw new EvaluationError(409, "Pass and fail verdicts require at least one evidence reference.");
    for (const ref of row.evidenceReferences)
      if (!run.evidenceReferences.includes(ref)) throw new EvaluationError(409, `Evidence reference does not resolve to recorded run evidence: ${ref}`);
  }
  const result: StoredResult = {
    id: randomUUID(), companyId: scope.companyId, runId, createdAt: Date.now(),
    gradingStatus: input.criteria.length === frozen.criteria.length ? "completed" : "incomplete",
    errors: [], reviewReasons: [],
    criteria: input.criteria.map(row => ({ ...row, grader: { method: "human" as const, identity: scope.userId, version: "1", configuration: "" } })),
    agentUsage: input.agentUsage ?? { ...emptyMeasurements }, evaluatorUsage: input.evaluatorUsage ?? { ...emptyMeasurements },
    operationId: input.operationId, fingerprint, agentDefinitionId: agentId,
  };
  doc.results.push(result);
  return publicResult(result);
}

function publicResult(result: StoredResult): EvaluationResult {
  const { operationId: _operationId, fingerprint: _fingerprint, agentDefinitionId: _agentDefinitionId, ...rest } = result;
  return JSON.parse(JSON.stringify(rest)) as EvaluationResult;
}

/**
 * Total gate: an observed critical failure blocks first, regardless of row order or grading
 * completeness; anything short of a complete, fully passing critical set is unresolved, never clear.
 */
export function evaluationGateFor(frozen: Pick<FrozenCase, "criteria">, candidate: { run: EvaluationRun; latestResult: EvaluationResult | null } | null): EvaluationGate {
  if (!candidate || !terminalRun(candidate.run) || !candidate.latestResult) return "unresolved";
  const latest = candidate.latestResult;
  const rows = new Map(latest.criteria.map(row => [row.criterionId, row.verdict]));
  for (const criterion of frozen.criteria)
    if (criterion.criticalFailure && rows.get(criterion.criterionId) === "fail") return "blocked";
  if (latest.gradingStatus !== "completed") return "unresolved";
  for (const criterion of frozen.criteria) {
    const verdict = rows.get(criterion.criterionId);
    if (verdict === undefined) return "unresolved";
    if (criterion.criticalFailure && verdict !== "pass") return "unresolved";
  }
  return "clear";
}

export async function readEvaluationComparison(tx: Tx, scope: RuntimeScope, agentId: string, comparisonId: string): Promise<EvaluationComparisonResponse> {
  const doc = await tx.doc(ComparisonsDoc);
  const comparison = doc.comparisons.find(item => item.companyId === scope.companyId && item.agentDefinitionId === agentId && item.id === comparisonId);
  if (!comparison) throw new EvaluationError(404, "Evaluation comparison not found.");
  const cases: EvaluationComparisonCaseView[] = comparison.cases.map(frozen => {
    const viewFor = (variant: EvaluationVariantKind) => {
      const run = doc.runs.find(item => item.comparisonId === comparison.id && item.variant.kind === variant
        && item.source.kind === "standalone" && item.source.caseId === frozen.caseId);
      if (!run) return null;
      const results = doc.results.filter(item => item.runId === run.id).map(publicResult);
      const publicRun = JSON.parse(JSON.stringify(run)) as EvaluationRun;
      const refs = new Set([...run.evidenceReferences, ...results.flatMap(result => result.criteria.flatMap(row => row.evidenceReferences))]);
      return { run: publicRun, latestResult: results.at(-1) ?? null, results,
        evidence: [...refs].map(ref => ({ ref, label: ref, url: null, available: run.evidenceReferences.includes(ref), truncated: false })) };
    };
    const runs = { baseline: viewFor("baseline"), candidate: viewFor("candidate") };
    const regressions: string[] = [];
    if (runs.baseline?.latestResult && runs.candidate?.latestResult) {
      const candidateRows = new Map(runs.candidate.latestResult.criteria.map(row => [row.criterionId, row.verdict]));
      for (const row of runs.baseline.latestResult.criteria)
        if (row.verdict === "pass" && candidateRows.get(row.criterionId) !== "pass") regressions.push(row.criterionId);
    }
    return { caseId: frozen.caseId, name: frozen.name, split: frozen.split, exposure: frozen.exposure,
      criteria: frozen.criteria, runs, gate: evaluationGateFor(frozen, runs.candidate),
      complete: Boolean(runs.baseline && runs.candidate
        && runs.baseline.latestResult?.gradingStatus === "completed" && runs.candidate.latestResult?.gradingStatus === "completed"),
      regressions };
  });
  return { comparison: { id: comparison.id, agentDefinitionId: comparison.agentDefinitionId, agentRevision: comparison.agentRevision,
    profileId: comparison.profileId, profileRevision: comparison.profileRevision,
    candidateInstructionsSha256: sha256(comparison.candidateInstructions), createdAt: comparison.createdAt, requestedBy: comparison.requestedBy }, cases };
}
