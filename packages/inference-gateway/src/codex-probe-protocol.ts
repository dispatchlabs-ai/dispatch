/** Experimental Responses/Pi translation used only by the desktop qualification probe. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AssistantMessage, AssistantMessageEvent, Context, Message, Model, Tool } from "@earendil-works/pi-ai";

const jsonObject = z.record(z.string(), z.json());
const textPart = z.object({ type: z.enum(["input_text", "output_text", "text"]), text: z.string() });
const text = z.union([z.string(), z.array(textPart)]);
const toolSchema = z.object({
  type: z.enum(["function", "custom"]), name: z.string(), description: z.string().optional(),
  parameters: jsonObject.optional(), strict: z.boolean().nullable().optional(),
  format: z.union([z.object({ type: z.literal("text") }), z.object({
    type: z.literal("grammar"), syntax: z.enum(["lark", "regex"]), definition: z.string(),
  })]).optional(),
});
const toolsSchema = z.array(z.union([toolSchema, z.object({
  type: z.literal("namespace"), name: z.string(), description: z.string().optional(), tools: z.array(toolSchema),
})]));
const inputItem = z.union([
  z.object({ type: z.literal("message").optional(), id: z.string().optional(), phase: z.enum(["commentary", "final_answer"]).optional(),
    role: z.enum(["system", "developer", "user", "assistant"]), content: text }),
  z.object({ type: z.literal("additional_tools"), role: z.literal("developer"), tools: toolsSchema }),
  z.object({ type: z.literal("reasoning"), id: z.string(), encrypted_content: z.string().nullable().optional(),
    summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })).default([]) }).passthrough(),
  z.object({ type: z.literal("function_call"), id: z.string().optional(), call_id: z.string(), name: z.string(), namespace: z.string().optional(), arguments: z.string() }),
  z.object({ type: z.literal("custom_tool_call"), id: z.string().optional(), call_id: z.string(), name: z.string(), namespace: z.string().optional(), input: z.string() }),
  z.object({ type: z.enum(["function_call_output", "custom_tool_call_output"]), call_id: z.string(), output: text }),
]);
export const probeRequestSchema = z.object({
  model: z.string(), stream: z.literal(true), store: z.literal(false).optional(), instructions: z.string().optional(),
  input: z.union([z.string(), z.array(inputItem)]), tools: toolsSchema.optional(),
  reasoning: z.object({ effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    summary: z.enum(["auto", "concise", "detailed"]).optional() }).optional(),
  max_output_tokens: z.number().int().min(16).optional(), previous_response_id: z.null().optional(),
  tool_choice: z.enum(["auto", "none"]).optional(),
  text: z.object({ format: z.object({ type: z.literal("text") }).optional(), verbosity: z.enum(["low", "medium", "high"]).optional() }).optional(),
});
type ProbeRequest = z.infer<typeof probeRequestSchema>;
type ToolDefinition = z.infer<typeof toolSchema> & { namespace?: string };
type OutputItem = Record<string, unknown> & { id: string; type: string };
type Emit = (type: string, data: object) => void;
const emptyUsage: AssistantMessage["usage"] = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const plainText = (value: z.infer<typeof text>) => typeof value === "string" ? value : value.map((part) => part.text).join("\n");
const alias = (name: string, namespace?: string) => `t_${createHash("sha256").update(JSON.stringify([namespace, name])).digest("hex").slice(0, 24)}`;

export function probeContext(body: ProbeRequest, model: Model<string>) {
  const definitions = new Map<string, ToolDefinition>();
  const convertTools = (tools: z.infer<typeof toolsSchema>): Tool[] => tools.flatMap((entry) => {
    const entries = entry.type === "namespace" ? entry.tools.map((tool) => ({ ...tool, namespace: entry.name })) : [entry];
    return entries.map((entry): Tool => {
      const definition: ToolDefinition = entry;
      const name = alias(definition.name, definition.namespace);
      definitions.set(name, definition);
      const description = `${definition.namespace ? `${definition.namespace}.` : ""}${definition.name}\n${definition.description ?? ""}`;
      if (definition.type === "function") {
        if (!definition.parameters) throw new Error("missing_function_parameters");
        return { name, description, parameters: definition.parameters as Tool["parameters"],
          constrainedSampling: definition.strict ? { type: "json_schema", strict: "require" } : false };
      }
      const format = definition.format;
      return { name, description, parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
        constrainedSampling: { type: "grammar", variants: format?.type === "grammar"
          ? { [format.syntax === "lark" ? "openai_lark" : "openai_regex"]: format.definition }
          : { openai_regex: "[\\s\\S]*" } } };
    });
  });
  const tools = convertTools(body.tools ?? []);
  const messages: Message[] = [];
  const calls = new Map<string, { id: string; name: string }>();
  const appendAssistant = (block: AssistantMessage["content"][number]) => {
    const last = messages.at(-1);
    if (last?.role === "assistant") { last.content.push(block); return; }
    messages.push({ role: "assistant", content: [block], api: model.api, provider: model.provider, model: model.id,
      usage: emptyUsage, stopReason: "stop", timestamp: Date.now() });
  };
  const items = typeof body.input === "string" ? [{ role: "user" as const, content: body.input }] : body.input;
  for (const item of items) {
    if (item.type === "additional_tools") {
      messages.push({ role: "system", content: "", toolsAdded: convertTools(item.tools), timestamp: Date.now() });
    } else if (item.type === "reasoning") {
      appendAssistant({ type: "thinking", thinking: item.summary.map((part) => part.text).join("\n\n"), thinkingSignature: JSON.stringify(item) });
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const name = alias(item.name, item.namespace);
      const id = item.id ? `${item.call_id}|${item.id}` : item.call_id;
      const args = item.type === "function_call" ? jsonObject.parse(JSON.parse(item.arguments)) : { input: item.input };
      calls.set(item.call_id, { id, name });
      appendAssistant({ type: "toolCall", id, name, arguments: args });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const call = calls.get(item.call_id);
      if (!call) throw new Error("orphan_tool_result");
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: [{ type: "text", text: plainText(item.output) }], isError: false, timestamp: Date.now() });
    } else if ("role" in item && "content" in item) {
      const content = plainText(item.content);
      if (item.role === "assistant") {
        appendAssistant({ type: "text", text: content, ...(item.id ? { textSignature: JSON.stringify({ v: 1, id: item.id, phase: item.phase }) } : {}) });
      } else messages.push({ role: item.role === "user" ? "user" : "system", content, timestamp: Date.now() });
    }
  }
  const context: Context = { systemPrompt: body.instructions, tools, messages };
  return { context, definitions, counts: {
    inputItems: items.length, toolDefinitions: definitions.size, toolResults: messages.filter((m) => m.role === "toolResult").length,
    reasoningItems: items.filter((item) => item.type === "reasoning").length,
  } };
}

/** Text is streamed immediately; tool calls retain their native call and item IDs. */
export function probeOutput(emit: Emit, definitions: Map<string, ToolDefinition>) {
  const output: OutputItem[] = [];
  const add = (index: number, item: OutputItem) => { output[index] = item; emit("response.output_item.added", { output_index: index, item }); };
  const done = (index: number, item: OutputItem) => { output[index] = item; emit("response.output_item.done", { output_index: index, item }); };
  const consume = (event: AssistantMessageEvent) => {
    if (!("contentIndex" in event)) return;
    const index = event.contentIndex;
    const block = event.partial.content[index];
    if (event.type === "text_start") {
      const item = { id: `msg_${randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", status: "in_progress", content: [] };
      add(index, item);
      emit("response.content_part.added", { output_index: index, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    } else if (event.type === "text_delta") {
      emit("response.output_text.delta", { output_index: index, item_id: output[index].id, content_index: 0, delta: event.delta });
    } else if (event.type === "text_end" && block.type === "text") {
      const item = output[index];
      const signature = block.textSignature ? JSON.parse(block.textSignature) as { phase?: string } : undefined;
      const part = { type: "output_text", text: event.content, annotations: [] };
      emit("response.output_text.done", { output_index: index, item_id: item.id, content_index: 0, text: event.content });
      emit("response.content_part.done", { output_index: index, item_id: item.id, content_index: 0, part });
      done(index, { ...item, status: "completed", content: [part], phase: signature?.phase });
    } else if (event.type === "thinking_end" && block.type === "thinking") {
      if (!block.thinkingSignature) throw new Error("missing_reasoning_signature");
      const item = JSON.parse(block.thinkingSignature) as OutputItem;
      add(index, { id: item.id, type: "reasoning", summary: [] });
      done(index, item);
    } else if (event.type === "toolcall_start" && block.type === "toolCall") {
      const definition = definitions.get(block.name);
      if (!definition) throw new Error("unknown_tool_call");
      const [callId, id] = block.id.split("|");
      if (!id) throw new Error("missing_tool_item_id");
      add(index, { id, type: definition.type === "custom" ? "custom_tool_call" : "function_call", call_id: callId,
        name: definition.name, namespace: definition.namespace, status: "in_progress",
        ...(definition.type === "custom" ? { input: "" } : { arguments: "" }) });
    } else if (event.type === "toolcall_delta" && block.type === "toolCall") {
      const item = output[index];
      if (item.type === "custom_tool_call") {
        const input = z.string().parse(block.arguments.input);
        const prior = z.string().parse(item.input);
        emit("response.custom_tool_call_input.delta", { output_index: index, item_id: item.id, delta: input.slice(prior.length) });
        item.input = input;
      } else {
        emit("response.function_call_arguments.delta", { output_index: index, item_id: item.id, delta: event.delta });
        item.arguments = String(item.arguments) + event.delta;
      }
    } else if (event.type === "toolcall_end") {
      if (event.toolCall.argumentsError) throw new Error("invalid_tool_arguments");
      const item = output[index];
      if (item.type === "custom_tool_call") {
        item.input = z.string().parse(event.toolCall.arguments.input);
        emit("response.custom_tool_call_input.done", { output_index: index, item_id: item.id, input: item.input });
      } else {
        item.arguments = JSON.stringify(event.toolCall.arguments);
        emit("response.function_call_arguments.done", { output_index: index, item_id: item.id, arguments: item.arguments });
      }
      done(index, { ...item, status: "completed" });
    }
  };
  return { consume, output };
}
