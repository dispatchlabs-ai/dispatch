import type { Tx } from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import type { ProjectInstructionsDocument, SaveProjectInstructionsInput, RuntimeScope } from "../src/shared/contracts.js";
import { ProjectsDoc, requireProjectAccess } from "./project-access.js";
import { ProjectSpecError } from "./project-spec.js";

export async function readProjectInstructions(tx: Tx, scope: RuntimeScope, id: string, readAll = false): Promise<ProjectInstructionsDocument> {
  const project = await requireProjectAccess(tx, scope, id, "read", readAll);
  return { projectId: id, revision: project.instructionsRevision ?? 0, content: project.instructions ?? "" };
}

/** A receipt retains the original result, including no-op saves, rather than replaying mutable head state. */
export async function saveProjectInstructions(tx: Tx, scope: RuntimeScope, id: string, input: SaveProjectInstructionsInput): Promise<ProjectInstructionsDocument> {
  const project = await requireProjectAccess(tx, scope, id, "manage");
  if (!input.requestId.trim() || input.requestId.length > 200 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || input.content.length > 50_000 || input.content.includes("\0") || Buffer.from(input.content, "utf8").toString("utf8") !== input.content) {
    throw new ProjectSpecError(400, "Invalid instructions save request. Use valid text of at most 50,000 characters.");
  }
  const doc = await tx.doc(ProjectsDoc);
  const key = JSON.stringify([scope.companyId, scope.userId, id, input.requestId]);
  const fingerprint = JSON.stringify([input.expectedRevision, createHash("sha256").update(input.content).digest("hex")]);
  const prior = doc.instructionsRequests?.[key];
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new ProjectSpecError(409, "Request ID was already used for a different instructions change.");
    return { ...prior.result };
  }
  const head = project.instructionsRevision ?? 0;
  if (head !== input.expectedRevision) throw new ProjectSpecError(409, "Instructions changed. Draft retained; load the latest revision and review.");
  if ((project.instructions ?? "") !== input.content) {
    project.instructions = input.content;
    project.instructionsRevision = head + 1;
    project.updatedAt = Date.now();
  }
  const result = { projectId: id, revision: project.instructionsRevision ?? 0, content: project.instructions ?? "" };
  doc.instructionsRequests ??= {};
  doc.instructionsRequests[key] = { fingerprint, result };
  return { ...result };
}
