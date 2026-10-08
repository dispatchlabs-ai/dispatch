import { z } from "zod";
import { McpConnections } from "../mcp-connections.js";
import { verifiedPostgresConfig } from "./postgres/tls.js";
import { readRestrictedConfigurationFile } from "./restricted-config-file.js";

export const mcpConnectionConfigSchema = z.object({
  installationId: z.string().min(1).max(200),
  databaseUrlFile: z.string().startsWith("/"),
  databaseCaFile: z.string().startsWith("/"),
  encryptionKeyFile: z.string().startsWith("/"),
}).strict();
export type McpConnectionConfig = z.infer<typeof mcpConnectionConfigSchema>;

export async function readMcpConnectionConfig(filename: string): Promise<McpConnectionConfig> {
  try { return mcpConnectionConfigSchema.parse(JSON.parse((await readRestrictedConfigurationFile(filename, false)).toString("utf8"))); }
  catch { throw new Error("Cannot read MCP connection configuration; check schema, ownership and permissions."); }
}

/** Opens quiesced. The backend must apply persisted drain before resuming. */
export async function openConfiguredMcpConnections(input: McpConnectionConfig, origin: string, recoverOwnerId?: string): Promise<McpConnections> {
  let encryptionKey: Buffer | undefined;
  let urlBytes: Buffer | undefined;
  try {
    const config = mcpConnectionConfigSchema.parse(input);
    urlBytes = await readRestrictedConfigurationFile(config.databaseUrlFile, true);
    const ca = (await readRestrictedConfigurationFile(config.databaseCaFile, false)).toString("utf8");
    const database = verifiedPostgresConfig(urlBytes.toString("utf8").trim(), ca);
    encryptionKey = await readRestrictedConfigurationFile(config.encryptionKeyFile, true);
    return await McpConnections.openPostgres({ installationId: config.installationId, database, encryptionKey, origin, recoverOwnerId });
  } catch {
    throw new Error("Cannot open MCP configuration/store; check verified TLS, restricted files, key and retired-owner recovery.");
  } finally {
    encryptionKey?.fill(0);
    urlBytes?.fill(0);
  }
}
