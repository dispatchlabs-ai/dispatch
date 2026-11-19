import { Type } from "typebox";
import { AssistantEntry, SystemEntry, UserEntry, defineDoc, defineExtension, defineTool, GenerationTask, hook, InboxDoc, LiveDoc,
  type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type TaskRuntime } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { publicAnswer } from "./commentary.js";

type Request = {
  /** Stable native input identity for this request, retained through follow-ups. */
  id?: string;
  inputs: string;
  request: string;
  status: "active" | "complete" | "needs_input" | "cancelled";
  remaining: string[];
  evidence: string;
  needsInput: string;
};

export type RequestState = Request & { waiting?: Record<string, Request> };

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

const instruction = `Track the current user request with request_status. Keep working while authorized steps remain. Record the outcome and evidence before your final answer. Use needs_input when only a specific external dependency remains. A related follow-up can continue a blocked request. For a separate request in a later turn, record the new request and leave the blocked one waiting. Resume a waiting request by ID when the user returns to it. Use cancelled only when the user stops or replaces the request. If you already wrote the answer and only need to record its status, make that tool call without repeating the answer.`;
const continuation = "Review the latest user input and record its request status.";

function statusRound(entry: EntryRecord) {
  const message = entry.model?.[0];
  return message?.role === "assistant" && message.content.length > 0
    && message.content.every(block => block.type === "toolCall" && block.name === "request_status");
}

function continuedReply(followUp: EntryRecord | undefined, answer: EntryRecord | undefined) {
  if (!followUp || !answer || !UserEntry.is(followUp) || !AssistantEntry.is(answer) || followUp.byTaskId === undefined
    || followUp.byTaskId !== answer.byTaskId) return "";
  const input = followUp.model?.[0];
  const message = answer.model?.[0];
  const prompt = input?.role === "user" && (typeof input.content === "string" ? input.content : input.content[0]?.type === "text" && input.content[0].text);
  if (!prompt || message?.role !== "assistant" || message.stopReason !== "stop"
    || message.content.some(block => block.type === "toolCall")) return "";
  const isContinuation = prompt.startsWith(continuation) ||
    (prompt.startsWith("Track the user's original request with request_status.") && prompt.includes("\nThe answer above has already been delivered."));
  if (!isContinuation) return "";
  return publicAnswer(message).trim();
}

/** Resolve a settled input's text, including a reply followed by Dispatch's status-only continuation. */
export async function requestReply(runtime: Pick<TaskRuntime<unknown, unknown, unknown, object>, "entry" | "entries">,
  receipt: { answer: EntryId; entry?: EntryId }, ctx: Context): Promise<string> {
  const entry = await runtime.entry(AssistantEntry, receipt.answer, ctx);
  const message = entry?.model?.[0];
  if (!entry || message?.role !== "assistant" || ["aborted", "error"].includes(message.stopReason)) return "";
  const text = publicAnswer(message).trim();
  if (text || receipt.entry === undefined || !statusRound(entry)) return text;
  let cursor: Cursor | undefined;
  const preceding: EntryRecord[] = [];
  do {
    const page = await runtime.entries({ minEntryId: receipt.entry, maxEntryId: receipt.answer, order: "descending" }, 100, cursor, ctx);
    for (const candidate of page.items) {
      if (candidate.id < receipt.answer && !SystemEntry.is(candidate)) preceding.push(candidate);
      if (preceding.length === 2) return continuedReply(preceding[0], preceding[1]);
    }
    cursor = page.next;
  } while (cursor);
  return "";
}

/** A completion record and Pi's native continuation hook, without a second run loop. */
export const RequestCompletion = defineExtension({
  name: "dispatch.request-completion",
  sections: [{
    key: "request-completion",
    async render({ conversationId, read }, ctx) {
      const state = await read.snapshot(RequestWork, conversationId, ctx);
      if (!state?.request) return instruction;
      const { waiting, ...current } = state;
      const pending = Object.values(waiting ?? {}).map(({ id, request }) => ({ id, request }));
      return `${instruction}\n\nSaved request state:\n${JSON.stringify({ ...current, waiting: pending })}`;
    },
  }],
  tools: [defineTool({
    name: "request_status",
    description: "Read or update the current request and its evidence. A separate request in a later turn leaves a blocked request waiting. Quote the new request faithfully. To resume waiting work, pass its ID as resume with the new status.",
    parameters: Type.Object({
      resume: Type.Optional(Type.String({ minLength: 1 })),
      update: Type.Optional(Type.Object({
        request: Type.Optional(Type.String({ minLength: 1 })),
        status: Type.Union([Type.Literal("active"), Type.Literal("complete"), Type.Literal("needs_input"), Type.Literal("cancelled")]),
        remaining: Type.Array(Type.String({ minLength: 1 })),
        evidence: Type.String({ minLength: 1 }),
        needsInput: Type.Optional(Type.String({ minLength: 1 })),
      })),
    }),
    replay: "safe",
    async execute({ update, resume }, api, ctx) {
      if (resume && (!update || update.request)) throw new Error("Supply a status update without a new request when resuming waiting work.");
      const result = await api.commit(async tx => {
        const live = await tx.doc(LiveDoc, api.conversationId);
        const state = await tx.doc(RequestWork, api.conversationId);
        if (update && !(update.status === "cancelled" && cancelledInput(state, live.run?.inputs ?? []))) {
          const inputIds = live.run?.inputs ?? [];
          const inputs = inputIds.join(",");
          const previousInputs = state.inputs.split(",");
          const fresh = inputIds.length > 0 && !inputIds.some(id => previousInputs.includes(String(id)));
          const waiting = state.waiting;
          const resumed = resume && waiting && Object.hasOwn(waiting, resume) ? waiting[resume] : undefined;
          if (resume && (!resumed || !fresh || state.status === "active")) {
            throw new Error("Resume a known waiting request in a new turn.");
          }
          const newRequest = update.request !== undefined && update.request !== state.request;
          const park = fresh && state.status === "needs_input" && (resumed !== undefined || newRequest);
          if (cancelledInput(state, inputIds) && update.status !== "cancelled")
            throw new Error("This input was cancelled. A new explicit request is required before resuming work.");
          if (!state.request && !update.request?.trim() && !resumed) throw new Error("Record the current user request first.");
          if (state.request && state.inputs !== inputs && (state.status === "complete" || state.status === "cancelled")
            && !update.request?.trim() && !resumed) throw new Error("Record the new user request; the previous request has ended.");
          if (update.request && state.request && update.request !== state.request
            && !park && state.status !== "cancelled" && (state.status !== "complete" || state.inputs === inputs)) {
            throw new Error("The current request is unfinished. Continue it or record the user's cancellation before replacing it.");
          }
          if (update.status === "complete" && update.remaining.length) throw new Error("A request with remaining work is not complete.");
          if (update.status === "needs_input" && (!update.remaining.length || !update.needsInput?.trim())) {
            throw new Error("Retain the unfinished work and specify the external input needed.");
          }
          if (park) {
            const { waiting: _, ...request } = state;
            const id = request.id ?? request.inputs;
            state.waiting = { ...waiting, [id]: { ...request, id } };
          }
          if (resumed) {
            Object.assign(state, resumed);
            delete state.waiting![resume!];
          }
          Object.assign(state, {
            id: park && !resumed || !state.id || (update.request && (state.status === "cancelled" ||
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
          answered = !!current && statusRound(current) && !!continuedReply(preceding[0], preceding[1]);
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
      return { continue: `${continuation}\nCheck whether the saved request belongs to the latest user input. If the reply above answers that input, record its status without repeating it. If useful work remains, keep it active and continue the authorized work.` };
    },
  })],
});
