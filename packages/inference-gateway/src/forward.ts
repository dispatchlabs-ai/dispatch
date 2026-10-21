import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { HttpError } from "./config.js";

/** Forward once to a verified ECS task; the owner independently authenticates the bearer. */
export async function forward(request: IncomingMessage, response: ServerResponse, address: string, port: number, path: string, body: Buffer | undefined, signal: AbortSignal) {
  if (request.headers["x-dispatch-peer"]) throw new HttpError(503, "provider_owner_unavailable");
  const upstream = httpRequest({
    hostname: address, port, path, method: request.method, signal,
    headers: { authorization: request.headers.authorization!, "x-dispatch-peer": "1", ...(typeof request.headers.session_id === "string" ? { session_id: request.headers.session_id } : {}), ...(body ? { "content-type": "application/json", "content-length": body.length } : {}) },
  });
  const received = new Promise<IncomingMessage>((resolve, reject) => {
    upstream.once("response", resolve);
    upstream.once("error", reject);
  });
  const timeout = setTimeout(() => upstream.destroy(new HttpError(504, "peer_response_timeout")), 120_000);
  upstream.end(body);
  const result = await received.finally(() => clearTimeout(timeout));
  const status = result.statusCode ?? 502;
  if (status >= 300 && status < 400) { result.destroy(); throw new HttpError(502, "unexpected_peer_redirect"); }
  response.writeHead(status, {
    "content-type": result.headers["content-type"] ?? "application/json",
    "cache-control": "no-store",
    ...(result.headers["x-request-id"] ? { "x-request-id": result.headers["x-request-id"] } : {}),
    ...Object.fromEntries(["x-dispatch-connection", "x-dispatch-model", "x-dispatch-budget-warning"].flatMap((name) => result.headers[name] ? [[name, result.headers[name]!]] : [])),
  });
  response.flushHeaders();
  await pipeline(result, response, { signal });
}
