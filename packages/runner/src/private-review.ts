import { LiveDoc, type ConversationId, type Cursor, type Extension, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { ReminderCall } from "./mcp.js";

export type PrivateReviewHost = {
  namespace: string; agent: string; preview: boolean;
  enrolled(owner: string): boolean;
  profile(owner: string): Promise<string | undefined>;
  call(name: string): ReminderCall;
  tools(selection: Record<string, string[]>): ToolRegistration[];
};

export function privateMonitor(id: string, review: string[], destination: string, bindMonitor: (host: PrivateReviewHost) => Extension) {
  return { name: "monitor:" + id, monitorConnections: { review, destination }, bindMonitor };
}

/** Authority comes from the transport's current human input, never a name in model arguments. */
export async function authorizePrivateReview(host: Pick<PrivateReviewHost, "namespace" | "enrolled">,
  owner: string, tx: Tx, conversation: ConversationId) {
  if (!host.enrolled(owner) || (await tx.conversation(conversation))?.owner)
    throw new Error("Open the enrolled owner's private chat.");
  const inputs = (await tx.doc(LiveDoc, conversation)).run?.inputs ?? [];
  const current = new Set((await Promise.all(inputs.map(input => tx.submission(input)))).map(input => input?.entry));
  let human = false, cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: conversation, order: "descending" }, 100, cursor);
    for (const entry of page.items) {
      const data = entry.data as { actor?: string; userId?: string; audience?: string[]; source?: string; group?: boolean; slack?: { channel?: string } } | undefined;
      if (entry.kind !== host.namespace + ".message" || data?.actor !== "user") continue;
      const direct = ["cli", "terminal", "web", "imsg"].includes(data.source ?? "")
        || data.source === "slack" && data.slack?.channel?.startsWith("D");
      if (!direct || data.group || data.userId !== owner || data.audience?.some(member => member !== owner))
        throw new Error("Open the enrolled owner's private chat.");
      if (current.has(entry.id)) human = true;
    }
    cursor = page.next;
  } while (cursor);
  if (!human) throw new Error("The enrolled owner must request this in private.");
}
