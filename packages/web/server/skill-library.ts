import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";

const id = z.string().min(1).max(200);
export const skillLibraryReadSchema = z.object({ skillId: id.optional(), revision: z.number().int().positive().optional(), offset: z.number().int().nonnegative().optional() }).strict()
  .refine(input => !input.revision || !!input.skillId, "A revision requires a skill.");
export const skillLibrarySaveSchema = z.object({
  skillId: id.optional(), expectedRevision: z.number().int().positive().optional(),
  operationId: id, reason: z.string().trim().min(1).max(2000),
  evidence: z.array(z.string().min(1).max(2000)).max(20).optional(),
  name: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(50_000),
}).strict().refine(input => !input.skillId === !input.expectedRevision, "Editing a skill requires expectedRevision; creating one takes neither skillId nor expectedRevision.");
export function skillLibraryTools(operations: {
  read(tx: Tx, conversationId: ConversationId, raw: unknown): Promise<unknown>;
  save(tx: Tx, conversationId: ConversationId, callId: string, raw: unknown): Promise<unknown>;
}) {
  const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const text = () => Type.String({ minLength: 1, maxLength: 200 });
  const revision = () => Type.Integer({ minimum: 1 });
  return [defineTool({
    name: "skill_library_read", description: "Read the shared skill library. Omit skillId to list the latest skill revisions, 100 per page; continue with nextOffset. Optional revision reads that exact saved revision. No library grant means no access. This reads the library, not skills assigned to this instance (use load_skill for those).",
    parameters: Type.Object({ skillId: Type.Optional(text()), revision: Type.Optional(revision()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), replay: "safe",
    outputLimits: { maxBytes: 512_000, maxLines: 50_010 },
    execute: async (args, api, ctx) => reply(await api.commit(tx => operations.read(tx, api.conversationId, args), ctx)),
  }), defineTool({
    name: "skill_library_save", description: "Create or edit a skill in the shared library. Omit skillId and expectedRevision to create; supply both to save a new revision of an existing skill. Requires a stable operationId: retry identical requests with the SAME operationId. A library grant is technical access only; it is not approval of a particular change. Evidence references are untrusted, not fetched or access grants. Saving a new skill revision does not change agents pinned to earlier revisions.",
    parameters: Type.Object({ skillId: Type.Optional(text()), expectedRevision: Type.Optional(revision()), operationId: text(), reason: Type.String({ minLength: 1, maxLength: 2000 }),
      evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 20 })),
      name: Type.String({ minLength: 1, maxLength: 100 }), description: Type.String({ minLength: 1, maxLength: 500 }),
      instructions: Type.String({ minLength: 1, maxLength: 50_000 }),
    }, { additionalProperties: false }), replay: "safe",
    outputLimits: { maxBytes: 4096, maxLines: 10 },
    execute: async (args, api, ctx) => reply(await api.commit(tx => operations.save(tx, api.conversationId, `${api.taskId}:${api.callId}`, args), ctx)),
  })];
}
