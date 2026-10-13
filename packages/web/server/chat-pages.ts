import type { Message } from "@earendil-works/pi-ai";
import { toolActivities, type ToolActivity } from "../src/lib/tool-activity.js";
import type { ActivityBlock, ActivityPage } from "../src/shared/activity-page.js";
import { createHash } from "node:crypto";
import type { ConversationMessage, ParticipantActivity, TranscriptPage, TranscriptQuery } from "../src/shared/contracts.js";

export const PAGE_ITEMS = 40;
export const PAGE_BYTES = 256 * 1024;
export const ITEM_BYTES = 24 * 1024;
export class HistoryCursorError extends Error {}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const messagePreviews = new WeakMap<ConversationMessage, ConversationMessage>();
export function messagePreview(message: ConversationMessage): ConversationMessage {
  const cached = messagePreviews.get(message);
  if (cached) return cached;
  let result: ConversationMessage = bytes(message) <= ITEM_BYTES ? message : {
    id: message.id, kind: message.kind, authorId: message.authorId, createdAt: message.createdAt,
    threadId: message.threadId, aliases: message.aliases?.slice(0, 32), mentions: message.mentions, text: message.text.slice(0, 4000), truncated: true,
  };
  while (bytes(result) > ITEM_BYTES && result.text.length) result = { ...result, text: result.text.slice(0, Math.floor(result.text.length / 2)) };
  messagePreviews.set(message, result);
  return result;
}
export function activityPreview(activity: ParticipantActivity): ParticipantActivity {
  const { entries, live, ...rest } = activity;
  return { ...rest, entries: [], live: {}, detail: { count: entries.length, version: createHash("sha256").update(JSON.stringify([entries.at(-1)?.id, entries.length, live])).digest("hex"), active: Boolean(live.run || live.generation) } };
}

/** Cursors identify immutable timeline position, not an offset into a changing array. */
export function transcriptPage(messages: ConversationMessage[], activities: ParticipantActivity[], query: TranscriptQuery = {}, generation = ""): TranscriptPage {
  const destination = query.messageId ? messages.find(message => message.id === query.messageId || message.aliases?.includes(query.messageId!)) : undefined;
  const threadId = query.threadId ?? destination?.threadId ?? null;
  const root = threadId ? messages.find(m => m.id === threadId || m.aliases?.includes(threadId)) : undefined;
  const canonical = root?.id ?? threadId;
  const replies = new Map<string, { count: number; authorIds: string[]; lastAt: number }>();
  for (const m of messages) if (m.threadId) {
    const summary = replies.get(m.threadId) ?? { count: 0, authorIds: [], lastAt: 0 };
    summary.count++; summary.lastAt = Math.max(summary.lastAt, m.createdAt);
    if (summary.authorIds.length < 4 && !summary.authorIds.includes(m.authorId)) summary.authorIds.push(m.authorId);
    replies.set(m.threadId, summary);
  }
  const items = [
    ...messages.map((message, timelineOrder) => ({ key: `m:${message.id}`, at: message.createdAt, timelineOrder, message, activity: undefined as ParticipantActivity | undefined })).filter(item => item.message.threadId === canonical),
    // Live-only groups are status, not history; their disappearing IDs cannot anchor cursors.
    ...activities.map((activity, timelineOrder) => ({ key: `a:${activity.id}`, at: activity.createdAt, timelineOrder, message: undefined as ConversationMessage | undefined, activity })).filter(item => item.activity.threadId === canonical && item.activity.entries.length > 0),
  ].sort((a, b) => a.at - b.at);
  let end = destination ? Math.min(items.length, items.findIndex(item => item.message?.id === destination.id) + 1) : items.length;
  if (query.before) {
    let cursor: { key: string; generation: string };
    try { cursor = JSON.parse(Buffer.from(query.before, "base64url").toString("utf8")); }
    catch { throw new HistoryCursorError("Invalid history cursor. Reload history."); }
    if (!cursor || typeof cursor.key !== "string" || cursor.generation !== generation) throw new HistoryCursorError("History changed. Reload history.");
    end = items.findIndex(item => item.key === cursor.key || item.message?.aliases?.some(id => `m:${id}` === cursor.key));
    if (end < 0) throw new HistoryCursorError("History changed. Reload history.");
  }
  // Only page candidates need truncation, serialization and activity-version hashing.
  const present = ({ key, at, timelineOrder, message, activity }: typeof items[number]) => ({ key, at,
    message: message ? { ...messagePreview(message), timelineOrder, replySummary: replies.get(message.id) } : undefined,
    activity: activity ? { ...activityPreview(activity), timelineOrder } : undefined,
  });
  const rows = (chosen: { message?: ConversationMessage; activity?: ParticipantActivity }[]) => ({
    messages: chosen.flatMap(i => i.message ? [i.message] : []), activities: chosen.flatMap(i => i.activity ? [i.activity] : []) });
  if (query.publishedAfter !== undefined) {
    // Publications keep their draft timestamps, so one can sort into history a reader already loaded.
    // Publication order (message timelineOrder) finds them: return this thread's messages published
    // at or after the watermark, with their answered activity groups, oldest publication first.
    const groups = new Map(items.flatMap(item => item.activity?.messageId ? [[item.activity.messageId, item] as const] : []));
    const late = items.filter(item => item.message && item.timelineOrder >= query.publishedAfter!).sort((a, b) => a.timelineOrder - b.timelineOrder);
    const chosen: ReturnType<typeof present>[] = [];
    let size = 1024; let remaining = -1;
    for (const item of late) {
      const group = groups.get(item.message!.id);
      const candidate = group ? [present(item), present(group)] : [present(item)];
      const length = bytes(candidate);
      if (chosen.length && (chosen.length + candidate.length > PAGE_ITEMS || size + length > PAGE_BYTES)) { remaining = item.timelineOrder; break; }
      chosen.push(...candidate); size += length;
    }
    // An incomplete response reports its continuation as a newer publication outside the page.
    return { ...rows(chosen), before: null, threadId: canonical, generation, publication: { published: remaining >= 0 ? remaining : messages.length, outsideLatest: remaining } };
  }
  const chosen: ReturnType<typeof present>[] = [];
  let size = root ? bytes(messagePreview(root)) + 1024 : 1024; let index = end - 1;
  for (; index >= 0 && chosen.length < PAGE_ITEMS; index--) {
    const item = present(items[index]!);
    const length = bytes(item);
    if (size + length > PAGE_BYTES) break;
    chosen.unshift(item); size += length;
  }
  const first = chosen[0];
  let outsideLatest = -1;
  for (let i = 0; i <= index; i++) if (items[i]!.message) outsideLatest = Math.max(outsideLatest, items[i]!.timelineOrder);
  return { ...rows(chosen), before: index >= 0 && first ? Buffer.from(JSON.stringify({ key: first.key, generation })).toString("base64url") : null, threadId: canonical, generation,
    publication: { published: messages.length, outsideLatest }, ...(root ? { root: messagePreview(root), replyCount: replies.get(root.id)?.count ?? 0 } : {}) };
}

/** Pair calls/results before paging; no page can manufacture an unmatched tool result. */
export function activityPage(activity: ParticipantActivity, before?: number): ActivityPage {
  const tools = toolActivities(activity.entries, activity.live);
  const blocks: ActivityBlock[] = [];
  const rendered = new Set<ToolActivity>();
  const append = (tool: ToolActivity | null | undefined, id: string) => {
    if (!tool || rendered.has(tool)) return;
    rendered.add(tool); blocks.push({ id, kind: "tool", tool });
  };
  const message = (value: Message, id: string) => {
    if (value.role === "toolResult") append(tools.results.get(value), id);
    else if (value.role === "assistant") {
      const text = value.content.filter(part => part.type === "text").map(part => part.text).join("\n\n");
      if (text && !tools.echoes.has(value)) blocks.push({ id: `${id}:text`, kind: "text", text });
      for (const part of value.content) if (part.type === "toolCall") append(tools.calls.get(part), `${id}:${part.id}`);
    }
  };
  for (const entry of activity.entries) {
    if (entry.model?.length) entry.model.forEach((value, index) => message(value, `${entry.id}:${index}`));
    else blocks.push({ id: String(entry.id), kind: "event", label: entry.kind === "pi.compaction" ? "Agent working context summarized" : entry.kind === "pi.reset" ? "Agent working context started" : "Agent event", data: entry.data });
  }
  if (activity.live.generation?.message) message(activity.live.generation.message as Message, "live");
  tools.extra.forEach((tool, index) => append(tool, `live:${index}`));
  let index = Math.min(before ?? blocks.length, blocks.length) - 1;
  const items: ActivityBlock[] = [];
  for (; index >= 0 && items.length < 20; index--) {
    const block = blocks[index]!;
    const item: ActivityBlock = bytes(block) <= ITEM_BYTES ? block : { id: block.id, kind: "large", label: block.kind === "tool" ? `${block.tool.name} · large output` : "Large activity record" };
    const candidate = { items: [item, ...items], before: index || null, total: blocks.length };
    if (bytes(candidate) > PAGE_BYTES) break;
    items.unshift(item);
  }
  return { items, before: index >= 0 ? index + 1 : null, total: blocks.length };
}

/** Existing public metadata only: main and thread cutoffs are independent; reading never changes them. */
export function mentionsPage(messages: ConversationMessage[], participantId: string, before?: string, generation = ""): TranscriptPage {
  const lastReply = new Map<string | null, number>();
  for (const [index, message] of messages.entries()) if (message.authorId === participantId && message.kind === "message") lastReply.set(message.threadId, index);
  const newer = new Set<string>();
  const threads = new Map<string, string | null>();
  const mentioned = messages.flatMap((message, index) => {
    if (message.kind !== "message" || !message.mentions.includes(participantId)) return [];
    if (index > (lastReply.get(message.threadId) ?? -1)) newer.add(message.id);
    threads.set(message.id, message.threadId);
    // Compact previews avoid inline images/attachments; preserve only navigation and public attribution.
    return [{ id: message.id, kind: message.kind, authorId: message.authorId, createdAt: message.createdAt,
      threadId: null, mentions: [participantId], text: message.text.slice(0, 280), truncated: message.text.length > 280 }];
  });
  const page = transcriptPage(mentioned, [], { before }, generation);
  return { ...page, messages: page.messages.map(message => ({ ...message, threadId: threads.get(message.id)! })),
    mentionSummary: { total: mentioned.length, newCount: newer.size, newIds: page.messages.filter(message => newer.has(message.id)).map(message => message.id) } };
}
