import { Type } from "typebox";
import { AssistantEntry, SystemEntry, UserEntry, defineDoc, defineExtension, defineTool, GenerationTask, hook, InboxDoc, LiveDoc,
  type ConversationId, type Cursor, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

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

/** Record explicit cancellation of a conversation and its owned children, without mounting absent records. */
export async function recordRequestCancellation(harness: Pick<Harness, "snapshot" | "commit">,
  conversationId: ConversationId, context: Context) {
  const conversations = await harness.commit(async tx => {
    const ids = [conversationId];
    for (const id of ids) {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({ ownerConversationId: id }, 100, cursor);
        ids.push(...page.items.map(child => child.id));
        cursor = page.next;
      } while (cursor);
    }
    return ids;
  }, context);
  const mounted = await Promise.all(conversations.map(async id =>
    await harness.snapshot(RequestWork, id, context) ? id : undefined));
  await harness.commit(async tx => {
    for (const id of mounted) {
      if (id === undefined) continue;
      const state = await tx.doc(RequestWork, id);
      if (!state.request || !["active", "needs_input"].includes(state.status)) continue;
      const live = await tx.doc(LiveDoc, id);
      const inbox = await tx.doc(InboxDoc, id);
      // Include queued steering: a boundary can place it before native abort takes effect.
      state.inputs = [...new Set([...state.inputs.split(",").filter(Boolean),
        ...(live.run?.inputs ?? []).map(String), ...inbox.items.filter(item => item.mode !== "write").map(item => String(item.id))])].join(",");
      state.status = "cancelled";
      state.needsInput = "";
      state.evidence = `${state.evidence}${state.evidence ? "\n" : ""}Explicitly cancelled by the host. Remaining work was not completed.`;
    }
  }, context);
}

const cancelledInput = (state: RequestState, inputs: readonly number[]) =>
  state.status === "cancelled" && inputs.every(input => state.inputs.split(",").includes(String(input)));

const instruction = `Track the user's original request with request_status. Keep it active until its requested outcomes are verified. A diagnosis, progress report, saved notes, or returned worker is not completion. Continue useful authorized work when other parts are blocked. Before your final answer, record the remaining work and evidence. Use needs_input only after establishing that every remaining path requires unavailable external input or access; state exactly what is needed and the evidence for that conclusion. Use cancelled only when the user stops or replaces the request. Follow-up questions and status requests do not cancel unfinished work. A factual question can be complete once answered with appropriate evidence. If you already delivered the answer and only need to record request_status, make that tool call without another user-facing message. Do not announce bookkeeping or repeat the answer.`;

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
      const result = await api.commit(async tx => {
        const live = await tx.doc(LiveDoc, api.conversationId);
        const state = await tx.doc(RequestWork, api.conversationId);
        if (update && !(update.status === "cancelled" && cancelledInput(state, live.run?.inputs ?? []))) {
          const inputIds = live.run?.inputs ?? [];
          const inputs = inputIds.join(",");
          if (cancelledInput(state, inputIds) && update.status !== "cancelled")
            throw new Error("This input was cancelled. A new explicit request is required before resuming work.");
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
        let answered = false;
        // Only the immediate answer -> native continuation -> status-only round
        // can terminate. An older progress answer cannot suppress findings after work.
        if (update && state.inputs === (live.run?.inputs ?? []).join(",") && state.status !== "active" && live.run?.first !== undefined) {
          const placed = await Promise.all((live.run.inputs ?? []).map(id => tx.submission(id)));
          const latestInput = placed.reduce((latest, input) => input?.entry !== undefined && input.entry > latest ? input.entry : latest, live.run.first);
          let cursor: Cursor | undefined;
          const preceding: EntryRecord[] = [];
          let current: EntryRecord | undefined;
          do {
            const page = await tx.scanEntries({ conversationId: api.conversationId, minEntryId: latestInput }, 100, cursor);
            for (const entry of page.items) {
              if (!current) {
                if (entry.model?.some(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === api.callId)))
                  current = entry;
              } else if (!SystemEntry.is(entry)) preceding.push(entry);
              if (preceding.length === 2) break;
            }
            cursor = page.next;
          } while (preceding.length < 2 && cursor);
          const round = current?.model?.find(message => message.role === "assistant");
          const answer = preceding[1]?.model?.find(message => message.role === "assistant");
          answered = !!round && round.content.every(block => block.type === "toolCall" && block.name === "request_status")
            && UserEntry.is(preceding[0]) && AssistantEntry.is(preceding[1])
            && answer?.stopReason === "stop" && answer.content.some(block => block.type === "text" && block.text.trim())
            && !answer.content.some(block => block.type === "toolCall");
        }
        return { state: JSON.parse(JSON.stringify(state)) as RequestState, answered };
      }, ctx);
      return { output: [{ type: "text", text: JSON.stringify(result.state) }], details: result.state,
        ...(result.answered ? { control: { terminate: true } } : {}) };
    },
  })],
  hooks: [hook(GenerationTask, {
    async onYield(_answer, api, ctx) {
      const state = await api.snapshot(RequestWork, api.conversationId, ctx);
      const inputs = (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run?.inputs ?? [];
      if (state?.request && (cancelledInput(state, inputs) || state.inputs === inputs.join(",") && state.status !== "active")) return;
      return { continue: `${instruction}\n\n${state?.request
        ? `The original request remains: ${state.request}\nRemaining work: ${JSON.stringify(state.remaining)}\nLast evidence: ${state.evidence}`
        : "Record the original user request now."}\nThe answer above has already been delivered. Check its requested outcomes and record request_status. If nothing remains, make only that status tool call, with no repeated answer or bookkeeping announcement. If work remains, keep it active and continue the authorized work.` };
    },
  })],
});
