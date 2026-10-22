import type { Activity } from "./contracts";

// Match the nearest preceding call in the same conversation, including across pages.
// Copy tool objects so a newer observation cannot change a paused snapshot.
export function reconcileActivities(activities: Activity[]): Activity[] {
  const calls = new Map<string, Activity>();
  return activities.map((activity) => {
    if (!activity.tool) return activity;
    const item = { ...activity, tool: { ...activity.tool } };
    const key = `${item.conversationId}:${item.tool.callId}`;
    if (item.tool.phase === "call") calls.set(key, item);
    else {
      const call = calls.get(key);
      if (call?.tool) {
        Object.assign(call.tool, {
          result: item.tool.result,
          error: item.tool.error,
          durationMs: item.tool.durationMs,
          truncated: item.tool.truncated,
          missing: false,
          live: undefined,
        });
        item.tool.arguments = call.tool.arguments;
      }
      calls.delete(key);
    }
    return item;
  });
}
