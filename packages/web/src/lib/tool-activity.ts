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
  echoes: Set<Message>;
}

export function toolOutput(activity: ToolActivity): string {
  if (!activity.result) return activity.live?.output ?? "";
  const content = activity.result.content;
  const diagnostics = activity.diagnostics ?? [];
  // Pi appends this exact block to model context; presenters show diagnostics separately.
  const diagnosticText = `<harness>\n${diagnostics.map(item => `[${item.severity}] ${item.message}`).join("\n")}\n</harness>`;
  return content.filter((part, index) => !(diagnostics.length && index === content.length - 1 && part.type === "text" && part.text === diagnosticText)).filter(part => part.type === "text").map(part => part.text).join("\n");
}

function onlyRepeatsOutput(message: Message, output: string): boolean {
  if (!output.trim() || message.role !== "assistant" || message.stopReason !== "stop" || message.content.some(part => part.type !== "text")) return false;
  const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n\n").trim();
  const fenced = text.match(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1$/);
  return (fenced?.[2] ?? text).trim() === output.trim();
}

// A presentation projection of native entries and live state, rebuilt on each snapshot.
// Pair with the nearest preceding call: providers can reuse IDs in later rounds.
export function toolActivities(entries: readonly EntryRecord[], live: LiveState): ToolActivities {
  const calls = new Map<ToolCall, ToolActivity>();
  const results = new Map<ToolResultMessage, ToolActivity | null>();
  const latest = new Map<string, ToolActivity>();
  const extra: ToolActivity[] = [];
  const echoes = new Set<Message>();
  let previousOutput = "";
  for (const entry of entries) {
    const contextBoundary = entry.kind === "pi.reset" || entry.kind === "pi.compaction";
    if (contextBoundary) previousOutput = "";
    for (const message of entry.model ?? []) {
      if (message.role === "assistant") {
        if (onlyRepeatsOutput(message, previousOutput)) echoes.add(message);
        else previousOutput = "";
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
        previousOutput = activity.name === "bash" ? toolOutput(activity) : "";
      } else {
        previousOutput = "";
      }
    }
    if (contextBoundary) previousOutput = "";
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
  return { calls, results, extra, echoes };
}
