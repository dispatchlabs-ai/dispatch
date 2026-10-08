import type { Context } from "@earendil-works/chord";
import { defineDoc, defineTask, type ConversationId, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";

type Ticket = {
  key: string; participantId: string; owner: TaskId; priority: boolean; order: number; tie: string;
  requester?: TaskId; gate?: TaskId;
};
type Presence = { participantId: string; sequence: number; until: number; expiry?: TaskId };
type Turns = {
  publicationOnly?: boolean; contributionOwned?: boolean; queue: Ticket[]; speaker?: Ticket; sequence: number; presence: Record<string, Presence>;
};
export const TurnsDoc = defineDoc<Turns>({
  kind: "dispatch.conversation-turns", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ publicationOnly: true, contributionOwned: true, queue: [], sequence: 0, presence: {} }),
});

/** Conversation etiquette, persisted and waited on by native Pi tasks. Tool execution stays independent. */
export class ConversationTurns {
  private harness!: Harness;
  readonly wait = defineTask<{ roomId: ConversationId; key: string }, { phase: "wait" }, null>({
    name: "dispatch.wait-for-turn", version: 1, initial: () => ({ phase: "wait" }),
    phases: { wait: async (task, runtime, ctx) => {
      let done = false;
      while (!done) {
        await runtime.commit(async tx => {
          const turns = await tx.doc(TurnsDoc, task.input.roomId);
          // Owner receipts release abandoned claims after faults, cancellation or recovery.
          const owners = new Map(await Promise.all([...turns.queue, ...(turns.speaker ? [turns.speaker] : [])]
            .flatMap(ticket => [ticket.owner, ...(ticket.requester ? [ticket.requester] : [])]).map(async id => [id, await tx.task(id)] as const)));
          const active = (ticket: Ticket) => {
            const owner = owners.get(ticket.owner);
            const requester = ticket.requester ? owners.get(ticket.requester) : owner;
            return owner && !owner.abortRequested && owner.state.status !== "terminal" && requester && !requester.abortRequested && requester.state.status !== "terminal";
          };
          const remaining = turns.queue.filter(active);
          if (remaining.length !== turns.queue.length) turns.queue = remaining;
          if (turns.speaker && !active(turns.speaker)) delete turns.speaker;
          const ticket = turns.queue.find(item => item.key === task.input.key);
          if (turns.speaker?.key === task.input.key) {
            if (humansComposing(turns)) return;
            done = true;
            return completed();
          }
          if (!ticket) {
            done = true;
            return { status: "terminal", outcome: { status: "aborted" } };
          }
          const first = [...turns.queue].sort(compareTickets)[0];
          if (!turns.speaker && !humansComposing(turns) && first?.key === ticket.key) {
            turns.speaker = ticket;
            turns.queue = turns.queue.filter(item => item.key !== ticket.key);
            done = true;
            return completed();
          }
        }, ctx);
        // The native cancellable clock also wakes for expired human presence and failed owner tasks.
        if (!done) await runtime.sleep(runtime.now() + 200, ctx);
      }
    } },
    abort: (task, runtime, ctx) => runtime.commit(async tx => {
      const turns = await tx.doc(TurnsDoc, task.input.roomId);
      turns.queue = turns.queue.filter(ticket => ticket.key !== task.input.key);
      if (turns.speaker?.key === task.input.key) delete turns.speaker;
      return { status: "terminal", outcome: { status: "aborted" } };
    }, ctx),
  });

  readonly expirePresence = defineTask<{ roomId: ConversationId; client: string }, { phase: "wait" }, null>({
    name: "dispatch.composing-expiry", version: 1, initial: () => ({ phase: "wait" }),
    phases: { wait: async (task, runtime, ctx) => {
      let done = false;
      while (!done) {
        const state = await runtime.snapshot(TurnsDoc, task.input.roomId, ctx);
        const until = state?.presence[task.input.client]?.until ?? 0;
        if (until > runtime.now()) await runtime.sleep(until, ctx);
        await runtime.commit(async tx => {
          const turns = await tx.doc(TurnsDoc, task.input.roomId);
          const presence = turns.presence[task.input.client];
          if (!presence || presence.expiry !== task.id) {
            done = true;
            return completed();
          }
          if (presence.until <= runtime.now()) {
            presence.until = 0;
            delete presence.expiry;
            done = true;
            return completed();
          }
        }, ctx);
      }
    } },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });

  bind(harness: Harness) { this.harness = harness; }

  async migrate(tx: Tx, roomId: ConversationId) {
    const turns = await tx.doc(TurnsDoc, roomId);
    if (turns.contributionOwned) return;
    // Upgrade request/delivery and generation-owned claims once; native work is untouched.
    turns.queue = [];
    delete turns.speaker;
    turns.publicationOnly = true;
    turns.contributionOwned = true;
  }

  async acquire(roomId: ConversationId, participantId: string, owner: TaskId, requester: TaskId, conversationId: ConversationId, ctx: Context, priority = false, authorize?: (tx: Tx) => Promise<void>) {
    const gate = await this.harness.commit(async tx => {
      await authorize?.(tx);
      const task = await tx.task(requester);
      if (!task || task.abortRequested || task.state.status === "terminal") throw new Error("The response is no longer active.");
      const turns = await tx.doc(TurnsDoc, roomId);
      if (turns.speaker?.requester === requester) {
        if (!humansComposing(turns)) return turns.speaker.gate!;
        const prior = turns.speaker.gate ? await tx.task(turns.speaker.gate) : undefined;
        if (prior && prior.state.status !== "terminal") return prior.id;
        const id = await tx.createTask(this.wait, { roomId, key: turns.speaker.key }, { conversationId, ownership: { kind: "task", taskId: requester } });
        turns.speaker.gate = id;
        return id;
      }
      let ticket = turns.queue.find(item => item.requester === requester) ?? turns.queue.find(item => item.participantId === participantId && !item.requester);
      if (ticket?.requester === requester && ticket.gate) {
        const previous = await tx.task(ticket.gate);
        if (previous && previous.state.status !== "terminal") return ticket.gate;
      }
      if (!ticket) {
        ticket = { key: String(requester), participantId, owner, priority, order: ++turns.sequence, tie: String(requester) };
        turns.queue.push(ticket);
        ticket = turns.queue.at(-1)!;
      }
      // A prequeued later delivery can depend on this one. Retain its priority, but bind it to the active work.
      ticket.key = String(requester);
      ticket.owner = owner;
      ticket.requester = requester;
      ticket.priority ||= priority;
      const id = await tx.createTask(this.wait, { roomId, key: ticket.key }, { conversationId, ownership: { kind: "task", taskId: requester } });
      ticket.gate = id;
      return id;
    }, ctx);
    const result = await this.harness.waitForTask(gate, ctx);
    if (result.state.outcome.status !== "completed") throw new Error("The speaking turn could not be acquired.");
  }

  async release(tx: Tx, roomId: ConversationId, participantId: string, requester?: TaskId) {
    const turns = await tx.doc(TurnsDoc, roomId);
    if (turns.speaker?.participantId === participantId && (!requester || turns.speaker.requester === requester)) delete turns.speaker;
    turns.queue = turns.queue.filter(ticket => ticket.participantId !== participantId || (requester && ticket.requester !== requester));
  }

  async composing(tx: Tx, roomId: ConversationId, participantId: string, clientId: string, sequence: number, active: boolean) {
    const turns = await tx.doc(TurnsDoc, roomId);
    const client = `${participantId}:${clientId}`;
    const previous = turns.presence[client];
    if (previous && previous.sequence >= sequence) return;
    const expiry = previous?.expiry ? await tx.task(previous.expiry) : undefined;
    turns.presence[client] = { participantId, sequence, until: active ? Date.now() + 6_000 : 0,
      ...(expiry && !expiry.abortRequested && expiry.state.status !== "terminal" ? { expiry: expiry.id } : {}) };
    const presence = turns.presence[client];
    // Retain sequence tombstones so a delayed heartbeat cannot undo a newer pause or send.
    if (active && !presence.expiry) presence.expiry = await tx.createTask(this.expirePresence, { roomId, client }, { conversationId: roomId, ownership: { kind: "conversation" }, background: true });
  }

  async clear(tx: Tx, roomId: ConversationId) {
    const turns = await tx.doc(TurnsDoc, roomId);
    turns.queue = [];
    delete turns.speaker;
  }
}

export function humansComposing(turns: Readonly<Turns>, now = Date.now()) { return Object.values(turns.presence).some(presence => presence.until > now); }
function compareTickets(a: Ticket, b: Ticket) { return Number(b.priority) - Number(a.priority) || a.order - b.order || a.tie.localeCompare(b.tie); }
function completed() { return { status: "terminal", outcome: { status: "completed", result: null } } as const; }
