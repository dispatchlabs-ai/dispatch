#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { connectClient, readClientConnection, type AgentClient } from "@dispatch/runner/client";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createDispatchMcpServer, serveMcpHttp } from "./index.js";

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: "string" }, port: { type: "string" }, host: { type: "string" },
    "token-file": { type: "string" }, origin: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: dispatch-mcp [--config host-or-client.json]\n" +
      "       dispatch-mcp [--config host-or-client.json] --port PORT --token-file FILE [--host ADDRESS] [--origin https://agents.example.com]\n\n" +
      "Default: MCP stdio connected to the existing Dispatch host. HTTP serves /mcp with bearer authorization.\n" +
      "Start your agent host separately. Closing MCP leaves admitted work running.");
    return;
  }
  if (!values.port && (values.host || values.origin || values["token-file"])) throw new Error("HTTP options require --port.");
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error("Use a TCP port from 0 to 65535.");
  const tokenFile = values["token-file"];
  async function token() {
    if (!tokenFile) throw new Error("HTTP requires --token-file for its MCP bearer token.");
    const value = (await readFile(tokenFile, "utf8")).trim();
    if (!value) throw new Error("The MCP bearer token file is empty.");
    return value;
  }
  if (port !== undefined) await token();
  const settings = await readClientConnection(values.config);
  const connecting = new AbortController();
  let connection: Promise<AgentClient> | undefined;
  // Discovery must work before the host listens: an agent in that same host
  // can select this MCP connector while its tools are being loaded.
  const client = () => {
    connecting.signal.throwIfAborted();
    return connection ??= connectClient(settings, connecting.signal).catch((error: NodeJS.ErrnoException) => {
      connection = undefined;
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") throw new Error("Dispatch host is unavailable. Start your host, then retry the operation with its original identity.", { cause: error });
      throw error;
    });
  };
  const closeClient = async () => {
    connecting.abort();
    const opened = await connection?.catch(() => undefined);
    await opened?.close();
  };
  const onerror = (error: Error) => console.error(error.message);
  let endpoint: { close(): Promise<void> };
  try {
    if (port === undefined) {
      endpoint = serveStdio(() => createDispatchMcpServer(client), {
        transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: Infinity }), maxSubscriptions: Infinity, onerror,
      });
    } else {
      const digest = (value: string) => createHash("sha256").update(value).digest();
      const http = await serveMcpHttp({ client, port, host: values.host, origin: values.origin, onerror,
        authorize: async request => {
          const expected = await token();
          return timingSafeEqual(digest(request.headers.authorization ?? ""), digest(`Bearer ${expected}`));
        },
      });
      endpoint = http;
      console.error(`Dispatch MCP listening at ${http.url}`);
    }
  } catch (error) { await closeClient(); throw error; }
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await endpoint.close(); } finally { await closeClient(); }
  })();
  const stop = () => { void close().catch(error => { onerror(error); process.exitCode = 1; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (port === undefined) { process.stdin.once("end", stop); process.stdin.once("close", stop); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
