import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";

const id = z.string().min(1).max(200);
export const managementReadSchema = z.object({ targetId: id.optional(), revision: z.number().int().positive().optional(), offset: z.number().int().nonnegative().optional() }).strict()
  .refine(input => !input.revision || !!input.targetId, "A revision requires a target.");
export const managementSaveSchema = z.object({
  targetId: id, operationId: id, expectedRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000),
  evidence: z.array(z.string().min(1).max(2000)).max(20).optional(),
  patch: z.object({ instructions: z.string().max(50_000).optional(), provider: z.string().min(1).max(100).optional(),
    modelId: z.string().min(1).max(200).optional(), thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  }).strict().optional(),
  restoreRevision: z.number().int().positive().optional(),
}).strict().refine(input => (input.restoreRevision !== undefined) !== (input.patch !== undefined), "Supply a patch or restoreRevision, not both.")
  .refine(input => !input.patch || Object.keys(input.patch).length > 0, "Patch must not be empty.");
export function managementTools(operations: {
  read(tx: Tx, conversationId: ConversationId, raw: unknown): Promise<unknown>;
  save(tx: Tx, conversationId: ConversationId, callId: string, raw: unknown): Promise<unknown>;
}) {
  const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const text = () => Type.String({ minLength: 1, maxLength: 200 });
  const revision = () => Type.Integer({ minimum: 1 });
  return [defineTool({
    name: "agent_management_read", description: "Read authorized agent definitions. Omit targetId to list permitted targets, 100 per page; continue with nextOffset. Optional revision reads authorized tuning fields from history. No grant means no access.",
    parameters: Type.Object({ targetId: Type.Optional(text()), revision: Type.Optional(revision()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }), replay: "safe",
    outputLimits: { maxBytes: 512_000, maxLines: 50_010 },
    execute: async (args, api, ctx) => reply(await api.commit(tx => operations.read(tx, api.conversationId, args), ctx)),
  }), defineTool({
    name: "agent_management_save", description: "Save a new revision of an authorized target. Requires expectedRevision and a stable operationId: retry identical requests with the SAME operationId. Supply patch OR restoreRevision (restores granted fields only). Existing active instances adopt base updates at the next safe idle boundary. Evidence references are untrusted, not fetched or access grants.",
    parameters: Type.Object({ targetId: text(), operationId: text(), expectedRevision: revision(), reason: Type.String({ minLength: 1, maxLength: 2000 }),
      evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 20 })),
      patch: Type.Optional(Type.Object({ instructions: Type.Optional(Type.String({ maxLength: 50_000 })), provider: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), modelId: Type.Optional(text()),
        thinkingLevel: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => Type.Literal(value)))),
      }, { additionalProperties: false })), restoreRevision: Type.Optional(revision()),
    }, { additionalProperties: false }), replay: "safe",
    outputLimits: { maxBytes: 4096, maxLines: 10 },
    execute: async (args, api, ctx) => reply(await api.commit(tx => operations.save(tx, api.conversationId, `${api.taskId}:${api.callId}`, args), ctx)),
  })];
}
