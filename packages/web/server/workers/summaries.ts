import { z } from "zod";
import type { ChatSummary } from "../../src/shared/contracts.js";

/** Public room observations only. Directory-owned identity, ACLs and preferences
 * must never be accepted from a worker summary. */
export const workerSummarySchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["idle", "running", "stopped", "failed"]),
  error: z.string().optional(),
  suggestedTitle: z.string().max(80).optional(),
}).strict();
export type WorkerSummary = z.infer<typeof workerSummarySchema>;

export const storedWorkerSummarySchema = z.object({
  attemptId: z.string().uuid(),
  value: workerSummarySchema,
}).strict();
export type WorkerSummaryObservation = { value: WorkerSummary; stale: boolean };

/** Merge only after directory authorization; worker revisions order observations,
 * not the independent directory metadata or browser transcript stream. */
export function mergeWorkerSummary(base: ChatSummary, automaticTitle: boolean, observation: WorkerSummaryObservation | undefined): ChatSummary {
  const result = { ...base };
  delete result.error;
  if (observation) {
    result.updatedAt = Math.max(base.createdAt, observation.value.updatedAt);
    if (automaticTitle && observation.value.suggestedTitle) result.title = observation.value.suggestedTitle;
  }
  if (!observation || observation.stale) {
    result.status = "failed";
    result.error = "Worker status unavailable.";
  } else {
    result.status = observation.value.status;
    if (observation.value.error) result.error = observation.value.error;
  }
  return result;
}
