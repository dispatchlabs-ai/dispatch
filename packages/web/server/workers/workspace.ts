import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, section, type Harness } from "@earendil-works/pi-durable";

export const WorkerWorkspaceDoc = defineDoc<{ generation?: string; recovered?: boolean; notice?: string }>({
  kind: "dispatch.worker-workspace", version: 1, scope: "session", initial: () => ({}),
});

/** Included in the already-selected collaboration extension; applies to recovered and future agents
 * without rewriting their pinned configuration or inventing a second scheduler.
 */
export const workerWorkspaceSection = section("worker-workspace", async (input, context) =>
  (await input.read.snapshot(WorkerWorkspaceDoc, context))?.notice);

/** Caller owns the disposable state directory and has not resumed Pi. A local generation marker
 * distinguishes process reopen from replacement; PostgreSQL retains only the notice/identity, not files.
 */
export async function prepareWorkerWorkspace(harness: Harness, stateDir: string, reopenedRoom: boolean): Promise<void> {
  const filename = join(stateDir, "workspace-generation");
  let generation: string;
  try { generation = await readFile(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    generation = randomUUID();
    await writeFile(filename, generation, { flag: "wx", mode: 0o600 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generation)) throw new Error("Invalid disposable workspace generation marker.");
  await harness.commit(async tx => {
    const doc = await tx.doc(WorkerWorkspaceDoc);
    if (doc.generation === generation) return;
    doc.generation = generation;
    doc.recovered = reopenedRoom;
    doc.notice = [
      `Worker workspace generation: ${generation}.`,
      reopenedRoom ? "This conversation has resumed in a replacement workspace. Previous worker-local files, local commits, dependencies and unpushed work were NOT restored. Tell the user that the workspace is fresh when reporting recovery."
        : "This conversation uses a fresh, disposable worker workspace. Its files are not durably snapshotted.",
      "PostgreSQL retains conversation and tool history, not a complete filesystem journal. A committed tool result does not mean its old output file still exists. Do not blindly repeat completed tools or paid/external effects.",
      "Inspect the remote Git branch and durable tool history, recover pushed source, reconstruct missing unpushed work when appropriate, verify the result, then continue. Published artifacts remain in S3. Report what cannot be recovered.",
      "Idle workers may shut down automatically between turns. Commit and push useful progress frequently and publish required artifacts before finishing a turn. A local commit alone will not survive worker replacement. Do not claim filesystem restoration or exactly-once external execution.",
    ].join("\n\n");
  }, BACKGROUND_CONTEXT);
}
