import type { Usage } from "@earendil-works/pi-ai";
import { UsageDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";

export async function recordModelUsage(tx: Tx, conversationId: ConversationId, model: string, value: Usage) {
  const totals = (await tx.doc(UsageDoc, conversationId)).models;
  const previous = Object.hasOwn(totals, model) ? totals[model] : undefined;
  if (!previous) { totals[model] = JSON.parse(JSON.stringify(value)); return; }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning", "cacheWrite1h"] as const) {
    if (value[key] !== undefined) previous[key] = (previous[key] ?? 0) + value[key];
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) previous.cost[key] += value.cost[key];
}
