import { copyJson, type Context } from "@earendil-works/chord";
import { defineDoc, defineTask, GenerationTask, LiveDoc, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { ConversationTurns, humansComposing, TurnsDoc } from "./turns.js";
import type { Attention } from "./waiting.js";

export type ContributionDraft = {
  text: string; images?: { mimeType: string; data: string }[]; attachmentIds?: string[];
  threadId: string | null; mentions: string[]; attention?: Attention; createdAt: number;
};
type Boundary = { kind: "final" | "tools"; from: TaskId; after: EntryId; marker?: string; assistant?: EntryId; results?: EntryId[] };
export type Contribution = {
  id: string; participantId: string; conversationId: ConversationId; owner: TaskId;
  /** SDK reviewers retain one native task across review rounds. */
  executionBackend?: "claude-agent-sdk" | "muse-code";
  reviewer: TaskId; inputs: SubmissionId[]; draft: ContributionDraft; through?: string;
  priority: boolean; phase: "prepared" | "review" | "closed"; boundary?: Boundary;
  messageId?: string; finalGenerations?: TaskId[]; needsReview?: boolean;
};
export const ContributionsDoc = defineDoc<{ items: Record<string, Contribution> }>({
  kind: "dispatch.contributions", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: {} }),
});
const completed = () => ({ status: "terminal", outcome: { status: "completed", result: null } }) as const;

/** Owns only conversational reservations. Pi still owns provider/tool execution and run transitions. */
export class Contributions {
  private harness!: Harness;
  readonly guard;
  constructor(private readonly turns: ConversationTurns) {
    this.guard = defineTask<{ roomId: ConversationId; id: string }, { phase: "guard" }, null>({
      name: "dispatch.contribution", version: 1, initial: () => ({ phase: "guard" }),
      phases: { guard: async (task, runtime, ctx) => {
        while (true) {
          let done = false;
          await runtime.commit(async tx => {
            const item = (await tx.doc(ContributionsDoc, task.input.roomId)).items[task.input.id];
            if (item) await this.reconcile(tx, task.input.roomId, item);
            done = !item || item.phase === "closed";
            if (done) return completed();
          }, ctx);
          if (done) return;
          await runtime.sleep(runtime.now() + 200, ctx);
        }
      } },
      abort: (task, runtime, ctx) => runtime.commit(async tx => {
        const item = (await tx.doc(ContributionsDoc, task.input.roomId)).items[task.input.id];
        if (item) await this.close(tx, task.input.roomId, item);
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx),
    });
  }
  bind(harness: Harness) { this.harness = harness; }

  async prepare(tx: Tx, roomId: ConversationId, input: Omit<Contribution, "owner" | "inputs" | "phase">) {
    const doc = await tx.doc(ContributionsDoc, roomId);
    if (doc.items[input.id]) return doc.items[input.id];
    const reviewer = await tx.task(input.reviewer);
    const run = input.executionBackend ? undefined : (await tx.doc(LiveDoc, input.conversationId)).run;
    if (input.executionBackend) {
      if (!reviewer || reviewer.kind !== (input.executionBackend === "muse-code" ? "dispatch.muse-run" : "dispatch.claude-sdk-run") || reviewer.conversationId !== input.conversationId || reviewer.abortRequested || reviewer.state.status === "terminal") throw new Error("The contribution's SDK task is no longer active.");
    } else if (!run || run.taskId !== input.reviewer) throw new Error("The contribution's native run is no longer active.");
    const owner = await tx.createTask(this.guard, { roomId, id: input.id }, { conversationId: roomId, ownership: { kind: "conversation" }, background: true });
    doc.items[input.id] = { ...input, owner, inputs: [...(run?.inputs ?? [])], phase: "prepared" };
    return doc.items[input.id];
  }

  async forReviewer(tx: Tx, roomId: ConversationId, conversationId: ConversationId, reviewer: TaskId) {
    const items = Object.values((await tx.doc(ContributionsDoc, roomId)).items).filter(item => item.conversationId === conversationId && item.phase !== "closed");
    for (const item of items) await this.reconcile(tx, roomId, item);
    return items.filter(item => item.phase !== "closed" && item.reviewer === reviewer);
  }

  async release(tx: Tx, roomId: ConversationId, item: Contribution) {
    await this.turns.release(tx, roomId, item.participantId, item.owner);
    item.phase = "prepared";
    delete item.boundary;
  }

  async close(tx: Tx, roomId: ConversationId, item: Contribution, messageId?: string) {
    await this.turns.release(tx, roomId, item.participantId, item.owner);
    item.phase = "closed";
    delete item.boundary;
    if (messageId) item.messageId = messageId;
  }

  async closeAll(tx: Tx, roomId: ConversationId, participantId?: string) {
    const items = Object.values((await tx.doc(ContributionsDoc, roomId)).items).filter(item => !participantId || item.participantId === participantId);
    // Removal retries also join owners closed by the first admission but not yet settled.
    const owners = items.filter(item => participantId || item.phase !== "closed").map(item => item.owner);
    for (const item of items) if (item.phase !== "closed") await this.close(tx, roomId, item);
    return owners;
  }

  /** The hook joins only a short native gate, never the background lifetime task. */
  async admit(roomId: ConversationId, id: string, ctx: Context) {
    const item = (await this.harness.snapshot(ContributionsDoc, roomId, ctx))?.items[id];
    if (!item || item.phase === "closed") return;
    await this.turns.acquire(roomId, item.participantId, item.owner, item.owner, roomId, ctx, item.priority, async tx => {
      if ((await tx.doc(ContributionsDoc, roomId)).items[id]?.phase === "closed") throw new Error("The contribution has been closed.");
    });
  }

  async owns(tx: Tx, roomId: ConversationId, item: Contribution) {
    await this.reconcile(tx, roomId, item);
    const turns = await tx.doc(TurnsDoc, roomId);
    const owner = await tx.task(item.owner);
    return item.phase !== "closed" && owner && !owner.abortRequested && owner.state.status !== "terminal" && turns.speaker?.requester === item.owner && !humansComposing(turns);
  }

  async handoff(tx: Tx, item: Contribution, kind: Boundary["kind"], assistant?: EntryId, results?: readonly EntryId[]) {
    const tail = (await tx.scanEntries({ conversationId: item.conversationId }, 1)).items[0];
    if (!tail) throw new Error("Missing native contribution boundary.");
    const marker = kind === "final" ? `dispatch-review:${item.id}:${item.reviewer}` : undefined;
    item.phase = "review";
    item.boundary = { kind, from: item.reviewer, after: tail.id, ...(marker ? { marker } : {}), ...(assistant ? { assistant } : {}), ...(results ? { results: [...results] } : {}) };
    return marker;
  }

  private async reconcile(tx: Tx, roomId: ConversationId, item: Contribution) {
    if (item.phase === "closed") return;
    const reviewer = await tx.task(item.reviewer);
    if (item.executionBackend) {
      if (!reviewer || reviewer.kind !== (item.executionBackend === "muse-code" ? "dispatch.muse-run" : "dispatch.claude-sdk-run") || reviewer.conversationId !== item.conversationId || reviewer.abortRequested || reviewer.state.status === "terminal") await this.close(tx, roomId, item);
      return;
    }
    const live = await tx.doc(LiveDoc, item.conversationId);
    if (!reviewer || reviewer.abortRequested || !live.run || !item.inputs.length || !item.inputs.every(id => live.run!.inputs.includes(id))) {
      await this.close(tx, roomId, item); return;
    }
    if (live.run.taskId === item.reviewer && reviewer.state.status !== "terminal") return;
    const boundary = item.boundary;
    if (!boundary || reviewer.state.status !== "terminal" || reviewer.state.outcome.status !== "completed") {
      await this.close(tx, roomId, item); return;
    }
    // The old run cannot settle and later reuse these admitted inputs. Reject unrelated runs,
    // then verify the actual native transcript boundary rather than trusting our intent marker.
    const successor = await tx.task(live.run.taskId);
    if (!successor || successor.kind !== GenerationTask.definition.name || successor.abortRequested || successor.state.status === "terminal") {
      await this.close(tx, roomId, item); return;
    }
    const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
    do { const page = await tx.scanEntries({ conversationId: item.conversationId }, 200, cursor); entries.push(...page.items.filter(entry => Number(entry.id) > Number(boundary.after))); cursor = page.items.some(entry => Number(entry.id) <= Number(boundary.after)) ? undefined : page.next; } while (cursor);
    const reset = entries.some(entry => entry.kind === "pi.reset");
    const result = reviewer.state.outcome.result;
    const resultEntry = result && typeof result === "object" && !Array.isArray(result) && "entryId" in result ? result.entryId : undefined;
    let valid = !reset;
    if (boundary.kind === "final") {
      valid &&= entries.some(entry => entry.byTaskId === boundary.from && entry.kind === "pi.assistant" && entry.id === resultEntry)
        && entries.some(entry => entry.byTaskId === boundary.from && entry.kind === "pi.user" && entry.model?.some(message => message.role === "user" && typeof message.content === "string" && message.content.includes(boundary.marker!)));
    } else {
      const assistant = boundary.assistant ? await tx.entry(boundary.assistant) : undefined;
      valid &&= assistant?.byTaskId === boundary.from && resultEntry === boundary.assistant;
      for (const id of boundary.results ?? []) {
        const entry = await tx.entry(id);
        valid &&= entry?.kind === "pi.tool-result" && entry.conversationId === item.conversationId;
      }
    }
    if (!valid) { await this.close(tx, roomId, item); return; }
    item.reviewer = successor.id;
    item.inputs = [...live.run.inputs];
    delete item.boundary;
  }
}

export function contributionCopy(item: Contribution) { return copyJson(item, { omitUndefinedProperties: true }) as Contribution; }
