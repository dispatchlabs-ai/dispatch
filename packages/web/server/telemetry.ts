import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { AWSXRayIdGenerator } from "@opentelemetry/id-generator-aws-xray";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

// Explicit service instrumentation only: no SQL, model/tool payloads, URLs,
// headers, exception text, environment discovery or durable Pi trace export.
const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const service = process.env.OTEL_SERVICE_NAME ?? "dispatch";
let provider: NodeTracerProvider | undefined;
if (endpoint) {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new Error("Invalid service telemetry configuration."); }
  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? "0.1");
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    || url.username || url.password || url.search || url.hash || !Number.isFinite(ratio) || ratio < 0 || ratio > 1
    || !/^[a-zA-Z0-9_.-]{1,80}$/.test(service)) throw new Error("Invalid service telemetry configuration.");
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": service }),
    idGenerator: new AWSXRayIdGenerator(),
    // Do not let an incoming sampled flag force collection beyond our local policy.
    sampler: new TraceIdRatioBasedSampler(ratio),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint, timeoutMillis: 2000 }), {
      maxQueueSize: 2048, maxExportBatchSize: 256, scheduledDelayMillis: 5000, exportTimeoutMillis: 3000,
    })],
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });
}
const tracer = trace.getTracer("dispatch-http");
const methodName = (method: string) => ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER";

/** Records response-header latency; never reads/wraps a response body or SSE stream. */
export function httpTelemetry(): MiddlewareHandler {
  return async (c, next) => {
    if (!provider || ["/internal/ready", "/internal/health", "/ready"].includes(c.req.path)) return next();
    const active = context.active();
    // The rolling listener can dispatch into an owner app in the same process.
    // Retain that local parent; only extract a traceparent at the network boundary.
    const localParent = trace.getSpan(active);
    const parent = localParent ? active : propagation.extract(ROOT_CONTEXT, { traceparent: c.req.header("traceparent") });
    const method = methodName(c.req.method);
    const route = routePath(c, -1) || "unmatched";
    const started = performance.now();
    return tracer.startActiveSpan(`${method} ${route}`, {
      kind: localParent ? SpanKind.INTERNAL : SpanKind.SERVER,
      attributes: { "http.request.method": method, "http.route": route, "dispatch.http.phase": "response_headers" },
    }, parent, async span => {
      let status = 500;
      try {
        await next();
        status = c.res.status;
        span.setAttribute("http.response.status_code", status);
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        // Log sampled requests and server failures; health polling stays silent.
        // Registered route templates, not requested URLs or user identifiers.
        if (span.isRecording() || status >= 500) {
          const identity = span.spanContext();
          console.info(JSON.stringify({ timestamp: new Date().toISOString(), event: "http.response_headers", service,
            method, route, status, duration_ms: Math.round(performance.now() - started),
            trace_id: identity.traceId, span_id: identity.spanId }));
        }
        span.end();
      }
    });
  };
}

/** One callback invocation; tracing neither retries nor changes transport errors. */
export function tracedRequest<T>(name: "worker.request" | "controller.request", method: string,
  send: (headers: Record<string, string>, span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { kind: SpanKind.CLIENT,
    attributes: { "http.request.method": methodName(method) } }, async span => {
    const headers: Record<string, string> = {};
    if (provider) propagation.inject(context.active(), headers);
    try { return await send(headers, span); }
    catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
    finally { span.end(); }
  });
}

/** Best-effort bounded export only after the application has joined its owners. */
export async function closeTelemetry(): Promise<void> {
  try { await provider?.shutdown(); }
  catch { console.warn("Telemetry shutdown incomplete"); }
}
