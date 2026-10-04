import type { Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { ToolResultEntry, type EntryRecord, type LiveState, type ToolDiagnostic, type ToolSlot } from "@earendil-works/pi-durable";

export interface ToolActivity {
  name: string;
  call?: ToolCall;
  result?: ToolResultMessage;
  resultEntryId?: EntryRecord["id"];
  diagnostics?: ToolDiagnostic[];
  live?: ToolSlot;
  preparing?: boolean;
}

export interface ToolActivities {
  calls: Map<ToolCall, ToolActivity>;
  results: Map<ToolResultMessage, ToolActivity | null>;
  extra: ToolActivity[];
}

// A presentation projection of native entries and live state, rebuilt on each snapshot.
// Pair with the nearest preceding call: providers can reuse IDs in later rounds.
export function toolActivities(entries: readonly EntryRecord[], live: LiveState): ToolActivities {
  const calls = new Map<ToolCall, ToolActivity>();
  const results = new Map<ToolResultMessage, ToolActivity | null>();
  const latest = new Map<string, ToolActivity>();
  const extra: ToolActivity[] = [];
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "assistant") {
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          const activity: ToolActivity = { name: part.name, call: part };
          calls.set(part, activity);
          latest.set(part.id, activity);
        }
      } else if (message.role === "toolResult") {
        const preceding = latest.get(message.toolCallId);
        const matched = preceding?.name === message.toolName && !preceding.result;
        const activity: ToolActivity = matched ? preceding : { name: message.toolName };
        activity.result = message;
        activity.resultEntryId = entry.id;
        activity.diagnostics = ToolResultEntry.is(entry) ? entry.data.diagnostics : undefined;
        results.set(message, matched ? null : activity);
      }
    }
  }
  for (const slot of live.tools ?? []) {
    const activity = latest.get(slot.callId);
    if (activity?.name === slot.name && (!activity.result || activity.resultEntryId === slot.entry)) {
      activity.live = slot;
    } else if (slot.status !== "done") {
      extra.push({ name: slot.name, live: slot });
    }
  }
  const generating = live.generation?.message as Message | undefined;
  if (generating?.role === "assistant") {
    for (const part of generating.content) {
      if (part.type === "toolCall") calls.set(part, { name: part.name, call: part, preparing: true });
    }
  }
  return { calls, results, extra };
}
