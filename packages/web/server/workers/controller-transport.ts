import { tracedRequest } from "../telemetry.js";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/** One dispatch, raw streaming bytes, no redirects/retries. TLS trust and expected
 * DNS identity are per role; direct task IPs never disable certificate checking. */
export async function controllerRequest(url: URL, options: {
  method: string; headers: Headers; body?: ReadableStream<Uint8Array> | null;
  signal: AbortSignal; tls?: { ca: string; servername: string };
}): Promise<Response> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid controller endpoint.");
  if (options.tls && url.protocol !== "https:") throw new Error("Controller TLS cannot fall back to plaintext.");
  return tracedRequest("controller.request", options.method, (traceHeaders, span) => new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    options.headers.forEach((value, key) => { headers[key] = value; });
    delete headers.traceparent;
    delete headers.tracestate;
    delete headers.baggage;
    Object.assign(headers, traceHeaders);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, { method: options.method, headers, signal: options.signal,
      ...(url.protocol === "https:" ? { rejectUnauthorized: true, minVersion: "TLSv1.2",
        ...(options.tls ?? {}) } : {}) }, incoming => {
      const responseHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2)
        responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      for (const name of ["connection", "keep-alive", "transfer-encoding", "trailer", "upgrade"]) responseHeaders.delete(name);
      const status = incoming.statusCode ?? 503;
      span.setAttribute("http.response.status_code", status);
      const noBody = options.method === "HEAD" || [204, 205, 304].includes(status);
      if (noBody) incoming.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
        { status, statusText: incoming.statusMessage, headers: responseHeaders }));
    });
    request.on("error", reject);
    if (options.body) {
      const body = Readable.fromWeb(options.body as import("node:stream/web").ReadableStream<Uint8Array>);
      body.on("error", () => request.destroy(new Error("Controller request body interrupted.")));
      request.on("close", () => body.destroy());
      body.pipe(request);
    } else request.end();
  }));
}
