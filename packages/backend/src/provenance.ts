import type { Snapshot } from "./contracts.js";
import type { ChatSnapshot } from "@dispatch/runner";
import type { Cursor } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

export interface NativeEntry {
  id: number;
  kind: string;
  data?: unknown;
}
export interface NativeHistory {
  entries(
    query: { minEntryId?: number },
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<{ items: readonly NativeEntry[]; next?: Cursor }>;
}

// Dispatch's presentation IDs retain the native entry ID. Its chat projection
// does not retain entry.kind/source, so enrich it from that same owner's native
// history rather than guessing from message text or modifying stored entries.
export function createProvenance(
  conversation: NativeHistory,
  context: Context,
  namespace: string,
) {
  const entries = new Map<number, NativeEntry>();
  let last = 0;
  return async (snapshot: ChatSnapshot): Promise<Snapshot> => {
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries(
        last ? { minEntryId: last + 1 } : {},
        250,
        cursor,
        context,
      );
      for (const entry of page.items) entries.set(entry.id, entry);
      cursor = page.next;
    } while (cursor);
    for (const id of entries.keys()) last = Math.max(last, id);
    return {
      ...snapshot,
      messages: snapshot.messages.map((message) => {
        if (message.role !== "user")
          return { ...message, provenance: "agent" as const };
        const entry = entries.get(Number(message.id.split(":")[0]));
        const data = entry?.data as
          { source?: string; from?: string } | undefined;
        if (
          entry?.kind === `${namespace}.message` &&
          ["web", "cli", "slack", "google-chat", "phone", "email"].includes(
            data?.source ?? "",
          )
        ) {
          return { ...message, provenance: "user" as const };
        }
        if (entry?.kind === `${namespace}.instance-message`) {
          return {
            ...message,
            provenance: "agent" as const,
            author: data?.from ?? "Agent message",
          };
        }
        // pi.user is used by GenerationTask.onYield for internal continuation;
        // pi.compaction/pi.reset are runtime context, not new human speech. Unknown
        // sources are retained in the snapshot but never attributed to the user.
        return { ...message, provenance: "runtime" as const };
      }),
    };
  };
}
