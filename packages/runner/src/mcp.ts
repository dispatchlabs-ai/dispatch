import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import {
  McpClient, McpConnectionClosedError, McpSessionExpiredError, StdioTransport, StreamableHttpTransport,
  createMcpToolName, mcpNamespace, normalizeMcpInputSchema, toLlmContent, validateMcpServerConfig,
  type CallToolResult, type McpServerConfig, type Tool,
} from "@earendil-works/pi-mcp";

/** Host-owned connections. Omit tools to expose every discovered tool; an explicit list uses server tool names. */
export type McpServers = Record<string, McpServerConfig & { tools?: string[]; headersCommand?: string[] }>;

export type ReminderCall = (tool: string, args: Record<string, unknown>, signal?: AbortSignal,
  beforeCall?: () => Promise<void>) => Promise<CallToolResult>;

const executeFile = promisify(execFile);
async function credentialHeaders(name: string, command: string[], cwd: string): Promise<Record<string, string>> {
  try {
    const { stdout } = await executeFile(command[0], command.slice(1), { cwd });
    const headers: unknown = JSON.parse(stdout);
    if (headers && typeof headers === "object" && !Array.isArray(headers)
      && Object.values(headers).every(value => typeof value === "string")) return headers as Record<string, string>;
  } catch { /* Credential helper output can contain secrets. */ }
  throw new Error(`MCP server ${name}: headersCommand must return a JSON object of HTTP headers.`);
}

/** Connect the servers selected by definitions, discovering native Durable tools before recovery starts. */
export async function connectMcpServers(servers: McpServers, options: { cwd: string; names: string[]; privateNames?: string[]; reviewNames?: string[]; stdioEnv?: Record<string, string>;
  /** Host-owned arguments removed from model-facing schemas and supplied on every call. */
  argumentsByServer?: Record<string, Record<string, Record<string, JsonValue>>> }) {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("mcpServers must be an object.");
  const validated = new Map<string, Exclude<ReturnType<typeof validateMcpServerConfig>, { kind: "invalid" }>>();
  const namespaces = new Set<string>();
  for (const [name, entry] of Object.entries(servers)) {
    // Validate every entry's shape. Application-specific OAuth support is checked when a server is selected.
    const result = validateMcpServerConfig(name, entry, { checkMetadataDocumentCallback: () => undefined });
    if (result.kind === "invalid") throw new Error(`MCP ${result.error}`);
    if (namespaces.has(mcpNamespace(name))) throw new Error(`MCP server ${name} has the same normalized name as another server.`);
    namespaces.add(mcpNamespace(name));
    const { tools } = entry;
    if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => typeof tool !== "string" || !tool.trim())
      || new Set(tools).size !== tools.length)) throw new Error(`MCP server ${name}: tools must be unique, nonempty server tool names.`);
    validated.set(name, result);
  }
  const selected = [...new Set([...options.names, ...(options.privateNames ?? [])])].map(name => {
    const server = validated.get(name);
    if (!server) throw new Error(`Agent requires MCP server ${name}; add it to mcpServers.`);
    if (server.config.enabled === false) throw new Error(`Agent requires disabled MCP server ${name}.`);
    if (server.kind === "http" && server.config.oauth !== undefined) {
      throw new Error(`MCP server ${name}: browser OAuth setup is not supported by this host. Use an authenticated stdio client or configured HTTP headers.`);
    }
    // Other MCP hosts can assign permissions through additional fields. Never silently drop those grants or restrictions.
    const supported = ["type", "tools", "description", "enabled", "timeout",
      ...(server.kind === "stdio" ? ["command", "args", "cwd", "env"] : ["url", "headers", "headersCommand"])];
    for (const key of Object.keys(server.config)) {
      if (!supported.includes(key)) throw new Error(`MCP server ${name}: unsupported setting ${key}. Select the permitted server tools with tools[].`);
    }
    const command = servers[name].headersCommand;
    if (command !== undefined && (server.kind !== "http" || new URL(server.config.url).protocol !== "https:"
      || !Array.isArray(command) || !command.length || command.some(arg => typeof arg !== "string" || !arg.trim()))) {
      throw new Error(`MCP server ${name}: headersCommand requires HTTPS and a nonempty argument array.`);
    }
    return { name, server };
  });
  const connections: { close(): Promise<void> }[] = [];
  const privateCalls = new Map<string, ReminderCall>();
  const discovered: { server: string; tool: Tool; client: () => Promise<McpClient> }[] = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const results = await Promise.allSettled(connections.map(connection => connection.close()));
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Could not close MCP connections.");
  })();
  try {
    for (const { name, server } of selected) {
      const expand = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => {
        const resolved = process.env[variable];
        if (resolved === undefined) throw new Error(`MCP server ${name}: environment variable ${variable} is not set.`);
        return resolved;
      });
      const path = (value: string) => {
        const expanded = expand(value);
        return expanded.startsWith("~/") ? resolve(homedir(), expanded.slice(2)) : expanded;
      };
      const values = (entries: Record<string, string> | undefined) => entries === undefined ? undefined
        : Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, expand(value)]));
      const transport = async () => server.kind === "stdio" ? new StdioTransport({
        command: path(server.config.command), args: server.config.args?.map(path),
        env: { ...values(server.config.env), ...options.stdioEnv },
        cwd: resolve(options.cwd, path(server.config.cwd ?? ".")), maxMessageBytes: Infinity,
      }) : new StreamableHttpTransport({ url: server.config.url, headers: {
        ...values(server.config.headers), ...(servers[name].headersCommand
          ? await credentialHeaders(name, servers[name].headersCommand.map(path), options.cwd) : {}),
      }, maxMessageBytes: Infinity });
      let current: McpClient | undefined;
      let connecting: Promise<McpClient> | undefined;
      let closed = false;
      const client = (): Promise<McpClient> => {
        if (closed) return Promise.reject(new Error(`MCP server ${name} is shutting down.`));
        if (connecting) return connecting;
        if (current?.connectionState === "connected") return Promise.resolve(current);
        const previous = current;
        const next = new McpClient({ name: "dispatch", version: "1",
          ...(server.config.timeout === undefined ? {} : { requestTimeoutMs: server.config.timeout * 1000 }) });
        current = next;
        connecting = (async () => {
          await previous?.close();
          const nextTransport = await transport();
          if (closed) throw new Error(`MCP server ${name} is shutting down.`);
          await next.connect(nextTransport);
          return next;
        })().finally(() => { connecting = undefined; });
        return connecting;
      };
      connections.push({ close: async () => {
        closed = true;
        // Closing the client interrupts a shared handshake; its rejection is expected during shutdown.
        const pending = connecting?.catch(() => {});
        try { await current?.close(); } finally { await pending; }
      } });
      if (options.privateNames?.includes(name)) privateCalls.set(name, async (tool, args, signal, beforeCall) => {
        if (servers[name].tools && !servers[name].tools.includes(tool)) throw new Error(`MCP server ${name} does not grant ${tool}.`);
        signal?.throwIfAborted();
        const connection = await client();
        await beforeCall?.();
        signal?.throwIfAborted();
        try {
          return await connection.callTool(tool, { ...args, ...options.argumentsByServer?.[name]?.[tool] },
            { signal, timeoutMs: (servers[name].timeout ?? 0) * 1000 });
        } catch (error) {
          if (error instanceof McpConnectionClosedError || error instanceof McpSessionExpiredError) await connection.close();
          throw error;
        }
      });
      if (!options.names.includes(name) && !options.reviewNames?.includes(name)) continue;
      const connected = await client();
      const tools = connected.serverCapabilities?.tools ? await connected.listTools() : [];
      const allowed = servers[name].tools;
      for (const tool of allowed ?? []) {
        if (!tools.some(candidate => candidate.name === tool)) throw new Error(`MCP server ${name} does not advertise configured tool ${tool}.`);
      }
      for (const tool of tools) if (allowed === undefined || allowed.includes(tool.name)) discovered.push({ server: name, tool, client });
    }
    // Hash every collision, so names do not change with discovery order.
    const counts = new Map<string, number>();
    for (const { server, tool } of discovered) {
      const name = createMcpToolName(server, tool.name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const bind = (caller?: { agent: string; stateRoot: string }) => {
      const extensions: Record<string, Extension> = Object.create(null);
      for (const { name } of selected) extensions[name] = { name: `mcp:${name}`, tools: [] };
      const assigned = new Set<string>();
      for (const { server, tool, client } of discovered) {
        const fixed = options.argumentsByServer?.[server]?.[tool.name] ?? {};
        for (const key of Object.keys(fixed)) {
          if (!Object.hasOwn(tool.inputSchema.properties ?? {}, key)) throw new Error(`MCP ${server}/${tool.name} cannot bind unsupported argument ${key}.`);
        }
        const hidden = new Set([...Object.keys(fixed), ...(caller && tool._meta?.["ai.dispatch/caller"] === true ? ["caller"] : [])]);
        const name = createMcpToolName(server, tool.name, candidate => (counts.get(candidate) ?? 0) > 1 || assigned.has(candidate));
        if (assigned.has(name)) throw new Error(`MCP server ${server} advertised a duplicate tool name.`);
        assigned.add(name);
        const registration: ToolRegistration = {
          name, description: tool.description?.trim() || tool.title || `MCP tool ${tool.name} from ${server}`,
          parameters: normalizeMcpInputSchema(hidden.size
            ? { ...tool.inputSchema, properties: Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).filter(([key]) => !hidden.has(key))),
              ...(Array.isArray(tool.inputSchema.required) ? { required: tool.inputSchema.required.filter(key => !hidden.has(key)) } : {}) }
            : tool.inputSchema),
          // Pi makes strict model-facing schemas while Durable validates/coerces against the original schema.
          constrainedSampling: { type: "json_schema", strict: "prefer" },
          ...(tool.outputSchema === undefined ? {} : { structuredOutputSchema: tool.outputSchema }),
          // Preserve source evidence. Generic remote tools retain Durable's default unsafe replay policy.
          outputLimits: { maxBytes: Infinity, maxLines: Infinity },
          async execute(args, api, context) {
            context.abortSignal?.throwIfAborted();
            const connection = await awaitWithContext(client(), context);
            try {
              // Durable validated the arguments against the server's object schema.
              // Agent work has no predictable duration. Pi's zero disables its default request deadline.
              let input: Record<string, unknown> = { ...args as Record<string, unknown>, ...fixed };
              if (caller && tool._meta?.["ai.dispatch/caller"] === true) {
                const conversation = await api.commit(tx => tx.conversation(api.conversationId), context);
                if (!conversation || conversation.owner) throw new Error("Private child conversations cannot send independent agent messages.");
                // The model never supplies or overrides this context. The server checks the host identity.
                input = { ...input, caller: { from: `${caller.agent}:${api.conversationId}`,
                  stateRoot: await realpath(caller.stateRoot), requestId: `mcp:tool:${api.taskId}` } };
              }
              const result = await connection.callTool(tool.name, input, {
                signal: context.abortSignal, timeoutMs: (servers[server].timeout ?? 0) * 1000,
              });
              const output = toLlmContent(result);
              if (result.isError && !output.some(block => block.type === "text" && block.text.trim())) {
                output.push({ type: "text", text: `MCP tool ${server}/${tool.name} returned an error.` });
              }
              return {
                output, isError: result.isError === true,
                // MCP results arrived as JSON; retain all blocks and structured data even when the model cannot display them.
                details: { ...result, ...(Object.keys(fixed).length ? { dispatchBoundArguments: fixed } : {}) } as unknown as JsonValue,
                ...(tool.outputSchema !== undefined && result.structuredContent !== undefined
                  ? { structuredOutput: result.structuredContent as JsonValue } : {}),
              };
            } catch (error) {
              // Reconnect on a later call, never automatically replay an uncertain remote operation.
              if (error instanceof McpConnectionClosedError || error instanceof McpSessionExpiredError) await connection.close();
              throw error;
            }
          },
        };
        extensions[server] = { ...extensions[server], tools: [...(extensions[server].tools ?? []), registration] };
      }
      return extensions;
    };
    const reminderCall = (name: string) => {
      const call = privateCalls.get(name);
      if (!call) throw new Error(`Missing reminder connection ${name}.`);
      return call;
    };
    const privateTools = (selection: Record<string, string[]>): ToolRegistration[] => Object.entries(selection).flatMap(([server, names]) => {
      if (!options.privateNames?.includes(server)) throw new Error(`Missing private review connection ${server}.`);
      return names.map(name => {
        const found = discovered.find(item => item.server === server && item.tool.name === name);
        if (!found) throw new Error(`Private review connection ${server} does not grant ${name}.`);
        if (found.tool._meta?.["ai.dispatch/caller"] === true) throw new Error("Private reviews cannot use tools requiring an independent agent caller.");
        const registration: ToolRegistration = {
          name: createMcpToolName(server, name, candidate => (counts.get(candidate) ?? 0) > 1), description: found.tool.description ?? found.tool.title ?? name,
          parameters: normalizeMcpInputSchema(found.tool.inputSchema), replay: "safe",
          outputLimits: { maxBytes: Infinity, maxLines: Infinity },
          async execute(args, _api, context) {
            const result = await reminderCall(server)(name, args as Record<string, unknown>, context.abortSignal);
            return { output: toLlmContent(result), isError: result.isError === true, details: result as unknown as JsonValue };
          },
        };
        return registration;
      });
    });
    return { extensions: bind(), bind, reminderCall, privateTools, close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "MCP startup and cleanup failed."); }
    throw error;
  }
}
