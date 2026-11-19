import type { Context } from "@earendil-works/chord/context";
import { InboxDoc, ROOT_CONVERSATION_ID, type ConversationId, type Cursor, type EntryId, type TaskId } from "@earendil-works/pi-durable";
import type { ChatService } from "./chat.js";
import type { AgentHost } from "./runtime.js";

/** Follow native ownership and admitted peer messages, without another workflow store. */
export async function waitForMessageWork(service: ChatService, namespace: string,
  from: string, to: string, taskId: number, context: Context) {
  if (from === to) throw new Error("Cannot wait for your own conversation from a running tool.");
  // A member is a chat's own conversation or one of its private children, named as activity() names them.
  const members = new Map<string, { chat: string; id: ConversationId; after: number }>();
  const name = (chat: string, id: ConversationId) => id === ROOT_CONVERSATION_ID ? chat : `${chat}/${id}`;
  const add = (chat: string, id: ConversationId) => {
    const key = name(chat, id);
    if (key !== from && !members.has(key)) members.set(key, { chat, id, after: 0 });
  };
  add(to, ROOT_CONVERSATION_ID);
  let revision = 0;
  let wake: (() => void) | undefined;
  const observed = new Map<AgentHost, { detach(): void }>();
  const signal = context.abortSignal;
  try {
    while (true) {
      signal?.throwIfAborted();
      // Resolve each pass: an idle chat's store may have closed, and resolving reopens it and keeps it in use.
      const stores = new Map<string, AgentHost>();
      const store = async (chat: string) => {
        let host = stores.get(chat);
        if (!host) {
          stores.set(chat, host = (await service.resolve(chat)).host);
          if (!observed.has(host)) observed.set(host, host.harness.observeCommits({ advance: () => {
            revision++; wake?.();
          }, end: () => { revision++; wake?.(); } }));
        }
        return host;
      };
      const sender = await store(from);
      const seen = revision;
      // Map iteration includes newly discovered recipients/children. Scan only new
      // entries, but revisit ownership because a later turn can create children.
      for (const member of members.values()) {
        const recipients = await (await store(member.chat)).harness.commit(async tx => {
          const queued: string[] = [];
          let cursor: Cursor | undefined;
          do {
            const page = await tx.scanConversations({ ownerConversationId: member.id }, 250, cursor);
            for (const child of page.items) add(member.chat, child.id);
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
              if (data.status === "queued") queued.push(data.to);
            }
            cursor = page.next;
          } while (cursor);
          return queued;
        }, context);
        for (const recipient of recipients) add(recipient, ROOT_CONVERSATION_ID);
      }
      for (const member of members.values()) await store(member.chat);
      const inspections = await Promise.all([...stores].map(async ([chat, host]) =>
        ({ chat, inspection: await host.harness.inspect(context) })));
      const delivery = await sender.harness.getTask(taskId as TaskId, context);
      if (!delivery) throw new Error("Message task disappeared.");
      const tasks = inspections.flatMap(({ chat, inspection }) => inspection.tasks
        .filter(task => members.has(name(chat, task.record.conversationId))
          || (chat === from && task.record.id === taskId))
        .map(task => ({ agent: chat.split(":")[0], ...task })));
      const submissions = inspections.flatMap(({ chat, inspection }) => inspection.submissions
        .filter(input => members.has(name(chat, input.conversationId))));
      const inputPending = (await sender.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, context))
        ?.items.some(item => item.mode === "steer");
      if (revision !== seen) continue;
      const blocked = tasks.filter(task => task.state.kind === "blocked");
      const waitingOnSender = tasks.some(task => task.record.kind === `${namespace}.instance-message`
        && (task.record.input as { to?: string }).to === from);
      const held = inspections.some(({ chat, inspection }) => inspection.submissions.some(input =>
        members.has(name(chat, input.conversationId)) && !inspection.tasks.some(task =>
          task.record.conversationId === input.conversationId && !task.record.background)));
      if (inputPending || blocked.length || waitingOnSender || held || (!tasks.length && !submissions.length)) {
        const snapshot = await service.snapshot(to);
        if (revision !== seen) continue;
        const answer = snapshot.messages.findLast(message => message.role === "assistant");
        return {
          from, to, taskId, state: inputPending ? "input_pending" : blocked.length ? "blocked" : waitingOnSender ? "waiting_on_sender" : held ? "held" : "idle",
          instances: [...members.keys()],
          delivery: delivery.state,
          answer: answer ? { text: answer.text, ...(answer.error ? { error: answer.error } : {}) } : null,
          blockedTasks: blocked.map(task => ({ agent: task.agent, taskId: task.record.id, kind: task.record.kind })),
          note: "Input pending yields to a queued correction. Idle means the admitted work has settled, not that the user's goal or workflow acceptance criteria were met. Check the final report and evidence. Waiting never cancels independently admitted work.",
        };
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener("abort", abort); wake = undefined; resolve(); };
        const abort = () => { wake = undefined; reject(signal?.reason); };
        wake = finish;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else if (revision !== seen) finish();
      });
    }
  } finally { for (const observation of observed.values()) observation.detach(); }
}
