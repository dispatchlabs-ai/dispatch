import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { toLlmContent, type CallToolResult } from "@earendil-works/pi-mcp";
import { z } from "zod";
import { DispatchRuntime, RuntimeError, type WorkerManagementActor, type WorkerMcp } from "../runtime.js";
import type { WorkerConnectionDefinition } from "../mcp.js";

const identity = z.string().min(1).max(200);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const definitionSchema = z.object({
  id: identity, extension: z.string().startsWith("dispatch-mcp-"), instructions: z.string(),
  tools: z.array(z.object({ name: z.string().startsWith("mcp_"), description: z.string(),
    inputSchema: z.object({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()).optional() }).passthrough(),
  }).strict()),
}).strict();
const definitionsSchema = z.object({ conversationKey: identity, revision, connections: z.array(definitionSchema) }).strict();
const definitionRequest = z.object({ revision }).strict();
const callRequest = z.object({
  actor: z.custom<WorkerManagementActor>(value => typeof value === "object" && value !== null),
  connectionId: identity, toolName: identity, args: z.record(z.string(), z.unknown()),
}).strict();
export type WorkerMcpRequest = <T>(operation: "definitions" | "call", input: unknown, signal?: AbortSignal) => Promise<T>;
export type WorkerMcpRoute = { companyId: string; conversationId: string; storeId: string };

/** Install ordinary native Pi tools. They resolve their actual native instance on every call;
 * no worker receives external credentials or chooses a transport endpoint/command.
 */
export function workerMcp(request: WorkerMcpRequest): WorkerMcp {
  return { prepare: async (registry, membership, actorForInstance) => {
    const agents = membership.agents.filter(agent => agent.membership === "active");
    if (!agents.some(agent => agent.mcp.extensions.length)) return;
    const response = definitionsSchema.parse(await request("definitions", { revision: membership.revision }));
    if (response.conversationKey !== membership.conversationKey || response.revision !== membership.revision)
      throw new RuntimeError(409, "MCP definition projection changed.");
    const keys = new Set<string>();
    for (const connection of response.connections) {
      const key = JSON.stringify([connection.id, connection.extension]);
      if (keys.has(key) || new Set(connection.tools.map(tool => tool.name)).size !== connection.tools.length)
        throw new RuntimeError(409, "Duplicate MCP definition identity.");
      keys.add(key);
      const pins = agents.filter(agent => agent.mcp.connections.some(selected => selected.id === connection.id && selected.extension === connection.extension));
      if (!pins.length || connection.tools.some(tool => !pins.some(pin => pin.mcp.tools.includes(tool.name))))
        throw new RuntimeError(409, "MCP definition exceeds participant selections.");
      registry.install(defineExtension({ name: connection.extension,
        sections: [section(`mcp_${createHash("sha256").update(connection.extension).digest("hex").slice(0, 12)}`, () => connection.instructions)],
        tools: connection.tools.map(tool => defineTool({
          name: tool.name, description: tool.description,
          parameters: Type.Unsafe<Record<string, unknown>>({ ...tool.inputSchema, properties: tool.inputSchema.properties ?? {} }),
          // A lost RPC response may follow an external effect. Pi must not replay it on recovery.
          replay: "unsafe",
          execute: async (args, api, ctx) => {
            const actor = await actorForInstance(api.conversationId);
            ctx.abortSignal?.throwIfAborted();
            const result = await request<CallToolResult>("call", { actor, connectionId: connection.id, toolName: tool.name, args }, ctx.abortSignal);
            return { content: toLlmContent(result), isError: result.isError === true, details: JSON.parse(JSON.stringify(result)) as JsonValue };
          },
        })),
      }));
    }
    for (const pin of agents) for (const name of pin.mcp.tools) {
      if (!response.connections.some(connection => pin.mcp.extensions.includes(connection.extension) && connection.tools.some(tool => tool.name === name)))
        throw new RuntimeError(409, "Selected MCP tool is absent from the definition projection.");
    }
  } };
}

/** Call only inside current-attempt authentication and support admission. The caller must
 * order policy changes against invocation admission; this is not an independent HTTP server.
 */
export function backendWorkerMcp(directory: DispatchRuntime) {
  const bridge = directory.workerMcpBridge();
  return {
    async definitions(route: WorkerMcpRoute, raw: unknown) {
      const input = definitionRequest.parse(raw);
      const { membership } = await directory.directoryWorkerBootstrap(route.companyId, route.conversationId);
      if (membership.revision !== input.revision) throw new RuntimeError(409, "MCP membership changed; reconcile before preparing tools.");
      const connections = new Map<string, WorkerConnectionDefinition>();
      for (const pin of membership.agents.filter(agent => agent.membership === "active")) for (const selected of pin.mcp.connections) {
        if (!pin.mcp.extensions.includes(selected.extension)) continue;
        const key = JSON.stringify([selected.id, selected.extension]);
        const definition = bridge.definition(selected);
        const tools = definition.tools.filter(tool => pin.mcp.tools.includes(tool.name));
        const existing = connections.get(key);
        if (existing) {
          for (const tool of tools) if (!existing.tools.some(prior => prior.name === tool.name)) existing.tools.push(tool);
        } else connections.set(key, { ...definition, tools });
      }
      return definitionsSchema.parse({ conversationKey: route.conversationId, revision: membership.revision, connections: [...connections.values()] });
    },
    async call(route: WorkerMcpRoute, raw: unknown, signal: AbortSignal | undefined, assertCurrent: () => void): Promise<CallToolResult> {
      assertCurrent();
      const { actor, connectionId, toolName, args } = callRequest.parse(raw);
      if (actor.companyId !== route.companyId || actor.conversationKey !== route.conversationId || actor.storeId !== route.storeId)
        throw new RuntimeError(403, "MCP actor is outside the authenticated worker route.");
      const authorized = await directory.authorizeWorkerMcp(actor, connectionId, toolName);
      assertCurrent();
      return bridge.call(authorized.connection, toolName, args, { signal, assertCurrent,
        // A reconnect can cross a rollout/revocation; recheck backend pins immediately before callTool.
        beforeCall: async () => { await directory.authorizeWorkerMcp(actor, connectionId, toolName); assertCurrent(); },
      });
    },
  };
}
