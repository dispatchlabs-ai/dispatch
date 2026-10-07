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

export type EvaluationCase = {
  id: string;
  name: string;
  enabled: boolean;
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

/** Contract for later execution work; this slice does not launch runs or manufacture results. */
export type EvaluationRun = {
  id: string;
  companyId: string;
  agentDefinitionId: string;
  agentRevision: number;
  profileId: string;
  profileRevision: number;
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
