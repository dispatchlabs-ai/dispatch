export function describeAgentTools(tools: readonly string[]) {
  const native = tools.filter(name => !name.startsWith("mcp_"));
  const connected = tools.length - native.length;
  if (connected) native.push(`${connected} connection ${connected === 1 ? "tool" : "tools"}`);
  return native.join(", ") || "Conversation only";
}
