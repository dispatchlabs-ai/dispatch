import type { ExecutionBackend } from "../shared/contracts";

export const museToolAccessHint = "Native Muse tools use the runner’s access.";

export function describeAgentTools(tools: readonly string[], backend?: ExecutionBackend) {
  const native = tools.filter(name => !name.startsWith("mcp_"));
  const connected = tools.length - native.length;
  if (connected) native.push(`${connected} connection ${connected === 1 ? "tool" : "tools"}`);
  return native.join(", ") || (backend === "muse-code" ? "No optional tools" : "Conversation only");
}
