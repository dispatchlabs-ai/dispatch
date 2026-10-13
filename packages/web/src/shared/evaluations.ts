/** Dispatch evaluation data. Profiles are never part of an agent's operating prompt. */
export type EvaluationGradingMethod = "direct" | "judge" | "human";
export type EvaluationCriterion = {
  id: string;
  description: string;
  gradingMethod: EvaluationGradingMethod;
  criticalFailure: boolean;
  /** Describes the check or rubric; saving this text does not execute it. */
  gradingGuidance: string;
}

/** A retained reference, not an upload, access grant, or verified fixture installation. */
export type EvaluationArtifactReference = {
  name: string;
  reference: string;
  sha256: string;
}

export type EvaluationCaseSplit = "tuning" | "held_out";

export type EvaluationCase = {
  id: string;
  name: string;
  enabled: boolean;
  /** Held-out cases stay out of instruction tuning. Legacy stored cases normalize to "tuning" on read. */
  split: EvaluationCaseSplit;
  prompt: string;
  startingConditions: string;
  inputArtifacts: EvaluationArtifactReference[];
  expectedOutcome: string;
  criterionIds: string[];
  gradingGuidance: string;
  evaluatorOnly: { referenceAnswer: string; checks: string };
}

export type EvaluationProfileDraft = {
  responsibilities: string;
  expectedBehavior: string;
  prohibitedActions: string;
  criteria: EvaluationCriterion[];
  cases: EvaluationCase[];
}

export type EvaluationProfile = EvaluationProfileDraft & {
  id: string;
  companyId: string;
  agentDefinitionId: string;
  /** Content revision, independent of the Pi document schema version and agent revision. */
  revision: number;
  createdAt: number;
  updatedAt: number;
  savedBy: string;
  changeReason: string;
}

export type SaveEvaluationProfileInput = EvaluationProfileDraft & {
  /** null means create only if no profile exists. */
  expectedRevision: number | null;
  requestId: string;
  changeReason: string;
}

export type EvaluationProfileRevision = Pick<EvaluationProfile, "revision" | "updatedAt" | "savedBy" | "changeReason">;
export type EvaluationProfileResponse = {
  profile: EvaluationProfile | null;
  revisions: EvaluationProfileRevision[];
}

export type EvaluationVariantKind = "baseline" | "candidate";
/** How much the tested agent could already know about the case. */
export type EvaluationExposure = "tuning" | "previously_exposed_validation" | "held_out_clean";

/** Server-verified fixture binding for one variant instance. */
export type EvaluationFixtureBinding = {
  fixtureId: string;
  definitionSha256: string;
  instanceId: string;
  effectivePath: string;
  capturedState: string[];
};

export type EvaluationRun = {
  id: string;
  companyId: string;
  agentDefinitionId: string;
  agentRevision: number;
  profileId: string;
  profileRevision: number;
  comparisonId: string | null;
  variant: { kind: EvaluationVariantKind; instructionsSha256: string | null };
  caseSplit: EvaluationCaseSplit | null;
  exposure: EvaluationExposure | null;
  fixture: EvaluationFixtureBinding | null;
  /** Admitted backend attempt; evidence binds to this identity, not to record ordering. */
  attempt: { taskId: string | null; roomId: string | null; participantId: string | null; entryBoundary: string | null };
  source:
    | { kind: "standalone"; caseId: string; agentConversationId: string | null }
    | { kind: "real_usage"; agentConversationId: string; roomId: string; submissionIds: string[];
        firstEntryId: string; lastEntryId: string; taskRequirements: string };
  configuration: { runtimeVersion: string; model: string; provider: string;
    skills: { id: string; revision: number }[]; capabilities: { name: string; version: string | null }[];
    environmentReference: string; environmentSha256: string | null };
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  requestedBy: string;
  operationId: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  evidenceReferences: string[];
  coverageLimitations: string[];
}

export type EvaluationVerdict = "pass" | "fail" | "insufficient" | "not_applicable" | "not_evaluated";
export type EvaluationMeasurements = {
  totalTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  elapsedSeconds: number | null;
  costUsd: number | null;
}

/** Regrading appends a new result; it must not overwrite an earlier judgment. */
export type EvaluationResult = {
  id: string;
  companyId: string;
  runId: string;
  createdAt: number;
  gradingStatus: "completed" | "failed" | "incomplete";
  errors: string[];
  reviewReasons: string[];
  criteria: { criterionId: string; verdict: EvaluationVerdict; reason: string; evidenceReferences: string[];
    grader: { method: EvaluationGradingMethod; identity: string; version: string; configuration: string } }[];
  agentUsage: EvaluationMeasurements;
  evaluatorUsage: EvaluationMeasurements;
}

export type EvaluationScriptedMessage = { authorLabel: string; text: string };

export type CreateEvaluationComparisonInput = {
  operationId: string;
  profileRevision: number;
  /** Checked before admission; a mismatch rejects the experiment instead of rebasing it. */
  expectedAgentRevision: number;
  caseIds: string[];
  /** Instruction-only candidate; stored server-side, identified publicly by digest. */
  candidateInstructions: string;
  /** Exposure per case as declared by the evaluator; held_out cases default to previously exposed. */
  exposure?: Record<string, EvaluationExposure>;
  /** Fixture definitions resolve server-side; clients never attest readiness. */
  fixtures: Record<string, { fixtureId: string; scriptedMessages: EvaluationScriptedMessage[] }>;
}

export type CreateEvaluationComparisonResponse = {
  comparisonId: string;
  runs: { caseId: string; variant: EvaluationVariantKind; runId: string }[];
}

export type AppendEvaluationResultInput = {
  operationId: string;
  criteria: { criterionId: string; verdict: EvaluationVerdict; reason: string; evidenceReferences: string[] }[];
  agentUsage?: EvaluationMeasurements;
  evaluatorUsage?: EvaluationMeasurements;
}

export type EvaluationEvidenceView = {
  ref: string;
  label: string;
  url: string | null;
  available: boolean;
  truncated: boolean;
}

export type EvaluationGate = "blocked" | "unresolved" | "clear";

export type EvaluationComparisonCaseView = {
  caseId: string;
  name: string;
  split: EvaluationCaseSplit;
  exposure: EvaluationExposure;
  criteria: { criterionId: string; description: string; criticalFailure: boolean; gradingMethod: EvaluationGradingMethod }[];
  runs: Record<EvaluationVariantKind, {
    run: EvaluationRun;
    latestResult: EvaluationResult | null;
    results: EvaluationResult[];
    evidence: EvaluationEvidenceView[];
  } | null>;
  gate: EvaluationGate;
  complete: boolean;
  regressions: string[];
}

export type EvaluationComparisonResponse = {
  comparison: {
    id: string;
    agentDefinitionId: string;
    agentRevision: number;
    profileId: string;
    profileRevision: number;
    candidateInstructionsSha256: string;
    createdAt: number;
    requestedBy: string;
  };
  cases: EvaluationComparisonCaseView[];
}
