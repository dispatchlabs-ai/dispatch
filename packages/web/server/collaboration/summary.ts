import { defineDoc, type Cursor, type EntryId } from "@earendil-works/pi-durable";

type PublicSummary = {
  complete: boolean;
  cursor?: Cursor;
  first?: { entryId: EntryId; text: string };
  updatedAt: number;
};

/** Derived public metadata, committed with its source entry. Never contains private agent history. */
export const PublicSummaryDoc = defineDoc<PublicSummary>({
  checkpointWhen: () => false,
  kind: "dispatch.public-summary", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ complete: false, updatedAt: 0 }),
});

export function includePublicMessage(summary: PublicSummary, entryId: EntryId, message: { kind: string; text: string; createdAt: number }) {
  summary.updatedAt = Math.max(summary.updatedAt, message.createdAt);
  if (message.kind === "message" && (!summary.first || entryId < summary.first.entryId)) {
    summary.first = { entryId, text: message.text.slice(0, 80) };
  }
}
