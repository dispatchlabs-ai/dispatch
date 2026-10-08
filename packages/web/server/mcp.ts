import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonRepresentation, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, defineDoc, defineExtension, defineTool, section, type ConversationId, type Harness, type Registry, type Tx } from "@earendil-works/pi-durable";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type Tool, type CallToolResult, type McpRequestOptions } from "@earendil-works/pi-mcp";
import { z } from "zod";
import type { AgentConnection, AgentConnectionStatus } from "../src/shared/contracts.js";
import type { McpConnections, ManagedConnectionRecord } from "./mcp-connections.js";
import { verifyLegacyOperatorIdentity } from "./legacy-wiki-connection.js";

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
// Retain the historical oauth namespace so stored bindings and tool IDs survive migration.
type ConnectionConfig = z.infer<typeof connectionSchema> | { id: string; agentId: "oauth"; name: string; endpoint: string; identity: string; instructions: string; applyToExisting: false; source: "oauth" };
type Catalog = { connections: Record<string, { tools: JsonRepresentation<Tool>[]; instructions: string; checkedAt: number; serverName?: string }> };
const CatalogDoc = defineDoc<Catalog>({ kind: "dispatch.mcp-catalog", version: 1, scope: "session", initial: () => ({ connections: {} }) });
const BindingDoc = defineDoc<{ connections: string[] }>({
  kind: "dispatch.mcp-bindings", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", initial: () => ({ connections: [] }),
});
export const isMcpExtension = (name: string) => name.startsWith("dispatch-mcp-");
export const isMcpTool = (name: string) => name.startsWith("mcp_");

/** Nonsecret registry projection; no transport command, credentials or client object. */
export type WorkerConnectionDefinition = {
  id: string; extension: string; instructions: string;
  tools: { name: string; description: string; inputSchema: Tool["inputSchema"] }[];
};
export type WorkerMcpCallOptions = Pick<McpRequestOptions, "signal" | "onProgress"> & { beforeCall: () => Promise<void>; assertCurrent: () => void };

/** Explicit per-definition bindings; credentials never enter native documents. */
export class AgentConnections {
  private readonly connections: McpConnection[];
  private harness!: Harness;
  private closed = false;
  onChanged: () => Promise<void> = async () => {};
  runBackground: <T>(operation: () => Promise<T>) => Promise<T> = operation => operation();

  private constructor(configs: ConnectionConfig[], private readonly registry: Registry, private readonly managed?: McpConnections, private readonly companyId?: string) {
    this.connections = configs.map(config => this.create(config));
    this.syncManaged();
  }

  private create(config: ConnectionConfig) {
    return new McpConnection(config, this.registry, async connection => {
      if (this.closed) return;
      await this.harness.commit(async tx => {
        const catalog = await tx.doc(CatalogDoc);
        catalog.connections[connection.key] = connection.catalog;
      }, context);
      await this.onChanged();
    }, "source" in config ? this.managed : undefined, operation => this.runBackground(operation));
  }

  private syncManaged() {
    if (!this.managed || !this.companyId) return;
    for (const record of this.managed.list(this.companyId)) {
      if (this.connections.some(connection => connection.isManaged && connection.config.id === record.id)) continue;
      this.connections.push(this.create({ id: record.id, agentId: "oauth", name: record.name, endpoint: record.endpoint,
        identity: record.identity, instructions: "", applyToExisting: false, source: "oauth" }));
    }
  }

  async reloadManaged(id?: string) {
    this.syncManaged();
    const saved = await this.harness.snapshot(CatalogDoc, context);
    for (const connection of this.connections.filter(item => item.isManaged && (!id || item.config.id === id))) {
      connection.restore(saved?.connections[connection.key]);
      await connection.reconnect().catch(() => {});
    }
    await this.onChanged();
  }

  static async load(filename: string, registry: Registry, managed?: McpConnections, companyId?: string) {
    let raw: string;
    try { raw = await readFile(filename, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new AgentConnections([], registry, managed, companyId); throw error; }
    const configs = z.object({ connections: z.array(connectionSchema) }).strict().parse(JSON.parse(raw)).connections;
    const keys = configs.map(config => `${config.agentId}/${config.id}`);
    if (new Set(keys).size !== keys.length) throw new Error("Each agent MCP connection must have a unique ID.");
    return new AgentConnections(configs, registry, managed, companyId);
  }

  async open(harness: Harness, connect = true) {
    this.harness = harness;
    const saved = await harness.snapshot(CatalogDoc, context);
    for (const connection of this.connections) connection.restore(saved?.connections[connection.key]);
    // Discovery installs executable definitions before Pi resumes any saved work.
    if (connect) await this.start();
  }

  async start() {
    this.syncManaged();
    await Promise.all(this.connections.map(connection => connection.connect().catch(() => {})));
  }

  private selected(agentId: string, managedIds: string[] = []) {
    return this.connections.filter(connection => connection.isManaged ? managedIds.includes(connection.config.id) : connection.config.agentId === agentId);
  }
  forAgent(agentId: string, managedIds: string[] = []): AgentConnection[] { return this.selected(agentId, managedIds).map(connection => connection.descriptor()); }
  status(agentId: string, managedIds: string[] = []): AgentConnectionStatus[] { return this.selected(agentId, managedIds).map(connection => connection.status()); }
  managedStatus(id: string) { return this.connections.find(connection => connection.isManaged && connection.config.id === id)?.status(); }
  async reconnect(agentId: string, id: string, managedIds: string[] = []) {
    const connection = this.selected(agentId, managedIds).find(item => item.config.id === id);
    if (!connection) throw new Error("MCP connection not found.");
    await connection.reconnect().catch(() => {});
    return this.status(agentId, managedIds);
  }
  has(agentId: string) { return this.connections.some(connection => connection.config.agentId === agentId); }

  selection(agentId: string, managedIds: string[] = []) {
    const connections = this.selected(agentId, managedIds);
    return { extensions: connections.map(connection => connection.extensionName), tools: connections.flatMap(connection => connection.toolNames()) };
  }

  async boundConnections(tx: Tx, conversationId: ConversationId) {
    const binding = await tx.doc(BindingDoc, conversationId);
    return this.connections.filter(connection => binding.connections.includes(connection.key)).map(connection => connection.descriptor());
  }

  async bind(tx: Tx, conversationId: ConversationId, agentId: string, existing = false, managedIds: string[] = [], applyManaged = false) {
    const binding = await tx.doc(BindingDoc, conversationId);
    const connections = this.connections.filter(connection => connection.isManaged
      ? (existing && !applyManaged ? binding.connections.includes(connection.key) : managedIds.includes(connection.config.id))
      : connection.config.agentId === agentId && (!existing || connection.config.applyToExisting || binding.connections.includes(connection.key)));
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

  private workerConnection(connection: Pick<AgentConnection, "id" | "extension">) {
    const found = this.connections.find(item => item.config.id === connection.id && item.extensionName === connection.extension);
    if (!found) throw new Error("MCP connection is unavailable.");
    return found;
  }

  workerDefinition(connection: Pick<AgentConnection, "id" | "extension">): WorkerConnectionDefinition {
    return this.workerConnection(connection).workerDefinition();
  }

  /** Only the backend's attempt/actor-authorized invocation path may use this bridge.
   * Keep the call admitted across reconnect, credential callbacks and the external request.
   */
  callWorkerTool(connection: Pick<AgentConnection, "id" | "extension">, toolName: string, args: Record<string, unknown>, options: WorkerMcpCallOptions): Promise<CallToolResult> {
    return this.runBackground(() => this.workerConnection(connection).callRegisteredTool(toolName, args, options));
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

  constructor(readonly config: ConnectionConfig, private readonly registry: Registry, private readonly changed: (connection: McpConnection) => Promise<void>, private readonly managed?: McpConnections, private readonly runBackground: <T>(operation: () => Promise<T>) => Promise<T> = operation => operation()) {
    this.key = `${config.agentId}/${config.id}`;
    this.extensionName = `dispatch-mcp-${config.agentId}-${config.id}`;
  }

  get isManaged() { return !!this.managed; }

  private get managedRecord(): ManagedConnectionRecord | undefined { return this.managed?.record(this.config.id); }

  descriptor(record = this.managedRecord): AgentConnection {
    return { id: this.config.id, name: this.config.name, endpoint: this.config.endpoint, identity: record?.identity || this.config.identity,
      extension: this.extensionName, source: this.managed ? "managed" : "operator",
      ...(record?.serverName || this.catalog.serverName ? { serverName: record?.serverName || this.catalog.serverName } : {}) };
  }

  status(): AgentConnectionStatus {
    const managed = this.managedRecord;
    return { ...this.descriptor(managed), status: this.error || (managed && managed.authorization !== "authorized") ? "unavailable" : this.client?.connectionState === "connected" ? "connected" : "disconnected",
      checkedAt: this.catalog.checkedAt || null,
      tools: this.catalog.tools.map(tool => ({ name: tool.name, description: tool.description ?? "", ...(tool.title || tool.annotations?.title ? { title: tool.title || tool.annotations?.title } : {}) })),
      ...(managed ? { scopes: managed.scopes, authentication: managed.authentication, authorization: managed.authorization,
        ...(managed.disconnectNotice ? { disconnectNotice: managed.disconnectNotice } : {}) } : {}),
      ...(managed?.error || this.error ? { error: managed?.error || this.error } : {}) };
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
    const managed = this.managedRecord;
    if (managed && managed.authorization !== "authorized") return Promise.reject(new Error(managed.error ?? "Connect this server in Settings → Connections."));
    if (this.connecting) return this.connecting;
    if (this.client?.connectionState === "connected" && !this.error) return Promise.resolve();
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async reconnect() {
    if (this.connecting) await this.connecting.catch(() => {});
    await this.client?.close();
    this.client = undefined;
    return this.connect();
  }

  private async open() {
    await this.client?.close();
    const client = new McpClient({ name: "dispatch-web", version: "0.1.0" });
    this.client = client;
    client.onClose(() => { if (!this.closed) this.error = `${this.config.name} disconnected. The next tool call will reconnect.`; });
    client.onNotification("notifications/tools/list_changed", () => { void this.runBackground(() => this.discover(client)).catch(() => { this.error = "The tool list could not be refreshed."; }); });
    try {
      if (this.managed) {
        await this.runBackground(() => this.managed!.beforeConnect(this.config.id));
        const auth = this.managed.authProvider(this.config.id);
        await client.connect(new StreamableHttpTransport({ url: this.config.endpoint, authProvider: {
          // SSE reconnect and transport close can renew credentials independently
          // of discovery or an HTTP request. Track the entire renewal as a writer.
          token: () => this.runBackground(() => auth.token()),
          onUnauthorized: input => this.runBackground(async () => { await auth.onUnauthorized?.(input); }),
        }, fetch: (input, init) => this.managed!.fetch(this.config.id, input, init) }));
      } else if ("command" in this.config) {
        await client.connect(new StdioTransport({ command: this.config.command, args: this.config.args, inheritEnv: false, stderr: "pipe" }));
      }
      await this.discover(client);
    } catch {
      await client.close().catch(() => {});
      this.error = this.managedRecord?.error ?? `${this.config.name} could not connect. Check its registration and service configuration.`;
      throw new Error(this.error);
    }
  }

  private async discover(client: McpClient) {
    const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
    if (this.closed || this.client !== client) return;
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("MCP returned duplicate tool names.");
    const instructions = client.instructions ?? "";
    if (!this.managed) verifyLegacyOperatorIdentity(this.config.identity, instructions, tools.map(tool => tool.name));
    const serverName = client.serverInfo?.title || client.serverInfo?.name || "";
    await this.managed?.recordServer(this.config.id, serverName, instructions);
    this.catalog = { tools: JSON.parse(JSON.stringify(tools)) as JsonRepresentation<Tool>[], instructions, checkedAt: Date.now(), ...(serverName ? { serverName } : {}) };
    this.error = undefined;
    this.install();
    await this.changed(this);
  }

  workerDefinition(): WorkerConnectionDefinition {
    return JSON.parse(JSON.stringify({ id: this.config.id, extension: this.extensionName,
      instructions: [`Connection: ${this.config.name}. MCP server: ${this.config.endpoint}. Use its tools within the connection's granted access.`, this.config.instructions, this.catalog.instructions].filter(Boolean).join("\n\n"),
      tools: this.catalog.tools.map(tool => ({ name: this.toolName(tool.name), description: `${tool.description ?? tool.name}\nConnection: ${this.config.name} (${this.config.endpoint}).`, inputSchema: tool.inputSchema })),
    })) as WorkerConnectionDefinition;
  }

  async callRegisteredTool(name: string, args: Record<string, unknown>, options: Pick<McpRequestOptions, "signal" | "onProgress"> & { beforeCall?: () => Promise<void>; assertCurrent?: () => void }): Promise<CallToolResult> {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    await this.connect();
    // Reconnect/discovery/credential renewal can yield across a policy change.
    await options.beforeCall?.();
    options.signal?.throwIfAborted();
    if (this.closed || (this.managed && this.managedRecord?.authorization !== "authorized")) throw new Error("MCP connection is disabled.");
    const tool = this.catalog.tools.find(tool => this.toolName(tool.name) === name);
    if (!tool) throw new Error("This MCP tool is no longer available.");
    // No await between the attempt fence and handing the call to the transport.
    // Retirement still joins admitted calls; this check cannot undo remote effects.
    options.assertCurrent?.();
    return this.client!.callTool(tool.name, args, { signal: options.signal, onProgress: options.onProgress });
  }

  private install() {
    this.registry.install(defineExtension({
      name: this.extensionName,
      sections: [section(`mcp_${createHash("sha256").update(this.key).digest("hex").slice(0, 12)}`, () => [
        `Connection: ${this.config.name}. MCP server: ${this.config.endpoint}. Use its tools within the connection's granted access.`,
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
          const result = await this.callRegisteredTool(this.toolName(tool.name), args, { signal: ctx.abortSignal, onProgress: progress => { if (progress.message) api.output(progress.message + "\n"); } });
          return { content: toLlmContent(result), isError: result.isError === true, details: JSON.parse(JSON.stringify(result)) as JsonValue };
        },
      })),
    }));
  }

  async close() { this.closed = true; await this.connecting?.catch(() => {}); await this.client?.close(); }
}
