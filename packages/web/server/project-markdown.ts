import { createHash } from "node:crypto";
import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import type { RuntimeScope, ProjectSpecImport, ProjectMarkdownDocument, SaveProjectMarkdownInput, ProjectSpecPage, ProjectSpecReadInput, ProjectSpecRevisionPage } from "../src/shared/contracts.js";
import { ProjectsDoc, requireProjectAccess, type SharedProjectRecord } from "./project-access.js";
import { ProjectSpecError, SPEC_MAX_BYTES } from "./project-spec.js";

export type SpecImportProvenance = ProjectSpecImport;
export type ProjectMarkdownRevision = ProjectMarkdownDocument & { savedAt: number; savedBy: string };
export type { ProjectMarkdownDocument, SaveProjectMarkdownInput };

/** Detach nested provenance before the native commit's document proxies are revoked. */
function revisionCopy(revision: ProjectMarkdownRevision): ProjectMarkdownRevision {
  return { ...revision, ...(revision.importedFrom ? { importedFrom: { ...revision.importedFrom } } : {}) };
}

/** Immutable revisions and actor-scoped receipts; access lives in ProjectsDoc, not historical content. */
export const ProjectMarkdownDoc = defineDoc<{
  revisions: Record<string, ProjectMarkdownRevision[]>;
  requests: Record<string, { fingerprint: string; projectId: string; revision: number }>;
}>({
  kind: "dispatch.project-markdown", version: 1, scope: "session",
  initial: () => ({ revisions: {}, requests: {} }),
});

export function markdownHash(content: string) { return createHash("sha256").update(content).digest("hex"); }
export function validateMarkdown(content: string) {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > SPEC_MAX_BYTES) throw new ProjectSpecError(413, "Spec exceeds the 512 KiB limit.");
  if (content.includes("\0") || bytes.toString("utf8") !== content) throw new ProjectSpecError(400, "Spec must be valid UTF-8 text without NUL characters.");
}

export async function readProjectMarkdown(tx: Tx, scope: RuntimeScope, id: string, revision?: number, readAll = false): Promise<ProjectMarkdownDocument> {
  const project = await requireProjectAccess(tx, scope, id, "read", readAll);
  const revisions = (await tx.doc(ProjectMarkdownDoc)).revisions[id] ?? [];
  const saved = revision === undefined ? revisions.at(-1) : revisions.find(item => item.revision === revision);
  if (revision !== undefined && !saved) throw new ProjectSpecError(404, "Spec revision not found.");
  if (saved) return revisionCopy(saved);
  return { projectId: id, revision: 0, content: "", contentHash: markdownHash(""), legacyImportRequired: Boolean(project.spec) };
}

/** Descending metadata only; the immutable revision number is the paging cursor. */
export async function listProjectMarkdownRevisions(tx: Tx, scope: RuntimeScope, id: string, before?: number, readAll = false): Promise<ProjectSpecRevisionPage> {
  await requireProjectAccess(tx, scope, id, "read", readAll);
  const revisions = (await tx.doc(ProjectMarkdownDoc)).revisions[id] ?? [];
  const end = before === undefined ? revisions.length : revisions.findIndex(item => item.revision >= before);
  const limit = end < 0 ? revisions.length : end;
  const start = Math.max(0, limit - 50);
  return {
    revisions: revisions.slice(start, limit).reverse().map(item => {
      const { content, legacyImportRequired, ...metadata } = revisionCopy(item);
      return metadata;
    }),
    nextBefore: start > 0 ? revisions[start].revision : null,
  };
}

function requestKey(scope: RuntimeScope, id: string, requestId: string) { return JSON.stringify([scope.companyId, scope.userId, id, requestId]); }
export function markdownFingerprint(operation: "save" | "import", input: SaveProjectMarkdownInput, importedFrom?: SpecImportProvenance, projectRevision?: number) {
  return JSON.stringify([operation, input.expectedRevision, markdownHash(input.content), importedFrom ?? null, projectRevision ?? null]);
}

/** Check permission before every receipt replay. Return the recorded revision, never a newer head. */
export async function replayProjectMarkdown(tx: Tx, scope: RuntimeScope, id: string, requestId: string, fingerprint: string): Promise<ProjectMarkdownRevision | undefined> {
  await requireProjectAccess(tx, scope, id, "manage");
  return replayRevision(tx, id, requestKey(scope, id, requestId), fingerprint);
}

async function replayRevision(tx: Tx, id: string, key: string, fingerprint: string) {
  const doc = await tx.doc(ProjectMarkdownDoc);
  const prior = doc.requests[key];
  if (!prior) return;
  if (prior.fingerprint !== fingerprint) throw new ProjectSpecError(409, "Request ID was already used for a different spec change.");
  const revision = doc.revisions[id]?.find(item => item.revision === prior.revision);
  if (!revision) throw new ProjectSpecError(409, "Saved spec receipt has no revision. Reload and review.");
  return revisionCopy(revision);
}

/** All access, conflict, append and receipt mutations belong to the caller's one native commit. */
export async function saveProjectMarkdown(tx: Tx, scope: RuntimeScope, id: string, input: SaveProjectMarkdownInput, migration?: { provenance: SpecImportProvenance; expectedProjectRevision: number; fingerprint: string }): Promise<ProjectMarkdownRevision> {
  const project = await requireProjectAccess(tx, scope, id, "manage");
  return writeProjectMarkdown(tx, project, scope.userId, requestKey(scope, id, input.requestId), input, migration);
}

/** The runtime resolves the project and authorizes active agent membership before calling. */
export async function saveAgentProjectMarkdown(tx: Tx, companyId: string, id: string, participantId: string, input: SaveProjectMarkdownInput) {
  const project = (await tx.doc(ProjectsDoc)).projects[id];
  if (!project || project.companyId !== companyId) throw new ProjectSpecError(404, "Project not found.");
  return writeProjectMarkdown(tx, project, `agent:${participantId}`, JSON.stringify([companyId, "agent", participantId, id, input.requestId]), input);
}

async function writeProjectMarkdown(tx: Tx, project: SharedProjectRecord, savedBy: string, key: string, input: SaveProjectMarkdownInput,
  migration?: { provenance: SpecImportProvenance; expectedProjectRevision: number; fingerprint: string }): Promise<ProjectMarkdownRevision> {
  const id = project.id;
  validateMarkdown(input.content);
  if (!input.requestId || input.requestId.length > 200 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new ProjectSpecError(400, "Invalid spec save request.");
  const fingerprint = migration?.fingerprint ?? markdownFingerprint("save", input);
  const replay = await replayRevision(tx, id, key, fingerprint);
  if (replay) return replay;
  const doc = await tx.doc(ProjectMarkdownDoc);
  const revisions = doc.revisions[id] ?? [];
  const head = revisions.at(-1)?.revision ?? 0;
  if (head !== input.expectedRevision) throw new ProjectSpecError(409, "Spec changed. Draft retained; reload and review before saving.");
  if (migration) {
    if (head !== 0 || project.revision !== migration.expectedProjectRevision || !project.spec) throw new ProjectSpecError(409, "Project or spec changed before import. Reload and review.");
    if (migration.provenance.contentHash !== markdownHash(input.content)) throw new ProjectSpecError(409, "Imported spec content does not match its provenance.");
  } else if (head === 0 && project.spec) {
    throw new ProjectSpecError(409, "Import the existing spec before editing project Markdown.");
  }
  const saved: ProjectMarkdownRevision = {
    projectId: id, revision: head + 1, content: input.content, contentHash: markdownHash(input.content),
    savedAt: Date.now(), savedBy, ...(migration ? { importedFrom: migration.provenance } : {}),
  };
  doc.revisions[id] = [...revisions, saved];
  project.specRevision = saved.revision;
  doc.requests[key] = { fingerprint, projectId: id, revision: saved.revision };
  if (migration) { delete project.spec; project.revision += 1; project.updatedAt = saved.savedAt; }
  return revisionCopy(saved);
}

/** Caller authorizes current room/agent membership; project identity is resolved from that room, never arguments. */
export async function projectMarkdownPage(tx: Tx, companyId: string, id: string | undefined, input: ProjectSpecReadInput): Promise<ProjectSpecPage> {
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 1))) throw new ProjectSpecError(400, "Invalid spec revision or offset.");
  if (offset > 0 && input.revision === undefined) throw new ProjectSpecError(400, "Pass the returned revision when reading the next page.");
  if (!id) return { projectId: null, revision: 0, content: "", offset: 0, textLength: 0, nextOffset: null, initialized: false };
  const project = (await tx.doc(ProjectsDoc)).projects[id];
  if (!project || project.companyId !== companyId) throw new ProjectSpecError(404, "Project not found.");
  const revisions = (await tx.doc(ProjectMarkdownDoc)).revisions[id] ?? [];
  const saved = input.revision === undefined ? revisions.at(-1) : revisions.find(item => item.revision === input.revision);
  if (input.revision !== undefined && !saved) throw new ProjectSpecError(404, "Spec revision not found.");
  if (!saved) return { projectId: id, revision: 0, content: "", offset: 0, textLength: 0, nextOffset: null, initialized: false, legacyImportRequired: Boolean(project.spec) };
  const end = Math.min(offset + 12_000, saved.content.length);
  return { projectId: id, revision: saved.revision, content: saved.content.slice(offset, end), contentHash: saved.contentHash, offset, textLength: saved.content.length, nextOffset: end < saved.content.length ? end : null, initialized: true };
}
