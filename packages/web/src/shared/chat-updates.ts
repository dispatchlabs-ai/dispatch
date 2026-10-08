import type { ChatSnapshot } from "./contracts.js";

/** Deltas are relative to the last delivered snapshot on this connection. */
export interface ChatDelta {
  baseRevision: number;
  snapshot: Omit<ChatSnapshot, "messages" | "activities" | "participants"> & { participants?: ChatSnapshot["participants"] };
  messages: ChatSnapshot["messages"];
  activities: ChatSnapshot["activities"];
  removedMessages: string[];
  removedActivities: string[];
}

function difference<T extends { id: string }>(before: readonly T[], after: readonly T[]) {
  const prior = new Map(before.map(item => [item.id, item]));
  const ids = new Set(after.map(item => item.id));
  return {
    changed: after.filter(item => !prior.has(item.id) || JSON.stringify(prior.get(item.id)) !== JSON.stringify(item)),
    removed: before.filter(item => !ids.has(item.id)).map(item => item.id),
  };
}

export function chatDelta(before: ChatSnapshot, after: ChatSnapshot): ChatDelta {
  const { messages, activities, participants, ...metadata } = after;
  const snapshot = { ...metadata, ...(JSON.stringify(before.participants) === JSON.stringify(participants) ? {} : { participants }) };
  const m = difference(before.messages, messages);
  const a = difference(before.activities, activities);
  return { baseRevision: before.conversation.revision, snapshot, messages: m.changed, activities: a.changed, removedMessages: m.removed, removedActivities: a.removed };
}

function apply<T extends { id: string; createdAt: number }>(before: T[], changed: T[], removed: string[]) {
  if (!changed.length && !removed.length) return before;
  const values = new Map(before.map(item => [item.id, item]));
  for (const id of removed) values.delete(id);
  for (const item of changed) values.set(item.id, item);
  return [...values.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function applyChatDelta(before: ChatSnapshot, delta: ChatDelta): ChatSnapshot {
  if (before.conversation.id !== delta.snapshot.conversation.id || before.conversation.revision !== delta.baseRevision) throw new Error("Chat update gap");
  return { ...delta.snapshot, participants: delta.snapshot.participants ?? before.participants, messages: apply(before.messages, delta.messages, delta.removedMessages), activities: apply(before.activities, delta.activities, delta.removedActivities) };
}

/** HTTP mutations and reconnect resets also preserve unchanged row identities. */
export function reconcileChat(before: ChatSnapshot | undefined, after: ChatSnapshot): ChatSnapshot {
  if (!before) return after;
  if (before.conversation.revision > after.conversation.revision) return before;
  const reuse = <T extends { id: string }>(old: T[], next: T[]) => {
    const prior = new Map(old.map(item => [item.id, item]));
    let same = old.length === next.length;
    const result = next.map((item, i) => {
      const previous = prior.get(item.id);
      const value = previous && JSON.stringify(previous) === JSON.stringify(item) ? previous : item;
      if (value !== old[i]) same = false;
      return value;
    });
    return same ? old : result;
  };
  return { ...after, messages: reuse(before.messages, after.messages), activities: reuse(before.activities, after.activities), participants: reuse(before.participants, after.participants) };
}
