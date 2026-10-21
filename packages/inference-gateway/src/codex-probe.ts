/** Temporary Responses endpoint for a Codex desktop coding experiment. */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { z } from "zod";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { awsGatewayAuthorization } from "./aws.js";
import { createGatewayModels } from "./client.js";
import { probeContext, probeOutput, probeRequestSchema } from "./codex-probe-protocol.js";

const url = process.env.DISPATCH_INFERENCE_GATEWAY_URL;
const tokenFile = process.env.CODEX_GATEWAY_PROBE_TOKEN_FILE;
if (!url || !tokenFile) throw new Error("Set DISPATCH_INFERENCE_GATEWAY_URL and CODEX_GATEWAY_PROBE_TOKEN_FILE");
const token = readFileSync(tokenFile, "utf8").trim();
if (token.length < 32) throw new Error("The probe requires a random local token of at least 32 characters");
const authorization = Buffer.from(`Bearer ${token}`);
const connection = process.env.CODEX_GATEWAY_PROBE_CONNECTION ?? "openai";
const modelId = process.env.CODEX_GATEWAY_PROBE_MODEL ?? "gpt-6-astra";
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? "8789");
const models = await createGatewayModels({ url, authorize: awsGatewayAuthorization(url) });
const model = models.getModel(connection, modelId);
if (!model) throw new Error("The selected model is absent from the authorized gateway catalog");

const server = createServer(async (request, response) => {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
    response.writeHead(401).end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  const requestId = randomUUID();
  const responseId = `resp_${requestId.replaceAll("-", "")}`;
  const controller = new AbortController();
  response.on("close", () => { if (!response.writableEnded) controller.abort(); });
  let gatewayRequestId: string | undefined;
  let sequence = 0;
  const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  const audit = (status: string, extra: object = {}) => console.log(JSON.stringify({
    event: "codex_gateway_probe", timestamp: new Date().toISOString(), requestId, gatewayRequestId, connection, model: modelId,
    sessionId: request.headers.session_id, status, ...extra,
  }));
  try {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) throw new Error("request_too_large");
      chunks.push(Buffer.from(chunk));
    }
    const body = probeRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (body.model !== modelId) throw new Error("unknown_probe_model");
    const translated = probeContext(body, model);
    audit("accepted", translated.counts);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-request-id": requestId });
    const base = { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: modelId };
    emit("response.created", { response: { ...base, status: "in_progress", output: [] } });
    const output = probeOutput(emit, translated.definitions);
    const stream = models.stream(model, translated.context, {
      signal: controller.signal, reasoningEffort: body.reasoning?.effort, reasoningSummary: body.reasoning?.summary,
      maxTokens: body.max_output_tokens, textVerbosity: body.text?.verbosity,
      toolChoice: body.tool_choice ?? "auto", maxRetries: 0, transport: "sse", sessionId: String(request.headers.session_id ?? requestId),
      onResponse: ({ headers }) => { gatewayRequestId = headers["x-request-id"]; },
    });
    let final: AssistantMessage | undefined;
    for await (const event of stream) {
      output.consume(event);
      if (event.type === "done") final = event.message;
      else if (event.type === "error") throw new Error("gateway_inference_failed");
    }
    if (!final || !["stop", "toolUse"].includes(final.stopReason)) throw new Error("incomplete_probe_response");
    const usage = { input_tokens: final.usage.input + final.usage.cacheRead + final.usage.cacheWrite, output_tokens: final.usage.output,
      total_tokens: final.usage.totalTokens, input_tokens_details: { cached_tokens: final.usage.cacheRead },
      output_tokens_details: { reasoning_tokens: final.usage.reasoning ?? 0 } };
    emit("response.completed", { response: { ...base, status: "completed", output: output.output, usage } });
    response.end();
    audit("completed", { usage, reasoningEffort: body.reasoning?.effort, stopReason: final.stopReason,
      toolCalls: output.output.filter((item) => item.type.endsWith("tool_call") || item.type === "function_call").length });
  } catch (error) {
    const code = error instanceof z.ZodError || error instanceof SyntaxError ? "unsupported_probe_request" : "probe_failed";
    if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code, message: code } }));
    else if (!response.destroyed) {
      emit("response.failed", { response: { id: responseId, object: "response", status: "failed", output: [], error: { code, message: code } } });
      response.end();
    }
    audit(controller.signal.aborted ? "cancelled" : code, {
      errorType: error instanceof Error ? error.name : "unknown", reason: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : undefined, encoding: request.headers["content-encoding"],
      ...(error instanceof z.ZodError ? { fields: error.issues.map((issue) => ({ path: issue.path, code: issue.code })) } : {}),
    });
  }
});
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ event: "codex_gateway_probe_ready", port, url, connection, model: modelId, tools: true })));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
