import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { z } from "zod";
import { tokenHash } from "./access-store.js";
import { HttpError, type GatewayConfig, type Principal } from "./config.js";
import { connectionModel, type Connection } from "./engine.js";
import { json } from "./http.js";
import type { RequestUsage } from "./usage.js";

// Preserve native Responses items and events. No provider URL, credential, stored-response
// reference, remote tool server, or transport override is accepted from the caller.
const tool = z.object({ type: z.enum(["function", "custom", "namespace", "tool_search"]), name: z.string().optional() }).passthrough();
const inputItem = z.object({ type: z.string().optional(), role: z.string().optional() }).passthrough();
const requestSchema = z.object({
  model: z.string().min(1), input: z.union([z.string(), z.array(inputItem)]),
  instructions: z.string().nullable().optional(), stream: z.boolean().default(true),
  store: z.literal(false).optional(), previous_response_id: z.null().optional(), background: z.literal(false).optional(),
  tools: z.array(tool).optional(), tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  parallel_tool_calls: z.boolean().optional(), reasoning: z.record(z.string(), z.unknown()).optional(),
  text: z.record(z.string(), z.unknown()).optional(), include: z.array(z.string()).optional(),
  max_output_tokens: z.number().int().positive().optional(), temperature: z.number().optional(), top_p: z.number().optional(),
  service_tier: z.string().optional(), truncation: z.enum(["auto", "disabled"]).optional(),
  metadata: z.record(z.string(), z.string()).optional(), client_metadata: z.record(z.string(), z.string()).optional(),
  prompt_cache_key: z.string().optional(), prompt_cache_retention: z.string().optional(),
  safety_identifier: z.string().optional(), stream_options: z.record(z.string(), z.unknown()).optional(),
}).strict();
type Event = { type: string; response?: Record<string, unknown>; [key: string]: unknown };
const terminal = new Set(["response.completed", "response.incomplete", "response.failed", "response.done"]);
const supported = new Set(["openai-responses", "openai-codex-responses"]);
const inputTypes = new Set(["message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "reasoning", "additional_tools", "compaction", "tool_search_call", "tool_search_output"]);

function validateTools(tools: unknown[]) {
  for (const value of tools) {
    const parsed = tool.safeParse(value);
    if (!parsed.success) throw new HttpError(400, "unsupported_tool");
    if (parsed.data.type === "tool_search" && parsed.data.execution !== "client") throw new HttpError(400, "client_tool_search_required");
    if (parsed.data.type === "namespace") {
      if (!Array.isArray(parsed.data.tools)) throw new HttpError(400, "invalid_tool_namespace");
      validateTools(parsed.data.tools);
    }
  }
}

function validateContent(value: unknown) {
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (!part || typeof part !== "object") throw new HttpError(400, "invalid_input_content");
    if ("file_id" in part || "upload_id" in part) throw new HttpError(400, "inline_file_content_required");
  }
}

export function responsesRequest(value: unknown, connections: Map<string, Connection>, principal: Principal, aliases: GatewayConfig["responsesAliases"]) {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "unsupported_responses_request");
  const body = parsed.data;
  const slash = body.model.indexOf("/");
  const alias = aliases[body.model];
  if (!alias && slash < 1) throw new HttpError(404, "model_route_not_found");
  const connectionId = alias?.connection ?? body.model.slice(0, slash);
  const resolved = connectionModel(connections, principal, connectionId, alias?.model ?? body.model.slice(slash + 1));
  const model = resolved.model as Model<string>;
  if (!supported.has(model.api)) throw new HttpError(400, "responses_not_supported_for_model");
  validateTools(body.tools ?? []);
  if (Array.isArray(body.input)) for (const item of body.input) {
    if (item.type && !inputTypes.has(item.type)) throw new HttpError(400, "unsupported_input_item");
    validateContent(item.content);
    validateContent(item.output);
    if (item.type === "additional_tools") {
      if (!Array.isArray(item.tools)) throw new HttpError(400, "invalid_additional_tools");
      validateTools(item.tools);
    }
  }
  return { body, connectionId, connection: resolved.connection, model };
}

export async function serveResponses(request: IncomingMessage, response: ServerResponse, resolved: ReturnType<typeof responsesRequest>, principal: Principal, requestId: string, controller: AbortController, accounting: RequestUsage, warnings: string[]) {
  const { body, model, connection, connectionId } = resolved;
  const signal = controller.signal;
  let final: AssistantMessage | undefined;
  let finalEvent: Event | undefined;
  let providerStatus: number | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const headers = { "x-dispatch-connection": connectionId, "x-dispatch-model": model.id, ...(warnings.length ? { "x-dispatch-budget-warning": warnings.join(",") } : {}) };
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  const send = async (event: Event) => {
    signal.throwIfAborted();
    if (!body.stream) return;
    if (!response.headersSent) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
      response.flushHeaders();
      heartbeat = setInterval(() => { if (!response.writableNeedDrain) response.write(": heartbeat\n\n"); }, 15_000);
    }
    const publicEvent = event.response ? { ...event, response: { ...event.response, model: body.model } } : event;
    if (!response.write(`event: ${event.type}\ndata: ${JSON.stringify(publicEvent)}\n\n`)) await once(response, "drain", { signal });
  };
  const sessionId = tokenHash(`${principal.id}:${principal.clientId}:${String(request.headers.session_id ?? body.prompt_cache_key ?? requestId)}`);
  try {
    const stream = connection.models.stream(model, { messages: [] }, {
      signal, transport: "sse", sessionId, maxRetries: 0,
      fetch: async (input, init) => { const upstream = await fetch(input, init); providerStatus = upstream.status; return upstream; },
      onPayload: (native) => ({ ...(native as Record<string, unknown>), ...body, model: model.id, input: body.input, stream: true, store: false, background: false,
        // Codex client telemetry is not a provider inference option or an authorization input.
        client_metadata: undefined, previous_response_id: undefined, prompt_cache_key: sessionId, safety_identifier: tokenHash(principal.id) }),
      onResponse: (upstream) => { providerStatus = upstream.status; },
      onProviderStreamEvent: async (value) => {
        if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") throw new Error("Invalid provider event");
        const event = value as Event;
        if (terminal.has(event.type)) finalEvent = event.type === "response.done" ? { ...event, type: event.response?.status === "incomplete" ? "response.incomplete" : event.response?.status === "failed" ? "response.failed" : "response.completed" } : event;
        else if (event.type === "error") throw new Error("Provider stream failed");
        else await send(event);
      },
    });
    for await (const event of stream) {
      if (event.type === "done") final = event.message;
      if (event.type === "error") { final = event.error; break; }
    }
    if (!final || !finalEvent || finalEvent.type === "response.failed" || ["error", "aborted", "pending"].includes(final.stopReason)) {
      await accounting.finish(signal.aborted ? "aborted" : "error", final?.usage);
      throw new HttpError(providerStatus === 429 ? 429 : 502, providerStatus === 429 ? "provider_rate_limited" : "provider_request_failed");
    }
    await accounting.finish(final.stopReason, final.usage);
    if (body.stream) { await send(finalEvent); response.end(); }
    else json(response, 200, { ...finalEvent.response, model: body.model });
  } catch (error) {
    await accounting.finish(signal.aborted ? "aborted" : "error", final?.usage);
    if (!response.headersSent || response.destroyed || signal.aborted) throw error;
    const code = error instanceof HttpError ? error.code : "gateway_request_failed";
    await send({ type: "response.failed", response: { id: finalEvent?.response?.id ?? `resp_${requestId.replaceAll("-", "")}`, object: "response", status: "failed", output: [], error: { code, message: `${code} (request ${requestId})` } } });
    response.end();
  } finally { if (heartbeat) clearInterval(heartbeat); controller.abort(); }
}

export const supportsResponses = (api: string) => supported.has(api);
