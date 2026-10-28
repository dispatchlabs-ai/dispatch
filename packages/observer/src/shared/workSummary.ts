import type { Conversation } from "./contracts";

export const recordedTime = (at?: number) =>
  at === undefined
    ? "Time not retained"
    : new Date(at).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });

/** Only an explicit opening verdict is a reported result, never inferred success. */
export function reportedResult(text: string): string | undefined {
  const heading = text
    .trimStart()
    .split(/\r?\n/)[0]
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*|`/g, "")
    .trim();
  const verdict =
    /^(?:verdict|result|status)\s*:\s*(.+)$/i.exec(heading)?.[1] ?? heading;
  const labels: Record<string, string> = {
    approved: "Approved",
    changes_requested: "Changes requested",
    "changes requested": "Changes requested",
    blocked: "Blocked",
    completed: "Completed",
    failed: "Failed",
  };
  const key = verdict.toLowerCase();
  return Object.hasOwn(labels, key) ? labels[key] : undefined;
}

export function responseSummary(conversation: Conversation): string {
  if (!conversation.response) return "No saved assistant response";
  const verdict = reportedResult(conversation.response.text);
  if (verdict) return verdict;
  const excerpt = conversation.response.text
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return excerpt.length > 160 ? `${excerpt.slice(0, 160).trimEnd()}…` : excerpt;
}
