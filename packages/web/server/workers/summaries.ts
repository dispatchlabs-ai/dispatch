import { z } from "zod";

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
