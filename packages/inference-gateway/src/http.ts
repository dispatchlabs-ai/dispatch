import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./config.js";

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "json_required");
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new HttpError(415, "content_encoding_not_supported");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32 * 1024 * 1024) throw new HttpError(413, "request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  try { return JSON.parse(body.toString()); } catch { throw new HttpError(400, "invalid_json"); }
}

export function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
