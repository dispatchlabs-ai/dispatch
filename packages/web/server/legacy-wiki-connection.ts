import { z } from "zod";
import { ConnectionError } from "./mcp-oauth.js";

// Compatibility for Wiki credentials created before generic MCP setup. New
// connections do not use this provider-specific identity endpoint or contract.
export async function verifyLegacyWikiIdentity(endpoint: string, token: string, priorAgent: string) {
  const response = await fetch(new URL("/api/agent/run", endpoint), { redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new ConnectionError(401, "The existing Wiki identity could not be verified. Authorize it again.");
  const info = z.object({ agent: z.string().min(1), run: z.string().min(1), mode: z.literal("independent") }).parse(await response.json());
  if (priorAgent && priorAgent !== info.agent) throw new ConnectionError(409, "Choose the original Wiki agent for this existing connection. Use a new connection for another identity.");
  return info;
}

export function legacyWikiIdentity(instructions: string, agent: string) {
  const match = /Authenticated agent: (.+?)\. Definition ([a-f0-9-]+):/s.exec(instructions);
  return match?.[2] === agent ? match[1].slice(0, 200) : agent;
}

export function verifyLegacyOperatorIdentity(identity: string, instructions: string, toolNames: string[]) {
  if (toolNames.some(name => name.startsWith("wiki.")) && !instructions.includes(`Authenticated agent: ${identity}. Definition `)) {
    throw new Error("The operator's Wiki connection authenticated a different identity.");
  }
}
