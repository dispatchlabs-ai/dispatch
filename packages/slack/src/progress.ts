import { AssistantEntry, ToolTask, type LiveState, type TaskRuntime,
  type ToolTaskCheckpoint, type ToolTaskInput } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

/** Public wording selected by trusted host code, never raw tool output. */
export type SlackActivity = { label: string; subject?: string };
export type SlackToolCall = { name: string; arguments: Readonly<Record<string, unknown>> };
export type SlackToolDescription = (call: SlackToolCall) => SlackActivity | undefined;
type Reader = Pick<TaskRuntime<unknown, unknown, unknown, object>, "getTask" | "entry">;

const labels: Record<string, string> = {
  read: "Reading a file", write: "Writing a file", edit: "Editing a file",
  bash: "Running a workspace command", read_skill: "Reading task guidance",
};

/** Read the native execution intent, including repaired arguments and nested calls. */
export async function currentToolActivity(live: Readonly<LiveState>, reader: Reader,
  context: Context, describe?: SlackToolDescription): Promise<{ activity: SlackActivity; running: boolean } | undefined> {
  const slot = live.nestedTools?.findLast(tool => tool.status === "running")
    ?? live.tools?.find(tool => tool.status === "running")
    ?? live.nestedTools?.findLast(tool => tool.status === "done")
    ?? live.tools?.findLast(tool => tool.status === "done");
  if (!slot) return undefined;
  const fallback = { label: labels[slot.name] ?? "Using a connected tool" };
  const result = (activity = fallback) => ({ activity, running: slot.status === "running" });
  if (!describe || !slot.taskId) return result();
  const task = await reader.getTask(slot.taskId, context);
  if (!task || task.kind !== ToolTask.definition.name) return result();
  const input = task.input as ToolTaskInput;
  const checkpoint = "checkpoint" in task.state ? task.state.checkpoint as ToolTaskCheckpoint : undefined;
  let args: Record<string, unknown> | undefined;
  if (checkpoint?.phase === "execute") args = checkpoint.arguments;
  else if (input.kind === "nested") args = input.call.arguments;
  else {
    const entry = await reader.entry(AssistantEntry, input.assistant, context);
    const message = entry?.model?.[0];
    const call = message?.role === "assistant"
      ? message.content.find(part => part.type === "toolCall" && part.id === input.callId) : undefined;
    if (call?.type === "toolCall") args = call.arguments;
  }
  return result(args ? describe({ name: slot.name, arguments: args }) ?? fallback : fallback);
}

export function activityLabel(live: Readonly<LiveState>, current?: SlackActivity, previous?: SlackActivity) {
  if (live.generation?.retry) return "Retrying a model request";
  if (live.compactions?.some(task => task.blocking)) return "Organizing context";
  if (current) return [current.label, current.subject].filter(Boolean).join(": ");
  if (live.generation?.deferred) return "Waiting for the model";
  const writing = live.generation?.message?.content.some(part => part.type === "text" && part.text.trim());
  const label = writing ? "Preparing the answer" : previous ? "Reviewing results" : "Planning the next step";
  return [label, previous?.subject].filter(Boolean).join(": ");
}
