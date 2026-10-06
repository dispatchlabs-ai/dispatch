import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonRepresentation, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, defineDoc, defineExtension, defineTool, section, type ConversationId, type Harness, type Registry, type Tx } from "@earendil-works/pi-durable";
import { McpClient, StdioTransport, toLlmContent, type Tool } from "@earendil-works/pi-mcp";
import { z } from "zod";
import type { AgentConnection, AgentConnectionStatus } from "../src/shared/contracts.js";

const context = BACKGROUND_CONTEXT;
const id = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(40);
const connectionSchema = z.object({
  id, agentId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200), name: z.string().min(1).max(100),
  endpoint: z.url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; }),
  identity: z.string().min(1).max(200),
  instructions: z.string().max(50_000).default(""),
  command: z.string().startsWith("/"), args: z.array(z.string()),
  /** Explicit operator decision to grant this connection to already-running instances. */
  applyToExisting: z.boolean().default(false),
}).strict();
type ConnectionConfig = z.infer<typeof connectionSchema>;
type Catalog = { connections: Record<string, { tools: JsonRepresentation<Tool>[]; instructions: string; checkedAt: number }> };
const CatalogDoc = defineDoc<Catalog>({ kind: "dispatch.mcp-catalog", version: 1, scope: "session", initial: () => ({ connections: {} }) });
const BindingDoc = defineDoc<{ connections: string[] }>({
  kind: "dispatch.mcp-bindings", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", initial: () => ({ connections: [] }),
});
const wikiTools = ["wiki.search", "wiki.read", "wiki.history", "wiki.traceSearch", "wiki.traces", "wiki.trace", "wiki.file", "wiki.preview", "wiki.save"];
export const isMcpExtension = (name: string) => name.startsWith("dispatch-mcp-");
export const isMcpTool = (name: string) => name.startsWith("mcp_");

/** Operator-managed connections belong to individual definitions; secrets never enter Pi documents or HTTP responses. */
export class AgentConnections {
  private readonly connections: McpConnection[];
  private harness!: Harness;
  private closed = false;
  onChanged: () => Promise<void> = async () => {};

  private constructor(configs: ConnectionConfig[], registry: Registry) {
    this.connections = configs.map(config => new McpConnection(config, registry, async connection => {
      if (this.closed) return;
      await this.harness.commit(async tx => {
        const catalog = await tx.doc(CatalogDoc);
        catalog.connections[connection.key] = connection.catalog;
      }, context);
      await this.onChanged();
    }));
  }

  static async load(filename: string, registry: Registry) {
    let raw: string;
    try { raw = await readFile(filename, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new AgentConnections([], registry); throw error; }
    const configs = z.object({ connections: z.array(connectionSchema) }).strict().parse(JSON.parse(raw)).connections;
    const keys = configs.map(config => `${config.agentId}/${config.id}`);
    if (new Set(keys).size !== keys.length) throw new Error("Each agent MCP connection must have a unique ID.");
    return new AgentConnections(configs, registry);
  }

  async open(harness: Harness) {
    this.harness = harness;
    const saved = await harness.snapshot(CatalogDoc, context);
    for (const connection of this.connections) connection.restore(saved?.connections[connection.key]);
    // Discovery installs executable definitions before Pi resumes any saved work.
    await Promise.all(this.connections.map(connection => connection.connect().catch(() => {})));
  }

  forAgent(agentId: string): AgentConnection[] { return this.connections.filter(connection => connection.config.agentId === agentId).map(connection => connection.descriptor()); }
  status(agentId: string): AgentConnectionStatus[] { return this.connections.filter(connection => connection.config.agentId === agentId).map(connection => connection.status()); }
  async reconnect(agentId: string, id: string) {
    const connection = this.connections.find(item => item.config.agentId === agentId && item.config.id === id);
    if (!connection) throw new Error("MCP connection not found.");
    await connection.connect().catch(() => {});
    return this.status(agentId);
  }
  has(agentId: string) { return this.connections.some(connection => connection.config.agentId === agentId); }

  selection(agentId: string) {
    const connections = this.connections.filter(connection => connection.config.agentId === agentId);
    return { extensions: connections.map(connection => connection.extensionName), tools: connections.flatMap(connection => connection.toolNames()) };
  }

  async bind(tx: Tx, conversationId: ConversationId, agentId: string, existing = false) {
    const binding = await tx.doc(BindingDoc, conversationId);
    const connections = this.connections.filter(connection => connection.config.agentId === agentId && (!existing || connection.config.applyToExisting || binding.connections.includes(connection.key)));
    binding.connections = connections.map(connection => connection.key);
    const agent = await tx.doc(AgentDoc, conversationId);
    const extensions = connections.map(connection => connection.extensionName);
    const tools = connections.flatMap(connection => connection.toolNames());
    if (Array.isArray(agent.extensions)) agent.extensions = [...agent.extensions.filter(name => !isMcpExtension(name)), ...extensions];
    else {
      const prior = agent.extensions ?? {};
      agent.extensions = { add: [...(prior.add ?? []).filter(name => !isMcpExtension(name)), ...extensions], remove: (prior.remove ?? []).filter(name => !isMcpExtension(name)) };
    }
    if (Array.isArray(agent.tools)) agent.tools = [...agent.tools.filter(name => !isMcpTool(name)), ...tools];
    else if (agent.tools) agent.tools.remove = agent.tools.remove.filter(name => !isMcpTool(name));
    return { extensions, tools };
  }

  async close() { this.closed = true; await Promise.all(this.connections.map(connection => connection.close())); }
}

class McpConnection {
  readonly key: string;
  readonly extensionName: string;
  private client?: McpClient;
  private connecting?: Promise<void>;
  private closed = false;
  private error?: string;
  catalog: Catalog["connections"][string] = { tools: [], instructions: "", checkedAt: 0 };

  constructor(readonly config: ConnectionConfig, private readonly registry: Registry, private readonly changed: (connection: McpConnection) => Promise<void>) {
    this.key = `${config.agentId}/${config.id}`;
    this.extensionName = `dispatch-mcp-${config.agentId}-${config.id}`;
  }

  descriptor(): AgentConnection {
    return { id: this.config.id, name: this.config.name, endpoint: this.config.endpoint, identity: this.config.identity, extension: this.extensionName };
  }

  status(): AgentConnectionStatus {
    const names = this.catalog.tools.map(tool => tool.name);
    return { ...this.descriptor(), status: this.error ? "unavailable" : this.client?.connectionState === "connected" ? "connected" : "disconnected",
      access: wikiTools.every(name => names.includes(name)) ? "Full access" : "Selected tools", checkedAt: this.catalog.checkedAt || null,
      tools: this.catalog.tools.map(tool => ({ name: tool.name, description: tool.description ?? "" })), ...(this.error ? { error: this.error } : {}) };
  }

  toolNames() { return this.catalog.tools.map(tool => this.toolName(tool.name)); }
  private toolName(name: string) {
    const prefix = `mcp_${this.config.id}_${name}`.replace(/[^A-Za-z0-9_-]/g, "_");
    const suffix = createHash("sha256").update(`${this.key}/${name}`).digest("hex").slice(0, 10);
    return `${prefix.slice(0, 53)}_${suffix}`;
  }

  restore(catalog?: Catalog["connections"][string]) {
    if (catalog) this.catalog = catalog;
    this.install();
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("MCP connection is closed."));
    if (this.connecting) return this.connecting;
    if (this.client?.connectionState === "connected" && !this.error) return Promise.resolve();
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open() {
    await this.client?.close();
    const client = new McpClient({ name: "dispatch-web", version: "0.1.0" });
    this.client = client;
    client.onClose(() => { if (!this.closed) this.error = `${this.config.name} disconnected. The next tool call will reconnect.`; });
    client.onNotification("notifications/tools/list_changed", () => { void this.discover(client).catch(() => { this.error = "The tool list could not be refreshed."; }); });
    try {
      await client.connect(new StdioTransport({ command: this.config.command, args: this.config.args, inheritEnv: false, stderr: "pipe" }));
      await this.discover(client);
    } catch {
      await client.close().catch(() => {});
      this.error = `${this.config.name} could not connect. Check its registration and service configuration.`;
      throw new Error(this.error);
    }
  }

  private async discover(client: McpClient) {
    const tools = await client.listTools();
    if (this.closed || this.client !== client) return;
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("MCP returned duplicate tool names.");
    const instructions = client.instructions ?? "";
    if (tools.some(tool => tool.name.startsWith("wiki.")) && !instructions.includes(`Authenticated agent: ${this.config.identity}. Definition `)) {
      throw new Error("The wiki authenticated a different agent identity.");
    }
    this.catalog = { tools: JSON.parse(JSON.stringify(tools)) as JsonRepresentation<Tool>[], instructions, checkedAt: Date.now() };
    this.error = undefined;
    this.install();
    await this.changed(this);
  }

  private install() {
    this.registry.install(defineExtension({
      name: this.extensionName,
      sections: [section(`mcp_${createHash("sha256").update(this.key).digest("hex").slice(0, 12)}`, () => [
        `Connection: ${this.config.name}. Wiki/service URL: ${this.config.endpoint}. Use its tools under your assigned identity.`,
        this.config.instructions, this.catalog.instructions,
      ].filter(Boolean).join("\n\n"))],
      tools: this.catalog.tools.map(tool => defineTool({
        name: this.toolName(tool.name), description: `${tool.description ?? tool.name}\nConnection: ${this.config.name} (${this.config.endpoint}).`,
        parameters: Type.Unsafe<Record<string, unknown>>({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
        // External writes may have committed before a disconnect. Never repeat an uncertain call on recovery.
        replay: "unsafe",
        execute: async (args, api, ctx) => {
          const binding = await api.snapshot(BindingDoc, api.conversationId, ctx);
          if (!binding?.connections.includes(this.key)) throw new Error("This agent has no access to this MCP connection.");
          await this.connect();
          ctx.abortSignal?.throwIfAborted();
          if (!this.catalog.tools.some(current => current.name === tool.name)) throw new Error("This MCP tool is no longer available.");
          const result = await this.client!.callTool(tool.name, args, { signal: ctx.abortSignal, onProgress: progress => { if (progress.message) api.output(progress.message + "\n"); } });
          return { content: toLlmContent(result), isError: result.isError === true, details: JSON.parse(JSON.stringify(result)) as JsonValue };
        },
      })),
    }));
  }

  async close() { this.closed = true; await this.connecting?.catch(() => {}); await this.client?.close(); }
}
