import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryId, TaskId } from "@earendil-works/pi-durable";
import type { ChatService } from "./chat.js";

/** Follow native ownership and admitted peer messages, without another workflow store. */
export async function waitForMessageWork(service: ChatService, namespace: string,
  from: string, to: string, taskId: number, context: Context) {
  if (from === to) throw new Error("Cannot wait for your own conversation from a running tool.");
  const sender = await service.resolve(from);
  const root = await service.resolve(to);
  const members = new Map<string, { agent: string; id: ConversationId; after: number }>();
  const add = (agent: string, id: ConversationId) => {
    const key = `${agent}:${id}`;
    if (key !== from && !members.has(key)) members.set(key, { agent, id, after: 0 });
  };
  add(root.chat.agent, root.conversation.id);
  let revision = 0;
  let wake: (() => void) | undefined;
  const stops = [...service.hosts.values()].map(host => host.harness.subscribeCommits(() => {
    revision++; wake?.();
  }));
  const signal = context.abortSignal;
  try {
    while (true) {
      signal?.throwIfAborted();
      const observed = revision;
      // Map iteration includes newly discovered recipients/children. Scan only new
      // entries, but revisit ownership because a later turn can create children.
      for (const member of members.values()) {
        const host = service.host(member.agent);
        await host.harness.commit(async tx => {
          let cursor: Cursor | undefined;
          do {
            const page = await tx.scanConversations({ ownerConversationId: member.id }, 250, cursor);
            for (const child of page.items) add(member.agent, child.id);
            cursor = page.next;
          } while (cursor);
          cursor = undefined;
          do {
            const page = await tx.scanEntries({ conversationId: member.id,
              minEntryId: (member.after + 1) as EntryId, order: "ascending" }, 250, cursor);
            for (const entry of page.items) {
              member.after = Math.max(member.after, entry.id);
              if (entry.kind !== `${namespace}.instance-message`) continue;
              const data = entry.data as { status: string; to: string };
              if (data.status !== "queued") continue;
              const recipient = data.to;
              const separator = recipient.lastIndexOf(":");
              add(recipient.slice(0, separator), Number(recipient.slice(separator + 1)) as ConversationId);
            }
            cursor = page.next;
          } while (cursor);
        }, context);
      }
      const inspections = await Promise.all([...service.hosts].map(async ([agent, host]) =>
        ({ agent, inspection: await host.harness.inspect(context) })));
      const delivery = await sender.host.harness.getTask(taskId as TaskId, context);
      if (!delivery) throw new Error("Message task disappeared.");
      const tasks = inspections.flatMap(({ agent, inspection }) => inspection.tasks
        .filter(task => members.has(`${agent}:${task.record.conversationId}`)
          || (agent === sender.chat.agent && task.record.id === taskId))
        .map(task => ({ agent, ...task })));
      const submissions = inspections.flatMap(({ agent, inspection }) => inspection.submissions
        .filter(input => members.has(`${agent}:${input.conversationId}`)));
      if (revision !== observed) continue;
      const blocked = tasks.filter(task => task.state.kind === "blocked");
      const waitingOnSender = tasks.some(task => task.record.kind === `${namespace}.instance-message`
        && (task.record.input as { to?: string }).to === from);
      const held = inspections.some(({ agent, inspection }) => inspection.submissions.some(input =>
        members.has(`${agent}:${input.conversationId}`) && !inspection.tasks.some(task =>
          task.record.conversationId === input.conversationId && !task.record.background)));
      if (blocked.length || waitingOnSender || held || (!tasks.length && !submissions.length)) {
        const snapshot = await service.snapshot(to);
        if (revision !== observed) continue;
        const answer = snapshot.messages.findLast(message => message.role === "assistant");
        return {
          from, to, taskId, state: blocked.length ? "blocked" : waitingOnSender ? "waiting_on_sender" : held ? "held" : "idle",
          instances: [...members.keys()],
          delivery: delivery.state,
          answer: answer ? { text: answer.text, ...(answer.error ? { error: answer.error } : {}) } : null,
          blockedTasks: blocked.map(task => ({ agent: task.agent, taskId: task.record.id, kind: task.record.kind })),
          note: "Idle means the admitted work has settled, not that the user's goal or workflow acceptance criteria were met. Check the final report and evidence. Waiting never cancels independently admitted work.",
        };
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener("abort", abort); wake = undefined; resolve(); };
        const abort = () => { wake = undefined; reject(signal?.reason); };
        wake = finish;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else if (revision !== observed) finish();
      });
    }
  } finally { for (const stop of stops) stop(); }
}
