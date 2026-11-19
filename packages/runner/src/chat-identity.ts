import type { Context } from "@earendil-works/chord/context";
import { defineDoc, ROOT_CONVERSATION_ID, type ConversationId, type JsonObject, type Tx } from "@earendil-works/pi-durable";

function define(namespace: string) {
  return defineDoc<{ id: string; source?: string; origin?: JsonObject }>({
    kind: `${namespace}.chat`, version: 1, scope: "session",
    checkpointWhen: () => false, initial: () => ({ id: "" }),
  });
}
const identities = new Map<string, ReturnType<typeof define>>();

/** A chat's own store names the chat it holds, with the channel and origin it was created for. An agent's own store has no such name. */
export function chatIdentity(namespace: string) {
  let identity = identities.get(namespace);
  if (!identity) identities.set(namespace, identity = define(namespace));
  return identity;
}

/** The chat a running tool or task belongs to. Only a chat's root conversation is addressable as the chat. */
export async function callerChat(namespace: string, agent: string,
  caller: { conversationId: ConversationId; commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> }, context: Context) {
  const id = caller.conversationId === ROOT_CONVERSATION_ID
    ? await caller.commit(async tx => (await tx.doc(chatIdentity(namespace))).id, context) : "";
  return id || `${agent}:${caller.conversationId}`;
}
