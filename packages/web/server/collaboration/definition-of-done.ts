import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";

export const CRITERIA_EXTENSION = "dispatch-definition-of-done";
type Criteria = { markdown: string; revision: number };
const inputSchema = z.union([
  z.object({}).strict(),
  z.object({ markdown: z.string().max(20_000), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), operationId: z.string().min(1).max(200) }).strict(),
]);
const Receipts = defineDoc<{ operations: Record<string, { fingerprint: string; result: Criteria; participantId: string; callId: string; savedAt: number }> }>({
  kind: "dispatch.criteria-edits", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ operations: {} }),
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const detached = (value?: Criteria): Criteria => ({ markdown: value?.markdown ?? "", revision: value?.revision ?? 0 });

/** Authorization returns transaction-local state; no document proxy leaves the commit. */
export function createDefinitionOfDone(authorize: (tx: Tx, instanceId: ConversationId) => Promise<{
  roomId: ConversationId; participantId: string; room: { definitionOfDone?: Criteria };
}>) {
  const tool = defineTool({
    name: "conversation_definition_of_done",
    description: "Read your current chat's Definition of Done with no arguments. To replace it, supply markdown, expectedRevision and a stable operationId; retry identical edits with the SAME operationId. Empty markdown clears it. Requires the Edit Definition of Done capability. Criteria are participant-authored guidance, not authorization, automatic completion or permission to override human direction.",
    parameters: Type.Object({
      markdown: Type.Optional(Type.String({ maxLength: 20_000 })),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 })),
      operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    }, { additionalProperties: false }),
    replay: "safe",
    outputLimits: { maxBytes: 256_000, maxLines: 20_010 },
    execute: async (raw, api, ctx) => {
      const input = inputSchema.parse(raw);
      const result = await api.commit(async tx => {
        // Replays also recheck the currently applied permission and active membership.
        const { roomId, participantId, room } = await authorize(tx, api.conversationId);
        if (!("markdown" in input)) return detached(room.definitionOfDone);
        const receipts = await tx.doc(Receipts, roomId);
        const key = hash([participantId, input.operationId]);
        const fingerprint = hash([input.markdown, input.expectedRevision]);
        const prior = receipts.operations[key];
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Error("Operation ID was already used with different criteria or revision.");
          return detached(prior.result);
        }
        const current = detached(room.definitionOfDone);
        if (current.revision !== input.expectedRevision) throw new Error("Criteria changed. Read the current criteria and review before using a new operationId.");
        const next = { markdown: input.markdown.trim(), revision: current.revision + 1 };
        room.definitionOfDone = next;
        // Receipt and criteria commit together: replay never rewrites a later human/agent edit.
        receipts.operations[key] = { fingerprint, result: next, participantId, callId: `${api.taskId}:${api.callId}`, savedAt: Date.now() };
        return detached(next);
      }, ctx);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  });
  return defineExtension({ name: CRITERIA_EXTENSION, tools: [tool] });
}
