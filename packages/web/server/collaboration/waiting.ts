import { copyJson, type Context } from "@earendil-works/chord";
import { defineDoc, defineTask, LiveDoc, type ConversationId, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";

export type Dependency = { id: string; participantId: string; description: string };
export type Attention = { kind: "result" | "blocker" | "correction"; dependencyId?: string };
type Signal = { id: string; authorId: string; mentions: string[]; attention?: Attention };
type Wait = {
  id: string; conversationId: ConversationId; inputs: SubmissionId[]; epoch: number; criteriaRevision: number;
  dependencies: Dependency[]; received: Record<string, string>; through?: string; createdAt: number; reviewAt: number;
  status: "waiting" | "ready"; reason?: string; resumedAt?: number; gate?: TaskId;
};
export const DependencyWaitsDoc = defineDoc<{ participants: Record<string, Wait> }>({
  checkpointWhen: () => false,
  kind: "dispatch.dependency-waits", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ participants: {} }),
});
export const WaitReceipt = defineDoc<{ result?: Wait }>({
  checkpointWhen: () => false,
  kind: "dispatch.dependency-wait-receipt", version: 1, scope: "task", initial: () => ({}),
});
type Room = { epoch: number; stopping?: TaskId; definitionOfDone?: { revision: number }; members: { id: string; kind: string; membership?: string }[] };
const active = (member: Room["members"][number] | undefined) => Boolean(member && (!member.membership || member.membership === "active"));
const completed = () => ({ status: "terminal", outcome: { status: "completed", result: null } }) as const;

/** Explicit dependency waits delay only the next native model request, never a speaking turn. */
export class DependencyWaits {
  private harness!: Harness;
  readonly task;
  constructor(private readonly room: (tx: Tx, roomId: ConversationId) => Promise<Room>) {
    this.task = defineTask<{ roomId: ConversationId; participantId: string; waitId: string }, { phase: "wait" }, null>({
      name: "dispatch.wait-for-dependencies", version: 1, initial: () => ({ phase: "wait" }),
      phases: { wait: (task, runtime, ctx) => runtime.commit(async tx => {
        const wait = (await tx.doc(DependencyWaitsDoc, task.input.roomId)).participants[task.input.participantId];
        if (wait?.id === task.input.waitId && wait.status === "waiting") {
          const room = await this.room(tx, task.input.roomId);
          const live = await tx.doc(LiveDoc, wait.conversationId);
          if (room.stopping || room.epoch !== wait.epoch || !active(room.members.find(member => member.id === task.input.participantId))) resume(wait, "cancelled", runtime.now());
          else if (!live.run || !wait.inputs.every(id => live.run!.inputs.includes(id))) resume(wait, "run-changed", runtime.now());
          else if ((room.definitionOfDone?.revision ?? 0) !== wait.criteriaRevision) resume(wait, "criteria-changed", runtime.now());
          else if (wait.dependencies.some(dependency => !active(room.members.find(member => member.id === dependency.participantId)))) resume(wait, "dependency-unavailable", runtime.now());
          else if (runtime.now() >= wait.reviewAt) resume(wait, "review-deadline", runtime.now());
        }
        if (!wait || wait.id !== task.input.waitId || wait.status !== "waiting") return completed();
        return { status: "sleeping", until: Math.min(wait.reviewAt, runtime.now() + 250), checkpoint: { phase: "wait" } };
      }, ctx) },
      abort: (task, runtime, ctx) => runtime.commit(async tx => {
        const wait = (await tx.doc(DependencyWaitsDoc, task.input.roomId)).participants[task.input.participantId];
        if (wait?.id === task.input.waitId) resume(wait, "cancelled", runtime.now());
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx),
    });
  }

  bind(harness: Harness) { this.harness = harness; }

  async register(tx: Tx, roomId: ConversationId, participantId: string, input: Omit<Wait, "status" | "received" | "gate">, unseen: Signal[]) {
    const room = await this.room(tx, roomId);
    if (input.dependencies.some(dependency => dependency.participantId === participantId
      || !room.members.some(member => member.id === dependency.participantId && member.kind === "agent" && active(member)))) {
      throw new Error("Dependencies must name other active agent participants in this conversation.");
    }
    if (new Set(input.dependencies.map(dependency => dependency.id)).size !== input.dependencies.length) throw new Error("Dependency IDs must be distinct.");
    const doc = await tx.doc(DependencyWaitsDoc, roomId);
    doc.participants[participantId] = { ...input, status: "waiting", received: {} };
    for (const message of unseen) observe(doc.participants[participantId], participantId, message, room, input.createdAt);
    return copyJson(doc.participants[participantId], { omitUndefinedProperties: true }) as Wait;
  }

  async observe(tx: Tx, roomId: ConversationId, message: Signal) {
    const room = await this.room(tx, roomId);
    for (const [participantId, wait] of Object.entries((await tx.doc(DependencyWaitsDoc, roomId)).participants)) {
      observe(wait, participantId, message, room, Date.now());
    }
  }

  async pause(roomId: ConversationId, participantId: string, owner: TaskId, ctx: Context) {
    const gate = await this.harness.commit(async tx => {
      const wait = (await tx.doc(DependencyWaitsDoc, roomId)).participants[participantId];
      if (!wait || wait.status !== "waiting") return;
      if (wait.gate) {
        const prior = await tx.task(wait.gate);
        if (prior && prior.state.status !== "terminal" && !prior.abortRequested) return prior.id;
      }
      wait.gate = await tx.createTask(this.task, { roomId, participantId, waitId: wait.id }, {
        conversationId: wait.conversationId, ownership: { kind: "task", taskId: owner },
      });
      return wait.gate;
    }, ctx);
    if (gate) {
      const result = await this.harness.waitForTask(gate, ctx);
      if (result.state.outcome.status !== "completed") throw new Error("The dependency wait did not complete.");
    }
  }

  async cancel(tx: Tx, roomId: ConversationId, participantId?: string) {
    for (const [id, wait] of Object.entries((await tx.doc(DependencyWaitsDoc, roomId)).participants)) {
      if (!participantId || participantId === id) resume(wait, "cancelled", Date.now());
    }
  }
}

function resume(wait: Wait, reason: string, now: number) {
  if (wait.status !== "waiting") return;
  wait.status = "ready"; wait.reason = reason; wait.resumedAt = now;
}

function observe(wait: Wait, self: string, message: Signal, room: Room, now: number) {
  if (wait.status !== "waiting" || message.authorId === self) return;
  if (room.members.find(member => member.id === message.authorId)?.kind === "human") resume(wait, "human-message", now);
  else if (message.mentions.includes(self)) resume(wait, "direct-mention", now);
  else if (message.attention?.kind === "blocker" || message.attention?.kind === "correction") resume(wait, message.attention.kind, now);
  else if (message.attention?.kind === "result") {
    const dependency = wait.dependencies.find(item => item.id === message.attention!.dependencyId && item.participantId === message.authorId);
    if (dependency) wait.received[dependency.id] = message.id;
    if (wait.dependencies.every(item => Object.hasOwn(wait.received, item.id))) resume(wait, "dependencies-ready", now);
  }
}
