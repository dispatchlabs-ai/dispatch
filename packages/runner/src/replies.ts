import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";

export type ReplyDestination = { channel: string; thread: string; user: string };
export type ReplySink = (
  tx: Tx, conversationId: ConversationId, destination: ReplyDestination, text: string, key: string,
) => Promise<void>;

export function createReplies(namespace: string) {
  /** The visible entry and the transport outbox are committed together. */
  async function publishReply(
    tx: Tx, conversationId: ConversationId, author: string, message: AssistantMessage | string,
    key: string, sink?: ReplySink, destination?: ReplyDestination,
  ) {
    const text = typeof message === "string" ? message :
      message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    await tx.appendEntry(conversationId, {
      kind: `${namespace}.background-reply`,
      data: { author, text, key },
      // Attribute the contribution in the supervising agent's context and UI.
      ...(typeof message === "string" ? {} : {
        model: [{ ...message, content: [{ type: "text" as const, text: `${author}: ${text}` }] }],
      }),
    });
    if (destination) {
      if (!sink) throw new Error("This reply needs the Slack adapter.");
      await sink(tx, conversationId, destination, `${author}:\n${text}`, key);
    }
  }

  return { publishReply };
}
