import { createServer, type IncomingMessage } from "node:http";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createDispatchMcpServer, type McpClientSource } from "./index.js";

export type McpHttpOptions = {
  client: McpClientSource;
  port: number;
  host?: string;
  /** Public HTTPS origin when a reverse proxy serves this listener. */
  origin?: string;
  /** Authorizes access to the supplied client's whole catalog, on every request. */
  authorize(request: IncomingMessage): boolean | Promise<boolean>;
  onerror?: (error: Error) => void;
};

/** Streamable HTTP for the same client. Does not start or close the agent host. */
export async function serveMcpHttp(options: McpHttpOptions) {
  const host = options.host ?? "127.0.0.1";
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  const origin = options.origin ? new URL(options.origin) : undefined;
  if (origin && (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password))
    throw new Error("Use a public HTTPS origin without a path, query or credentials.");
  if (!loopback && !origin) throw new Error("A network listener requires a public HTTPS origin and TLS termination.");

  const instances = new Set<McpServer>();
  const handler = createMcpHandler(() => {
    const server = createDispatchMcpServer(options.client);
    instances.add(server);
    server.server.onclose = () => instances.delete(server);
    return server;
  }, { legacy: "stateless", maxRequestBodySize: Number.MAX_SAFE_INTEGER, maxSubscriptions: Infinity, onerror: options.onerror });
  // The SDK requires a finite body ceiling. MAX_SAFE_INTEGER leaves practical
  // limits to the runtime/proxy, consistent with native attachment handling.
  const handle = toNodeHandler(handler, { maxRequestBodySize: Number.MAX_SAFE_INTEGER, onerror: options.onerror });
  const validateHost = hostHeaderValidation([...new Set([host === "::1" ? "[::1]" : host,
    ...(loopback ? ["localhost", "127.0.0.1", "[::1]"] : []), ...(origin ? [origin.hostname] : [])])]);
  const allowedOrigins = new Set(origin ? [origin.origin] : []);
  const server = createServer((request, response) => {
    void (async () => {
      if (!validateHost(request, response)) return;
      if (request.headers.origin !== undefined && !allowedOrigins.has(request.headers.origin)) {
        response.writeHead(403).end("Forbidden origin."); return;
      }
      if (!(await options.authorize(request))) {
        response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized."); return;
      }
      if (request.url !== "/mcp") { response.writeHead(404).end("Not found."); return; }
      await handle(request, response);
    })().catch(error => {
      options.onerror?.(error instanceof Error ? error : new Error(String(error)));
      if (!response.headersSent) response.writeHead(500).end("MCP request failed.");
      else response.destroy();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, host, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { await handler.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP listener has no TCP address.");
  if (!origin && loopback) for (const name of ["localhost", "127.0.0.1", "[::1]"]) allowedOrigins.add(`http://${name}:${address.port}`);
  return {
    url: `${origin?.origin ?? `http://${host === "::1" ? "[::1]" : host}:${address.port}`}/mcp`,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await handler.close();
      await Promise.all([...instances].map(instance => instance.close()));
      server.closeAllConnections();
      await closed;
    },
  };
}
