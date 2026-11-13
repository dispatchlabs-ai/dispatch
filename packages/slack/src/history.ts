import { LiveDoc, type ConversationId, type ConversationWatch } from "@earendil-works/pi-durable";
import { context, type ChatService, type Runner } from "@dispatch/runner";
import type { createResponseDelivery } from "./responses.js";

/** Native history is the source of truth. Watches only wake the durable outbox;
 * startup runs the same census to recover changes made while Slack was offline. */
export function createHistorySync(runner: Runner, responses: ReturnType<typeof createResponseDelivery>, options: {
  team: string;
  accepts: (channel: string, agent: string) => boolean;
  allowedUser: (user: string) => boolean;
  allowProgressText?: (id: number, inputs: readonly number[]) => boolean | Promise<boolean>;
}) {
  const watches = new Map<string, { watch: ConversationWatch; pending: Promise<void> }>();
  let list: Awaited<ReturnType<ChatService["watchList"]>> | undefined;
  let closing = false;
  return {
    async start(service: ChatService) {
      list = await service.watchList(async () => {
        for (const [agent, host] of service.hosts) {
          const chats = await host.harness.snapshot(runner.Chats, context);
          for (const [key, id] of Object.entries(chats?.keys ?? {})) {
            if (watches.has(id)) continue;
            const [transport, team, channel, thread, extra] = key.split(":");
            if (transport !== "slack" || team !== options.team || !channel || !thread || extra
              || !options.accepts(channel, agent)) continue;
            const chat = chats!.byId[id];
            const conversation = await host.harness.conversation(chat.conversationId as ConversationId, context);
            if (!conversation) continue;
            // Attach before the census; coalesced notifications cannot lose entries.
            const watch = await conversation.watch(context);
            const state = { watch, pending: Promise.resolve() };
            watches.set(id, state);
            const sync = async () => {
              if (closing) return;
              const live = await host.harness.snapshot(LiveDoc, conversation.id, context);
              const allowed = live?.run && (!options.allowProgressText
                || await options.allowProgressText(conversation.id, live.run.inputs));
              let more: boolean;
              do {
                ({ more } = await conversation.commit(tx => responses.queueHistory(tx, conversation.id, { channel, thread }, options.allowedUser, host.conversation.id,
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
            // A startup failure must not silently report a connected adapter.
            await sync();
          }
        }
      });
    },
    async close() {
      closing = true;
      await list?.stop();
      await Promise.all([...watches.values()].map(async state => { await state.watch.stop(); await state.pending; }));
      watches.clear();
    },
  };
}
