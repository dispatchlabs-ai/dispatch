import type { SubmissionRecord } from "@earendil-works/pi-durable";

/** Submission lifecycle, not tool success or an agent's narration of completion. */
export interface ChatTurn {
  submissionId: number;
  entryId?: number;
  status: "queued" | "placed" | "done" | "unanswered";
  reason?: string;
}
export function projectChatTurns(submissions: readonly SubmissionRecord[]): ChatTurn[] {
  return submissions.filter(record => record.type === "input" || record.type === "continue").map(record => ({
    submissionId: record.id, status: record.status,
    ...(record.entry !== undefined ? { entryId: record.entry } : {}),
    ...(record.status === "unanswered" ? { reason: record.reason } : {}),
  }));
}
