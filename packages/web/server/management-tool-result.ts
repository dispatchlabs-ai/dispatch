import { z } from "zod";
import { ManagementError } from "./agent-grants.js";
import { ConnectionError } from "./mcp-oauth.js";
import { RuntimeError } from "./runtime-error.js";

/** Catch outside the commit: a refusal must roll back before becoming a tool result. */
export async function managementToolResult(operation: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await operation()) }] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: {
        status: 400, message: "Invalid tool input.", issues: error.issues.slice(0, 5).map(issue => ({ path: issue.path, message: issue.message })),
      } }) }] };
    }
    if (error instanceof ManagementError || ((error instanceof RuntimeError || error instanceof ConnectionError) && error.status >= 400 && error.status < 500)) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { status: error.status, message: error.message } }) }] };
    }
    // Unknown exceptions and interrupted execution remain failures, not invented denials.
    throw error;
  }
}
