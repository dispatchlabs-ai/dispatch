import type { EntryRecord, LiveState, TaskRecord } from "@earendil-works/pi-durable";

export interface ChatToolCall {
  id: string;
  callId: string;
  entryId: number;
  turnId: string;
  name: string;
  input?: unknown;
  output?: unknown;
  details?: unknown;
  progress?: unknown;
  status: "running" | "pending" | "waiting" | "completed" | "failed" | "cancelled" | "unavailable";
  afterMessageId: string;
  parentCallId?: string;
  taskId?: number;
}

/** Native call/result identities, never inferred from assistant narration.
 * Missing results do not establish success or cancellation. */
export function projectChatTools(
  entries: readonly EntryRecord[],
  live?: Pick<LiveState, "tools">,
  tasks: readonly TaskRecord<unknown, unknown, unknown>[] = [],
): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  let turnId = "initial";
  for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
    const data = entry.data as { source?: string; diagnostics?: { code?: string }[] } | undefined;
    for (const [index, message] of (entry.model ?? []).entries()) {
      if (message.role === "user" && /\.message$/.test(entry.kind) &&
        ["web", "cli", "slack", "google-chat", "phone", "email"].includes(data?.source ?? "")) turnId = String(entry.id);
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) if (block.type === "toolCall") calls.push({
          id: `${entry.id}:${block.id}`, callId: block.id, entryId: entry.id, turnId,
          name: block.name, input: block.arguments, status: "unavailable", afterMessageId: `${entry.id}:${index}`,
        });
      }
      if (message.role === "toolResult") {
        const call = calls.findLast(call => call.callId === message.toolCallId && call.output === undefined);
        if (call) {
          call.status = data?.diagnostics?.some(diagnostic => diagnostic.code === "aborted")
            ? "cancelled" : message.isError ? "failed" : "completed";
          call.output = message.content;
          call.details = message.details;
        }
      }
    }
  }
  for (const slot of live?.tools ?? []) {
    const call = calls.findLast(call => call.callId === slot.callId);
    if (call && call.output === undefined) {
      call.status = slot.status === "running" ? "running" : slot.status === "pending" ? "pending" : "unavailable";
      if (slot.output) call.progress = slot.output;
    }
  }
  for (const task of tasks) {
    if (task.kind !== "pi.tool") continue;
    const input = task.input as {kind?: string; callId?: string; parentCallId?: string; assistant?: number; call?: {id: string; name: string; arguments: unknown}};
    let call = calls.findLast(call => call.callId === (input.callId ?? input.call?.id));
    if (!call && input.kind === "nested" && input.call) {
      const parent = calls.findLast(call => call.callId === input.parentCallId);
      if (parent) {
        call = {id:`task:${task.id}:${input.call.id}`, callId:input.call.id, entryId:parent.entryId, turnId:parent.turnId,
          name:input.call.name, input:input.call.arguments, status:"unavailable", afterMessageId:parent.afterMessageId, parentCallId:input.parentCallId};
        calls.push(call);
      }
    }
    if (!call || call.output !== undefined) continue;
    call.taskId = task.id;
    if (task.state.status === "running") call.status = "running";
    if (task.state.status === "pending") call.status = "pending";
    if (task.state.status === "waiting" || task.state.status === "sleeping") call.status = "waiting";
    if (task.state.status === "terminal" && task.state.outcome.status === "aborted") call.status = "cancelled";
  }
  return calls;
}
