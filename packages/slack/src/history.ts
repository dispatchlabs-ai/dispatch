import { LiveDoc, type ConversationId, type ConversationWatch } from "@earendil-works/pi-durable";
import { context, type ChatService, type Runner } from "@dispatch/runner";
import type { createResponseDelivery } from "./responses.js";

/** Native history is the source of truth. Watches only wake the durable outbox;
 * startup runs the same census to recover changes made while Slack was offline. */
export function createHistorySync(runner: Runner, responses: ReturnType<typeof createResponseDelivery>, options: {
  team: string;
  accepts: (channel: string, agent: string) => boolean;
  enrolled: (service: ChatService, user: string, agent: string) => boolean;
  allowProgressText?: (id: number, inputs: readonly number[]) => boolean | Promise<boolean>;
}) {
  const watches = new Map<string, { watch: ConversationWatch; pending: Promise<void> }>();
  let unsubscribe: (() => void) | undefined;
  let closing = false;
  return {
    async start(service: ChatService) {
      // A chat's conversation changes only while its store is open, so the census follows each store as it opens.
      unsubscribe = service.onChatOpen(async (chat, host) => {
        if (closing || watches.has(chat.id)) return;
        const keys = (await service.host(chat.agent).harness.snapshot(runner.Chats, context))?.keys ?? {};
        const [transport, team, channel, thread, extra] = (Object.keys(keys).find(key => keys[key] === chat.id) ?? "").split(":");
        if (transport !== "slack" || team !== options.team || !channel || !thread || extra
          || !options.accepts(channel, chat.agent)) return;
        const conversation = host.conversation;
        // Attach before the census; coalesced notifications cannot lose entries.
        const watch = await conversation.watch(context);
        const state = { watch, pending: Promise.resolve() };
        watches.set(chat.id, state);
        void watch.closed.then(() => { if (watches.get(chat.id) === state) watches.delete(chat.id); });
        const sync = async () => {
          if (closing) return;
          const live = await host.harness.snapshot(LiveDoc, conversation.id, context);
          const allowed = live?.run && (!options.allowProgressText
            || await options.allowProgressText(conversation.id, live.run.inputs));
          let more: boolean;
          do {
            ({ more } = await conversation.commit(tx => responses.queueHistory(tx, conversation.id, { channel, thread }, user => options.enrolled(service, user, chat.agent), conversation.id,
              allowed && live?.generation?.message ? { generation: live.run!.taskId, first: live.run!.first ?? 0 } : undefined), context));
          } while (more && !closing);
          host.harness.resume();
        };
        watch.start(async call => {
          state.pending = (call.kind === "failed" ? Promise.reject(call.error) : sync()).catch(error => {
            if (!closing) console.error("Slack history sync:", error instanceof Error ? error.message : String(error));
          });
          await state.pending;
        });
        await sync();
      });
    },
    async close() {
      closing = true;
      unsubscribe?.();
      await Promise.all([...watches.values()].map(async state => { await state.watch.stop(); await state.pending; }));
      watches.clear();
    },
  };
}
