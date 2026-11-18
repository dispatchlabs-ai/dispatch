import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { openSqliteSnapshot } from "./records.js";
import type { ReviewRun } from "./run-evidence.js";

/** A pending publication keeps the native action task resumable. */
export class ReviewPending extends Error {}

/** A fork's history is independent of the task that owns a delegated conversation. */
export function reviewFamily(database: string, run: ReviewRun) {
  const db = openSqliteSnapshot(database);
  try {
    const conversation = db.prepare("SELECT owner_task_id FROM conversations WHERE id=?").get(run.conversation);
    if (!conversation) throw new Error("Missing review conversation.");
    if (conversation.owner_task_id !== null) return { owned: true } as const;
    const family = `WITH RECURSIVE family(id) AS (
      SELECT id FROM conversations WHERE owner_conversation_id=? AND owner_task_id BETWEEN ? AND ?
      UNION ALL SELECT c.id FROM conversations c JOIN family f ON c.owner_conversation_id=f.id
    ) `;
    const bounds = [run.conversation, run.first, run.last];
    const members = db.prepare(family + `SELECT t.conversation_id AS conversation, t.kind, t.status,
        json_extract(t.record,'$.input.answer') AS answer, json_extract(t.record,'$.state.outcome.result') AS report
      FROM family JOIN tasks t ON t.conversation_id=family.id
      WHERE t.kind IN ('"dispatch.queue-run-review"','"dispatch.review-run"') ORDER BY t.id`).all(...bounds);
    // A worker can return after its parent. Its generation admits the review before leaving its terminal phase.
    const active = db.prepare(family + `SELECT 1 FROM tasks t WHERE t.status!='terminal'
        AND t.kind NOT IN ('"dispatch.review-run"','"dispatch.queue-run-review"','"dispatch.run-review-actions"')
        AND ((t.conversation_id=? AND t.id BETWEEN ? AND ?) OR t.conversation_id IN (SELECT id FROM family))
      UNION ALL SELECT 1 FROM family JOIN submissions s ON s.conversation_id=family.id
        WHERE s.status IN ('queued','placed') LIMIT 1`).get(...bounds, ...bounds);
    const reviews = new Map<string, { conversation: number; answer: number; report?: string }>();
    let pending = Boolean(active);
    for (const row of members) {
      const key = row.conversation + "-" + row.answer;
      const member = reviews.get(key) ?? { conversation: Number(row.conversation), answer: Number(row.answer) };
      if (row.status !== "terminal") pending = true;
      if (row.kind === '"dispatch.review-run"' && typeof row.report === "string") member.report = row.report;
      reviews.set(key, member);
    }
    return { owned: false, pending, members: [...reviews.values()] } as const;
  } finally { db.close(); }
}

type Member = { conversation: number; answer: number; report?: string };
export async function familyReports(rootReport: string, rootText: string, members: readonly Member[]) {
  const rootRoom = dirname(rootReport), evaluations = dirname(dirname(rootRoom));
  const reports = [rootText];
  for (const member of members) {
    // Recover moved state directories and explicit retries of a failed private evaluation.
    const revision = member.report ? basename(dirname(member.report)) : basename(rootRoom);
    if (!/^[0-9a-f]{16}$/.test(revision)) throw new Error("Invalid evaluation revision.");
    const key = member.conversation + "-" + member.answer;
    const file = join(evaluations, key, revision, "review.md");
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error("Missing owned review " + key + ". Retry the incomplete review before publishing this group.");
    }
    if (text.startsWith("**Incomplete evaluation.**")) throw new Error("Incomplete owned review " + key + ".");
    reports.push("Owned run " + key + "\n" + text);
  }
  return reports;
}
