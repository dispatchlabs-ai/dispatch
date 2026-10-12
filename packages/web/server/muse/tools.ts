import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { nativeToolBridge } from "../collaboration/sdk-tools.js";
import type { MuseRunScope } from "./task.js";

/** Invocation-local MCP access to the agent's assigned Pi tools; no credential is persisted. */
export async function museToolServer(scope: MuseRunScope, authorize: () => Promise<void>, beforeTool: (name: string) => Promise<void>) {
  scope.runtime.signal.throwIfAborted();
  await authorize();
  const bridge = await nativeToolBridge(scope, authorize, beforeTool, { api: "openai-completions", provider: "meta" });
  const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
  const expected = Buffer.from(authorization);
  const servers = new Set<Server>();
  const requests = new Set<Promise<void>>();
  const calls = new Set<Promise<CallToolResult>>();
  let host = "";
  let closing = false;
  let shutdown: Promise<void> | undefined;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end(); return;
    }
    // Native clients do not send Origin. Do not expose this local endpoint to browser-origin traffic.
    if (request.headers.host !== host || request.headers.origin !== undefined) {
      response.writeHead(403).end(); return;
    }
    if (closing || scope.runtime.signal.aborted) { response.writeHead(503).end(); return; }
    if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
    if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }

    // The SDK's stateless HTTP pattern uses a distinct server/transport per request. JSON-RPC IDs
    // are transport correlation, not durable operation IDs; reconnecting clients can reuse them.
    const server = new Server({ name: "dispatch", version: "1.0.0" }, { capabilities: { tools: {} } });
    // Use stock SSE responses: closing the transport releases pending streams. SDK 1.32.1's
    // JSON-response mode can leave handleRequest waiting after close during an in-flight tool.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    servers.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      try { await authorize(); }
      catch { throw new Error("Dispatch tool access is unavailable."); }
      return { tools: bridge.tools.map(selected => ({ name: selected.name, description: selected.description,
        inputSchema: selected.parameters as Tool["inputSchema"] })) };
    });
    server.setRequestHandler(CallToolRequestSchema, request => {
      if (closing || scope.runtime.signal.aborted) throw new Error("Dispatch tool bridge is closing.");
      const call: Promise<CallToolResult> = bridge.call(request.params.name, request.params.arguments ?? {})
        .catch(() => ({ content: [{ type: "text" as const, text: "Dispatch could not complete this tool request. Its effects may be uncertain; inspect the saved activity before retrying." }], isError: true }));
      calls.add(call);
      void call.then(() => calls.delete(call));
      return call;
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } finally {
      await server.close();
      servers.delete(server);
    }
  }

  const listener = createServer((request, response) => {
    const work = handle(request, response).catch(() => {
      // Never return native exceptions, request headers or the transient bearer to a client/log.
      if (!response.headersSent && !response.destroyed) response.writeHead(500).end();
      else if (!response.destroyed) response.end();
    }).finally(() => { requests.delete(work); });
    requests.add(work);
  });
  function close(): Promise<void> {
    if (shutdown) return shutdown;
    closing = true;
    shutdown = (async () => {
      const stopped = new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      // Release blocked/partial HTTP reads too. Native tool tasks are separately joined below.
      listener.closeAllConnections();
      await Promise.allSettled([...servers].map(server => server.close()));
      await Promise.allSettled([...requests]);
      await Promise.allSettled([...calls]);
      await stopped;
    })();
    return shutdown;
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    listener.once("error", onError);
    listener.listen(0, "127.0.0.1", () => { listener.removeListener("error", onError); resolve(); });
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("Muse tool bridge did not bind a loopback endpoint.");
  }
  host = `127.0.0.1:${address.port}`;
  if (scope.runtime.signal.aborted) { await close(); scope.runtime.signal.throwIfAborted(); }
  return { url: `http://${host}/mcp`, headers: { Authorization: authorization }, close };
}
