import { z } from "zod";

const id = z.string().trim().min(1);
const nativeId = z.number().int().positive().safe();
const at = z.number().finite().nonnegative();
const source = z.object({ agent: id, namespace: id });

/** References resolve only in sources the operator has already made available.
 * No filesystem paths, URLs, queries or executable adapters come from documents. */
export const workflowEvidenceSchema = z
  .object({
    conversationId: nativeId,
    source: source.optional(),
    entryId: nativeId.optional(),
    taskId: nativeId.optional(),
    documentId: nativeId.optional(),
    label: id.optional(),
  })
  .refine(
    (ref) =>
      [ref.entryId, ref.taskId, ref.documentId].filter(
        (value) => value !== undefined,
      ).length <= 1,
    "Choose one native entry, task or document per evidence reference.",
  );
export type WorkflowEvidence = z.infer<typeof workflowEvidenceSchema>;

/** A presentation contract retained by a producer in a Pi document. It does not
 * schedule work or claim that these concepts exist in every Pi integration. */
export const workflowDocumentSchema = z.object({
  version: z.literal(1),
  id,
  title: id,
  cycle: id.optional(),
  status: id.optional(),
  nodes: z.array(
    z.object({
      id,
      title: id,
      type: z.enum(["group", "activity"]),
      kind: id.optional(),
      parent: id.optional(),
      order: z.number().finite().optional(),
      at: at.optional(),
      status: id.optional(),
      summary: z.string().optional(),
      attributes: z.record(id, z.string()).optional(),
      evidence: z.array(workflowEvidenceSchema).default([]),
      workflow: z
        .object({ documentId: nativeId, source: source.optional() })
        .optional(),
    }),
  ),
  edges: z
    .array(z.object({ from: id, to: id, kind: id, label: id.optional() }))
    .default([]),
});
export type WorkflowDocument = z.infer<typeof workflowDocumentSchema>;
