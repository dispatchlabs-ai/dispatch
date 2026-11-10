import type { Chat, Snapshot, SidebarSnapshot } from "./contracts.js";
import type { Runtime } from "./runtime.js";

export function snapshotActivity(value: Snapshot): NonNullable<Chat["activity"]> {
  if (value.activity) return value.activity;
  if (value.readOnly === "unavailable" || value.readOnlyReason?.includes("unavailable")) return "unavailable";
  if (value.retry || value.toolCalls?.some(call => call.status === "waiting") || value.toolCalls?.some(call => ["delegate", "clone_agent", "wait_for_agent"].includes(call.name) && ["running", "pending"].includes(call.status))) return "waiting";
  if (value.running || value.background || value.queued > 0) return "working";
  return value.turns?.at(-1)?.status === "unanswered" ? "unanswered" : "idle";
}

/** Compatibility for trusted runtimes without a lightweight native summary. */
export async function runtimeSummary(runtime: Runtime): Promise<SidebarSnapshot> {
  if (runtime.summary) return runtime.summary();
  const [agents, chats, sources] = await Promise.all([
    runtime.catalog?.() ?? Promise.resolve(runtime.service.agents), runtime.service.list(), runtime.service.sources(),
  ]);
  const observed: Chat[] = [];
  for (const chat of chats) {
    try { const value = await runtime.presentation.snapshot(chat.id); observed.push({ ...value.chat, activity: snapshotActivity(value) }); }
    catch { observed.push({ ...chat, activity: "unavailable" }); }
  }
  return { agents, chats: observed, sources };
}
