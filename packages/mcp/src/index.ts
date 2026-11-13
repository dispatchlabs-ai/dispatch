import { readFileSync } from "node:fs";
import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { type AgentClient, ServiceError } from "@dispatch/runner/client";
import { z } from "zod";

export { serveMcpHttp, type McpHttpOptions } from "./http.js";

const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const identifier = z.string().refine(value => value.trim().length > 0, "Use a nonempty identifier.");
const conversationId = identifier.describe("Conversation ID returned by Dispatch, shared with CLI and Web.");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export type McpClientSource = AgentClient | (() => Promise<AgentClient>);

/** A client of an existing owner. The caller owns the AgentClient and its authority. */
export function createDispatchMcpServer(source: McpClientSource): McpServer {
  async function invoke(context: ServerContext, operation: (command: AgentClient["command"]) => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
      context.mcpReq.signal.throwIfAborted();
      const client = typeof source === "function" ? await source() : source;
      context.mcpReq.signal.throwIfAborted();
      return await operation(command => client.command(command, context.mcpReq.signal));
    } catch (error) {
      return { ...result({ error: { message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ServiceError ? { status: error.status } : {}) } }), isError: true };
    }
  }
  const server = new McpServer({ name: "dispatch", version }, {
    instructions: "Use list_agents to discover available agents. Create or find a conversation, then send_message with a stable requestId. " +
      "Save the conversationId and submissionId; get_result inspects that submission, optionally waiting. get_conversation includes retained history and live progress. " +
      "Reuse the exact requestId and payload after an uncertain send. Closing MCP or cancelling a wait leaves admitted work running. Only stop_conversation stops the agent. " +
      "These are the same conversations used by Dispatch Web and CLI.",
  });

  server.registerTool("list_agents", {
    description: "Discover this host's configured agents and their descriptions. Does not start work.",
    inputSchema: z.object({}), annotations: readOnly,
  }, (_, context) => invoke(context, async command => result({ agents: await command({ method: "agents" }) })));

  server.registerTool("list_conversations", {
    description: "List retained conversations visible to this connection, including CLI, Web and other channels.",
    inputSchema: z.object({ agent: identifier.optional() }), annotations: readOnly,
  }, ({ agent }, context) => invoke(context, async command => result({ conversations: (await command({ method: "chats" })).filter(chat => !agent || chat.agent === agent) })));

  server.registerTool("find_conversation", {
    description: "Find an existing conversation by its stable key. Returns null when absent and never creates or resumes work.",
    inputSchema: z.object({ agent: identifier, key: identifier }), annotations: readOnly,
  }, ({ agent, key }, context) => invoke(context, async command => result({ conversation: await command({ method: "find", agent, key }) })));

  server.registerTool("create_conversation", {
    description: "Create a conversation for an agent, or return the existing conversation for the same agent/key. Choose a unique stable key for a new conversation and retain it for retries. Creates no agent turn.",
    inputSchema: z.object({ agent: identifier, key: identifier, title: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ agent, key, title }, context) => invoke(context, async command => result({ conversation: await command({ method: "create", agent, key, title, source: "mcp" }) })));

  server.registerTool("send_message", {
    description: "Send input or steer ongoing work in an existing conversation. Returns a durable submissionId promptly. The agent can use its configured tools. Keep requestId and the exact payload for an uncertain retry; a new requestId submits new work. Agent work continues after MCP disconnects.",
    inputSchema: z.object({ conversationId, requestId: identifier.describe("Unique stable ID for this input; reuse only with the identical payload."),
      message: z.string(), files: z.array(z.object({ name: identifier, mimeType: z.string(), data: z.string().describe("Base64 file bytes, never a host path or URL.") })).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, ({ conversationId, message, requestId, files }, context) => invoke(context, async command => result({ conversationId, requestId,
    ...await command({ method: "send", id: conversationId, text: message, requestId, mode: "steer", source: "mcp", files }) })));

  server.registerTool("get_conversation", {
    description: "Read the native conversation snapshot: retained messages, thinking summaries, tool calls/results, artifacts, live partial output, queue, errors and turn status. Observation never submits or resumes work.",
    inputSchema: z.object({ conversationId }), annotations: readOnly,
  }, ({ conversationId }, context) => invoke(context, async command => result({ snapshot: await command({ method: "snapshot", id: conversationId }) })));

  server.registerTool("get_result", {
    description: "Read one submission's native receipt and the conversation snapshot containing its answer/results. wait:true waits for that submission to settle. Cancelling or timing out this MCP call cancels observation only; retry with the same conversationId/submissionId. No Dispatch wait deadline is imposed.",
    inputSchema: z.object({ conversationId, submissionId: z.number().int().positive().safe(), wait: z.boolean().optional() }), annotations: readOnly,
  }, ({ conversationId, submissionId, wait }, context) => invoke(context, async command => {
    const receipt = await command({ method: wait ? "wait" : "receipt", id: conversationId, submissionId });
    return result({ conversationId, submissionId, receipt, snapshot: await command({ method: "snapshot", id: conversationId }) });
  }));

  server.registerTool("get_artifact", {
    description: "Retrieve a retained artifact by its ID from a conversation snapshot. Returns metadata and an embedded MCP resource with the original bytes. Cannot read arbitrary host files.",
    inputSchema: z.object({ conversationId, artifactId: identifier }), annotations: readOnly,
  }, ({ conversationId, artifactId }, context) => invoke(context, async command => {
    const { artifact, dataBase64 } = await command({ method: "artifact", id: conversationId, artifactId });
    return { ...result({ artifact }), content: [
      { type: "text", text: JSON.stringify({ artifact }) },
      { type: "resource", resource: { uri: `dispatch://conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(artifactId)}`,
        mimeType: artifact.mimeType, blob: dataBase64 } },
    ] };
  }));

  server.registerTool("stop_conversation", {
    description: "Explicitly stop current work owned by this conversation. Independent agents and completed external effects are unaffected. Inspect the resulting native state; stopping does not delete history.",
    inputSchema: z.object({ conversationId }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ conversationId }, context) => invoke(context, async command => {
    await command({ method: "stop", id: conversationId });
    return result({ snapshot: await command({ method: "snapshot", id: conversationId }) });
  }));
  return server;
}
