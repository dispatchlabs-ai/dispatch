import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EvaluationError, evaluationGateFor, parseAppendEvaluationResult,
  parseCreateEvaluationComparison, parseEvaluationProfile, resolveEvaluationFixtures,
} from "./evaluations.js";
import type { EvaluationResult, EvaluationRun } from "../src/shared/evaluations.js";

const criterionId = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";

const profileInput = (split?: string) => ({
  expectedRevision: null, requestId: "r1", changeReason: "test",
  responsibilities: "r", expectedBehavior: "e", prohibitedActions: "",
  criteria: [{ id: criterionId, description: "d", gradingMethod: "human", criticalFailure: true, gradingGuidance: "" }],
  cases: [{ id: caseId, name: "c", enabled: true, ...(split ? { split } : {}), prompt: "p",
    startingConditions: "", inputArtifacts: [], expectedOutcome: "o", criterionIds: [criterionId],
    gradingGuidance: "", evaluatorOnly: { referenceAnswer: "", checks: "" } }],
});

test("profile saves require an explicit split", () => {
  assert.throws(() => parseEvaluationProfile(profileInput()));
  assert.equal(parseEvaluationProfile(profileInput("held_out")).cases[0]!.split, "held_out");
});

const comparisonInput = () => ({
  operationId: "op-1", profileRevision: 1, expectedAgentRevision: 2, caseIds: [caseId],
  candidateInstructions: "candidate",
  fixtures: { [caseId]: { fixtureId: "fx", scriptedMessages: [] } },
});

test("comparison creation pins the agent revision and per-case fixtures", () => {
  const parsed = parseCreateEvaluationComparison(comparisonInput());
  assert.equal(parsed.expectedAgentRevision, 2);
  assert.throws(() => parseCreateEvaluationComparison({ ...comparisonInput(), fixtures: {} }));
  assert.throws(() => parseCreateEvaluationComparison({ ...comparisonInput(), caseIds: [caseId, caseId] }));
});

test("fixture resolution fails closed without an operator registry", async () => {
  delete process.env.DISPATCH_EVAL_FIXTURES_FILE;
  await assert.rejects(resolveEvaluationFixtures(parseCreateEvaluationComparison(comparisonInput())),
    (error: unknown) => error instanceof EvaluationError && error.status === 409);
});

test("fixture resolution verifies separate existing variant instances server-side", async () => {
  const root = await mkdtemp(join(tmpdir(), "eval-fixtures-"));
  const baseline = join(root, "baseline"); const candidate = join(root, "candidate");
  await mkdir(baseline); await mkdir(candidate);
  const registry = join(root, "fixtures.json");
  await writeFile(registry, JSON.stringify([{ id: "fx", definitionSha256: "a".repeat(64), capturedState: ["repo"],
    instances: { baseline: { instanceId: "b1", path: baseline }, candidate: { instanceId: "c1", path: candidate } } }]));
  process.env.DISPATCH_EVAL_FIXTURES_FILE = registry;
  const resolved = await resolveEvaluationFixtures(parseCreateEvaluationComparison(comparisonInput()));
  assert.equal(resolved[caseId]!.baseline.effectivePath, baseline);
  assert.equal(resolved[caseId]!.candidate.instanceId, "c1");
  delete process.env.DISPATCH_EVAL_FIXTURES_FILE;
});

test("judgments require a rationale on every row", () => {
  assert.throws(() => parseAppendEvaluationResult({ operationId: "j1",
    criteria: [{ criterionId, verdict: "insufficient", reason: "", evidenceReferences: [] }] }));
  const parsed = parseAppendEvaluationResult({ operationId: "j1",
    criteria: [{ criterionId, verdict: "insufficient", reason: "capture missing", evidenceReferences: [] }] });
  assert.equal(parsed.criteria[0]!.verdict, "insufficient");
});

const run = (status: EvaluationRun["status"]): EvaluationRun => ({
  id: "run", companyId: "co", agentDefinitionId: "ag", agentRevision: 1, profileId: "p", profileRevision: 1,
  comparisonId: "cmp", variant: { kind: "candidate", instructionsSha256: null }, caseSplit: "tuning",
  exposure: "tuning", fixture: null, attempt: { taskId: null, roomId: null, participantId: null, entryBoundary: null },
  source: { kind: "standalone", caseId, agentConversationId: null },
  configuration: { runtimeVersion: "pi", model: "m", provider: "p", skills: [], capabilities: [], environmentReference: "", environmentSha256: null },
  status, requestedBy: "u", operationId: "op", createdAt: 0, startedAt: null, finishedAt: null,
  error: null, evidenceReferences: [], coverageLimitations: [],
});
const result = (verdict: string, gradingStatus: EvaluationResult["gradingStatus"] = "completed"): EvaluationResult => ({
  id: "res", companyId: "co", runId: "run", createdAt: 0, gradingStatus, errors: [], reviewReasons: [],
  criteria: [{ criterionId, verdict: verdict as never, reason: "r", evidenceReferences: [],
    grader: { method: "human", identity: "u", version: "1", configuration: "" } }],
  agentUsage: { totalTokens: null, cachedInputTokens: null, outputTokens: null, elapsedSeconds: null, costUsd: null },
  evaluatorUsage: { totalTokens: null, cachedInputTokens: null, outputTokens: null, elapsedSeconds: null, costUsd: null },
});
const frozen = { criteria: [{ criterionId, description: "d", criticalFailure: true, gradingMethod: "human" as const }] };

test("gate derivation is total: only a complete critical pass clears", () => {
  assert.equal(evaluationGateFor(frozen, null), "unresolved");
  assert.equal(evaluationGateFor(frozen, { run: run("pending"), latestResult: result("pass") }), "unresolved");
  assert.equal(evaluationGateFor(frozen, { run: run("completed"), latestResult: null }), "unresolved");
  assert.equal(evaluationGateFor(frozen, { run: run("completed"), latestResult: result("pass", "incomplete") }), "unresolved");
  assert.equal(evaluationGateFor(frozen, { run: run("completed"), latestResult: result("insufficient") }), "unresolved");
  assert.equal(evaluationGateFor(frozen, { run: run("completed"), latestResult: result("fail") }), "blocked");
  assert.equal(evaluationGateFor(frozen, { run: run("completed"), latestResult: result("pass") }), "clear");
});
