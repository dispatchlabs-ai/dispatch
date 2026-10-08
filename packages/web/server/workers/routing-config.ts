import { z } from "zod";
import { readRestrictedConfigurationFile } from "../storage/restricted-config-file.js";
import { verifiedPostgresConfig } from "../storage/postgres/tls.js";
import { WorkerRoutes } from "./routes.js";

export const routingStoreConfigSchema = z.object({
  installationId: z.string().min(1).max(200),
  databaseUrlFile: z.string().startsWith("/"),
  databaseCaFile: z.string().startsWith("/"),
}).strict();
export type RoutingStoreConfig = z.infer<typeof routingStoreConfigSchema>;

export async function readRoutingStoreConfig(filename: string): Promise<RoutingStoreConfig> {
  try { return routingStoreConfigSchema.parse(JSON.parse((await readRestrictedConfigurationFile(filename, false)).toString("utf8"))); }
  catch { throw new Error("Cannot read routing configuration; check schema, ownership and permissions."); }
}

/** No implicit owner takeover. The caller must independently confirm retirement
 * before supplying an invocation-only recovery ID, never a retained config field.
 */
export async function openConfiguredWorkerRoutes(input: RoutingStoreConfig, recoverOwnerId?: string): Promise<WorkerRoutes> {
  let urlBytes: Buffer | undefined;
  try {
    const config = routingStoreConfigSchema.parse(input);
    urlBytes = await readRestrictedConfigurationFile(config.databaseUrlFile, true);
    const ca = (await readRestrictedConfigurationFile(config.databaseCaFile, false)).toString("utf8");
    return await WorkerRoutes.openPostgres({
      database: verifiedPostgresConfig(urlBytes.toString("utf8").trim(), ca),
      installationId: config.installationId, recoverOwnerId,
    });
  } catch {
    throw new Error("Cannot open routing configuration/store; check verified TLS, restricted files and confirmed retired-owner recovery.");
  } finally { urlBytes?.fill(0); }
}
