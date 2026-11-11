import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";

export type ReplyDestination = { channel: string; thread: string; user: string; transport?: string };
export type ReplySink = (
  tx: Tx, conversationId: ConversationId, destination: ReplyDestination, text: string, key: string,
) => Promise<void>;

/** Supporting material kept with a reply: in the agent's context, shown collapsed under the reply's text. */
export type ReplyDetails = { label: string; text: string };

export type StatusSink = (...args: [...Parameters<ReplySink>, finished?: boolean]) => Promise<void>;

export function createReplies(namespace: string) {
  /** The visible entry and the transport outbox are committed together. */
  async function publishReply(
    tx: Tx, conversationId: ConversationId, author: string, message: AssistantMessage | string,
    key: string, sink?: ReplySink, destination?: ReplyDestination, details?: ReplyDetails,
  ) {
    const text = typeof message === "string" ? message :
      message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    const shown = details?.text.trim() ? { label: details.label.trim() || "Details", text: details.text.trim() } : undefined;
    await tx.appendEntry(conversationId, {
      kind: `${namespace}.background-reply`,
      data: { author, text, key, ...(shown ? { details: shown } : {}) },
      // Attribute the contribution in the supervising agent's context and UI; details are context too.
      ...(typeof message === "string" ? {} : {
        model: [{ ...message, content: [{ type: "text" as const, text: `${author}: ${text}${shown ? `\n\n${shown.label}:\n${shown.text}` : ""}` }] }],
      }),
    });
    if (destination) {
      if (!sink) throw new Error("This reply needs a delivery adapter.");
      await sink(tx, conversationId, destination, `${author}:\n${text}`, key);
    }
  }

  return { publishReply };
}
