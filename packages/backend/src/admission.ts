import { join } from "node:path";
import { readStore } from "./stores.js";
import { AdmissionError } from "./config.js";

// Called inside the owning worker, AFTER ChatService has acquired every native
// owner lock, immediately before operations which may enable a scheduler (abort
// does this too). Paused harnesses cannot add work between this check and resume.
// Do not apply a selected-conversation test only to the primary: send resumes the
// messaging closure, and native abort resumes its selected host implicitly.
export function checkSuspendedWork(
  path: string,
  pausedAgents: string[],
  selected?: { agent: string; conversationId: number },
) {
  for (const agent of pausedAgents)
    readStore(join(path, agent, "session.sqlite"), (db) => {
      const allowed = new Set<number>();
      if (agent === selected?.agent) {
        allowed.add(selected.conversationId);
        const conversations = db
          .prepare("SELECT id,record FROM conversations")
          .all()
          .map((row) => ({
            id: Number(row.id),
            record: JSON.parse(String(row.record)),
          }));
        let changed = true;
        while (changed) {
          changed = false;
          for (const conversation of conversations)
            if (
              !allowed.has(conversation.id) &&
              allowed.has(conversation.record.owner?.conversationId)
            ) {
              allowed.add(conversation.id);
              changed = true;
            }
        }
      }
      const tasks = db
        .prepare(
          "SELECT id,conversation_id,kind FROM tasks WHERE status<>'terminal'",
        )
        .all();
      const submissions = db
        .prepare(
          "SELECT id,conversation_id FROM submissions WHERE status IN ('queued','placed')",
        )
        .all();
      const conflicts = [...tasks, ...submissions].filter(
        (record) => !allowed.has(Number(record.conversation_id)),
      );
      const automation = tasks.some(
        (record) =>
          String(record.kind).includes("agent-loop") ||
          String(record.kind).includes("schedule"),
      );
      if (conflicts.length || automation) {
        const conversations = [
          ...new Set(conflicts.map((record) => Number(record.conversation_id))),
        ];
        throw new AdmissionError(
          automation
            ? `${agent} has suspended loop/calendar work. Finish or stop it in its original native owner before retrying; viewing does not resume it.`
            : `${agent} has suspended work outside the selected conversation's ownership tree (conversation IDs: ${conversations.join(", ")}). Finish or stop those conversations in their original native CLI/service, then restart Web and retry. No suspended work was resumed.`,
        );
      }
    });
}
