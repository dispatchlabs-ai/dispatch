#!/usr/bin/env node
import { observeSidebar } from "./sidebar.js";
import { loadAvatars } from "./avatars.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readClientConnection } from "@dispatch/runner/client";
import {
  openRuntime,
  withConversationTitles,
  AdmissionError,
  type Runtime,
} from "@dispatch/backend";
import { prepareContent, ContentError, type AttachmentFile } from "@dispatch/runner";

process.umask(0o077);
const { values } = parseArgs({ options: {
  config: { type: "string" }, port: { type: "string" }, help: { type: "boolean", short: "h" },
} });
if (values.help) {
  console.log("Usage: dispatch-web [--config HOST.json] [--port PORT]\nConnect to the running Dispatch host and open the printed URL in your browser.");
  process.exit(0);
}
const port = Number(values.port ?? process.env.DISPATCH_PORT ?? 4319);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("The Web port must be an integer from 1 to 65535.");
const hosted = process.env.DISPATCH_ORIGIN !== undefined;
const origin = process.env.DISPATCH_ORIGIN ?? `http://127.0.0.1:${port}`;
if (hosted && !/^https:\/\/[^/]+$/.test(origin))
  throw new Error("Hosted Web requires an HTTPS origin.");
const authModule = process.env.DISPATCH_AUTH_MODULE;
if (authModule && !isAbsolute(authModule)) throw new Error("DISPATCH_AUTH_MODULE must be an absolute trusted module path.");
if (hosted && !authModule)
  throw new Error(
    "Hosted Web requires a trusted authorization module; loopback security is not hosted authentication.",
  );
const authorize = authModule ? (await import(authModule)).authorize : undefined;
if (authModule && typeof authorize !== "function")
  throw new Error("Authorization module must export authorize(request).");
const webRoot = fileURLToPath(new URL("../../web/", import.meta.url));
const specPath = fileURLToPath(
  new URL("../../../openapi.yaml", import.meta.url),
);
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function json(response: ServerResponse, status: number, body: unknown) {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}
function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim())
    throw new HttpError(400, `${name} must be nonempty text.`);
  return value;
}
async function bodyOf(request: IncomingMessage) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new HttpError(415, "Use application/json.");
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Provide a JSON object.");
  }
}
async function protect(request: IncomingMessage, response: ServerResponse, path: string) {
  if (request.headers.host !== new URL(origin).host)
    throw new HttpError(403, `Use ${origin}.`);
  if (request.headers.origin && request.headers.origin !== origin)
    throw new HttpError(403, "Cross-origin access is not allowed.");
  const shellNavigation =
    request.method === "GET" &&
    ["/", "/login"].includes(path) &&
    request.headers["sec-fetch-mode"] === "navigate" &&
    request.headers["sec-fetch-dest"] === "document" &&
    !request.headers.origin;
  if (
    !shellNavigation &&
    request.headers["sec-fetch-site"] &&
    !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"]))
  )
    throw new HttpError(403, "Cross-site access is not allowed.");
  if (request.method !== "GET" && request.headers.origin !== origin)
    throw new HttpError(403, "Writes require the exact app Origin.");
  if (authorize && !(await authorize(request, response))) {
    if (response.writableEnded) return false;
    throw new HttpError(403, "Access denied.");
  }
  return true;
}
const central = process.env.DISPATCH_CENTRAL_CONFIG;
if (values.config && central) throw new Error("Choose --config for an agent host or DISPATCH_CENTRAL_CONFIG for a central backend.");
const useHost = values.config !== undefined || (!hosted && !central && !process.env.DISPATCH_CONFIG);
const serviceConfig = useHost ? { service: await readClientConnection(values.config) } : undefined;
let runtime: Runtime = central
  ? await (await import("@dispatch/backend/central")).openCentralRuntime(JSON.parse(await readFile(central, "utf8")))
  : await openRuntime(serviceConfig);
if (process.env.DISPATCH_TITLES) {
  if (!isAbsolute(process.env.DISPATCH_TITLES)) throw new Error("DISPATCH_TITLES must be an absolute trusted JSON configuration path.");
  runtime = await withConversationTitles(runtime, JSON.parse(await readFile(process.env.DISPATCH_TITLES, "utf8")));
}
const service = runtime.service;
const sidebar = observeSidebar(runtime);
const avatars = await loadAvatars();
const streams = new Set<() => void>();
const server = createServer(async (request, response) => {
  response.setHeader("x-content-type-options", "nosniff");
  // Native same-origin form POSTs must retain their exact Origin, not Origin:null.
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    const url = new URL(request.url ?? "/", origin);
    const path = url.pathname;
    const method = request.method;
    if (path === "/health" && method === "GET") {
      json(response, 200, { status: "ready" });
      return;
    }
    if (!(await protect(request, response, path))) return;
    if (path.startsWith("/api/avatars/") && method === "GET") {
      const image = avatars.get(decodeURIComponent(path.slice("/api/avatars/".length)));
      if (!image) throw new HttpError(404, "Artwork unavailable.");
      // Artwork is fixed per configuration; avoid refetching large images on every reload.
      response.writeHead(200, { "content-type": image.mime, "cache-control": "private, max-age=86400" }).end(image.bytes);
      return;
    }
    if (path === "/api/sidebar/events" && method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", "x-accel-buffering": "no" });
      response.flushHeaders();
      let pending: string | undefined;
      let ended = false;
      const flush = () => {
        if (!pending || ended || response.writableNeedDrain) return;
        const frame = pending;
        // write() accepts this frame even when it backpressures. A later drain
        // may send a newer pending frame, never resend this accepted one.
        pending = undefined;
        response.write(frame);
      };
      const unsubscribe = sidebar.subscribe(value => {
        pending = value ? `event: snapshot\ndata: ${JSON.stringify({ ...value, avatars: [...avatars.keys()] })}\n\n`
          : 'event: failure\ndata: {"error":"Sidebar observation unavailable."}\n\n';
        flush();
      });
      const heartbeat = setInterval(() => { if (!response.writableNeedDrain) response.write(": keepalive\n\n"); }, 15000);
      const close = () => { if (ended) return; ended = true; unsubscribe(); clearInterval(heartbeat); streams.delete(close); response.end(); };
      streams.add(close); response.on("close", close); response.on("drain", flush);
      return;
    }
    if (path === "/api/chat-link" && method === "POST") {
      const body = await bodyOf(request);
      if (Object.keys(body).some(key => !["installation", "key", "title"].includes(key)))
        throw new HttpError(400, "Use only installation, key and title for keyed conversation links.");
      if (!runtime.openKeyedChat) throw new HttpError(409, "This runtime does not allow keyed conversation links.");
      json(response, 200, await runtime.openKeyedChat(field(body, "key"), field(body, "title"), field(body, "installation")));
      return;
    }
    if (path === "/api/chat-link" && method === "GET") {
      const installation = url.searchParams.get("installation"), chat = url.searchParams.get("chat");
      if (!installation || !chat) throw new HttpError(400, "A conversation link requires installation and chat.");
      if (!runtime.resolveChat) throw new HttpError(409, "This runtime does not support native conversation links.");
      json(response, 200, await runtime.resolveChat(chat, installation));
      return;
    }
    if (path === "/api/sources" && method === "GET") {
      json(response, 200, await service.sources());
      return;
    }
    if (path === "/api/agents" && method === "GET") {
      json(
        response,
        200,
        (await (runtime.catalog?.() ?? Promise.resolve(service.agents))).map(({ id, description, capabilities }) => ({ id, description, capabilities })),
      );
      return;
    }
    if (path === "/api/chats" && method === "GET") {
      json(response, 200, await service.list());
      return;
    }
    if (path === "/api/chats" && method === "POST") {
      const body = await bodyOf(request);
      const agent = field(body, "agent");
      if (!(await (runtime.catalog?.() ?? Promise.resolve(service.agents))).some((item) => item.id === agent))
        throw new HttpError(400, "Choose an installed agent.");
      json(
        response,
        201,
        await service.create(
          agent,
          "web",
          field(body, "key"),
          typeof body.source === "string" ? body.source : undefined,
        ),
      );
      void sidebar.refresh();
      return;
    }
    const match = path.match(
      /^\/api\/chats\/([^/]+)(?:\/(messages|stop|events|artifacts)(?:\/([^/]+))?)?$/,
    );
    if (match) {
      const id = decodeURIComponent(match[1]);
      const action = match[2];
      const artifactId = match[3];
      // An unavailable owner must still produce a valid SSE response so the
      // browser retries observation. A failed HTTP preflight permanently closes EventSource.
      if (!(action === "events" && method === "GET" && !artifactId) && !(await service.has(id)))
        throw new HttpError(404, "Conversation not found.");
      if (!action && method === "GET") {
        json(response, 200, await runtime.presentation.snapshot(id));
        return;
      }
      if (action === "messages" && !artifactId && method === "POST") {
        const body = await bodyOf(request);
        if (body.text !== undefined && typeof body.text !== "string") throw new HttpError(400, "text must be a string.");
        if (body.attachments !== undefined && !Array.isArray(body.attachments)) throw new HttpError(400, "attachments must be an array.");
        const text = typeof body.text === "string" ? body.text : "";
        const files = (body.attachments ?? []) as AttachmentFile[];
        prepareContent(text, files);
        json(
          response,
          202,
          await service.submit(
            id,
            text,
            field(body, "requestId"),
            "steer",
            "web",
            files,
          ),
        );
        void sidebar.refresh();
        return;
      }
      if (action === "stop" && !artifactId && method === "POST") {
        await bodyOf(request);
        await service.stop(id);
        void sidebar.refresh();
        json(response, 200, {});
        return;
      }
      if (action === "artifacts" && artifactId && method === "GET") {
        let value;
        try {
          value = await service.artifact(id, decodeURIComponent(artifactId));
        } catch {
          throw new HttpError(404, "Artifact not found.");
        }
        response
          .writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(value.artifact.name)}`,
          })
          .end(value.bytes);
        return;
      }
      if (action === "events" && !artifactId && method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.flushHeaders();
        let ended = false;
        let watch:
          Awaited<ReturnType<typeof runtime.presentation.watch>> | undefined;
        let pending: string | undefined;
        const flush = () => {
          if (pending && !ended && !response.writableNeedDrain) {
            const frame = pending;
            pending = undefined;
            response.write(frame);
          }
        };
        const heartbeat = setInterval(() => {
          if (!ended && !response.writableNeedDrain)
            response.write(": keepalive\n\n");
        }, 15000);
        const close = () => {
          if (ended) return;
          ended = true;
          clearInterval(heartbeat);
          streams.delete(close);
          void watch?.stop().catch(() => {});
          response.end();
        };
        streams.add(close);
        response.on("close", close);
        response.on("drain", flush);
        try {
          let last = "";
          watch = await runtime.presentation.watch(id, async (snapshot) => {
            // Each frame is a full native projection: coalescing for a slow reader
            // cannot drop history. Do not block the runtime behind a browser.
            const frame = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
            if (frame === last) return;
            last = pending = frame;
            flush();
          });
          if (ended) await watch.stop();
          else void watch.closed.then(close, close);
        } catch {
          response.write(
            'event: failure\ndata: {"error":"Observation failed. Reconnect to reload saved history."}\n\n',
          );
          close();
        }
        return;
      }
    }
    if (path.startsWith("/api/"))
      throw new HttpError(404, "API route not found.");
    if (method !== "GET") throw new HttpError(404, "Route not found.");
    if (path === "/openapi.yaml") {
      response
        .writeHead(200, { "content-type": "application/yaml" })
        .end(await readFile(specPath));
      return;
    }
    const asset =
      path === "/"
        ? "index.html"
        : path.startsWith("/assets/") &&
            /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)
          ? path.slice(1)
          : undefined;
    if (!asset) throw new HttpError(404, "Page not found.");
    const content = await readFile(resolve(webRoot, asset)).catch(() => {
      throw new HttpError(404, "Asset not found.");
    });
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
    };
    response
      .writeHead(200, {
        "content-type": mime[extname(asset)] ?? "application/octet-stream",
      })
      .end(content);
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    const status =
      (error instanceof AdmissionError || error instanceof ContentError)
        ? error.status
        : error instanceof HttpError
          ? error.status
          : error instanceof URIError
            ? 400
            : 500;
    json(response, status, {
      error:
        error instanceof HttpError || error instanceof AdmissionError || error instanceof ContentError
          ? error.message
          : status === 400
            ? "Invalid URL encoding."
            : "Runtime request failed. Check the local server and configured provider; saved work is preserved.",
    });
  }
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const end of streams) end();
  server.close();
  server.closeIdleConnections();
  try {
    await runtime.close();
    process.exit(0);
  } catch {
    console.error(
      "Runtime shutdown failed; preserve the store and inspect native recovery on restart.",
    );
    process.exit(1);
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void close();
  });
server.on("error", async () => {
  console.error(
    "Cannot bind app port; the existing listener was not replaced.",
  );
  await runtime.close();
  process.exit(1);
});
server.listen(
  port,
  hosted ? (process.env.DISPATCH_HOST ?? "127.0.0.1") : "127.0.0.1",
  () =>
    console.log(
      `Web: ${origin} (PID ${process.pid}; native state ${runtime.stateRoot})`,
    ),
);
