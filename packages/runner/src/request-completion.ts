import { Type } from "typebox";
import { defineDoc, defineExtension, defineTool, GenerationTask, hook, LiveDoc } from "@earendil-works/pi-durable";

export type RequestState = {
  /** Stable native input identity for this request, retained through follow-ups. */
  id?: string;
  inputs: string;
  request: string;
  status: "active" | "complete" | "needs_input" | "cancelled";
  remaining: string[];
  evidence: string;
  needsInput: string;
};

export const RequestWork = defineDoc<RequestState>({
  kind: "dispatch.request-completion", version: 1, scope: "conversation", history: "latest", fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ inputs: "", request: "", status: "active", remaining: [], evidence: "", needsInput: "" }),
});

const instruction = `Track the user's original request with request_status. Keep it active until its requested outcomes are verified. A diagnosis, progress report, saved notes, or returned worker is not completion. Continue useful authorized work when other parts are blocked. Before your final answer, record the remaining work and evidence. Use needs_input only after establishing that every remaining path requires unavailable external input or access; state exactly what is needed and the evidence for that conclusion. Use cancelled only when the user stops or replaces the request. Follow-up questions and status requests do not cancel unfinished work. A factual question can be complete once answered with appropriate evidence.`;

/** A completion record and Pi's native continuation hook, without a second run loop. */
export const RequestCompletion = defineExtension({
  name: "dispatch.request-completion",
  sections: [{
    key: "request-completion",
    async render({ conversationId, read }, ctx) {
      const state = await read.snapshot(RequestWork, conversationId, ctx);
      return `${instruction}${state?.request ? `\n\nSaved request state:\n${JSON.stringify(state)}` : ""}`;
    },
  }],
  tools: [defineTool({
    name: "request_status",
    description: "Read or update the durable original request and its completion evidence. With no update, returns the current record. When creating a record, quote the user's request faithfully. Keep an unfinished original request through follow-ups; record cancellation before replacing it. Completion is your evidence-based assessment, not an automatic verifier.",
    parameters: Type.Object({
      update: Type.Optional(Type.Object({
        request: Type.Optional(Type.String({ minLength: 1 })),
        status: Type.Union([Type.Literal("active"), Type.Literal("complete"), Type.Literal("needs_input"), Type.Literal("cancelled")]),
        remaining: Type.Array(Type.String({ minLength: 1 })),
        evidence: Type.String({ minLength: 1 }),
        needsInput: Type.Optional(Type.String({ minLength: 1 })),
      })),
    }),
    replay: "safe",
    async execute({ update }, api, ctx) {
      const state = await api.commit(async tx => {
        const live = await tx.doc(LiveDoc, api.conversationId);
        const state = await tx.doc(RequestWork, api.conversationId);
        if (update) {
          const inputs = live.run?.inputs.join(",") ?? "";
          if (!state.request && !update.request?.trim()) throw new Error("Record the original user request first.");
          if (state.request && state.inputs !== inputs && (state.status === "complete" || state.status === "cancelled")
            && !update.request?.trim()) throw new Error("Record the new user request; the previous request has ended.");
          if (update.request && state.request && update.request !== state.request
            && state.status !== "cancelled" && (state.status !== "complete" || state.inputs === inputs)) {
            throw new Error("The original request is unfinished. Preserve it, or record the user's cancellation before replacing it.");
          }
          if (update.status === "complete" && update.remaining.length) throw new Error("A request with remaining work is not complete.");
          if (update.status === "needs_input" && (!update.remaining.length || !update.needsInput?.trim())) {
            throw new Error("Retain the unfinished work and specify the external input needed.");
          }
          Object.assign(state, {
            id: !state.id || (update.request && (state.status === "cancelled" ||
              (state.status === "complete" && state.inputs !== inputs))) ? inputs : state.id,
            ...update, request: update.request ?? state.request,
            inputs, needsInput: update.needsInput ?? "",
          });
        }
        return JSON.parse(JSON.stringify(state)) as RequestState;
      }, ctx);
      return { output: [{ type: "text", text: JSON.stringify(state) }], details: state };
    },
  })],
  hooks: [hook(GenerationTask, {
    async onYield(_answer, api, ctx) {
      const state = await api.snapshot(RequestWork, api.conversationId, ctx);
      const inputs = (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run?.inputs.join(",");
      if (state?.request && state.inputs === inputs && state.status !== "active") return;
      return { continue: `${instruction}\n\n${state?.request
        ? `The original request remains: ${state.request}\nRemaining work: ${JSON.stringify(state.remaining)}\nLast evidence: ${state.evidence}`
        : "Record the original user request now."}\nYour response reached the end, but the current request has no final completion assessment. Check the requested outcomes, continue any unfinished work, and update request_status before concluding.` };
    },
  })],
});
