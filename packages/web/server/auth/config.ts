import { readRestrictedConfigurationFile as readConfigurationFile } from "../storage/restricted-config-file.js";
import { verifiedPostgresConfig } from "../storage/postgres/tls.js";
import { z } from "zod";
import { AuthService, type AuthIdentityConfig } from "../auth.js";

export const authStoreConfigSchema = z.object({
  installationId: z.string().min(1).max(200),
  databaseUrlFile: z.string().startsWith("/"),
  databaseCaFile: z.string().startsWith("/"),
  encryptionKeyFile: z.string().startsWith("/"),
}).strict();
export type AuthStoreConfig = z.infer<typeof authStoreConfigSchema>;

export async function readAuthStoreConfig(filename: string): Promise<AuthStoreConfig> {
  try { return authStoreConfigSchema.parse(JSON.parse((await readConfigurationFile(filename, false)).toString("utf8"))); }
  catch { throw new Error("Cannot read authentication configuration; check schema, ownership and permissions."); }
}

/** Shared by the backend and operator CLI; TLS is mandatory. */
export async function openConfiguredAuth(input: AuthStoreConfig, identity: AuthIdentityConfig): Promise<AuthService> {
  let encryptionKey: Buffer | undefined;
  let urlBytes: Buffer | undefined;
  try {
    const config = authStoreConfigSchema.parse(input);
    urlBytes = await readConfigurationFile(config.databaseUrlFile, true);
    const connectionString = urlBytes.toString("utf8").trim();
    const ca = (await readConfigurationFile(config.databaseCaFile, false)).toString("utf8");
    const database = verifiedPostgresConfig(connectionString, ca);
    encryptionKey = await readConfigurationFile(config.encryptionKeyFile, true);
    return await AuthService.openPostgres({
      installationId: config.installationId, encryptionKey, ...identity,
      database,
    });
  } catch {
    throw new Error("Cannot open authentication configuration/store; check verified TLS, restricted files, key.");
  } finally {
    encryptionKey?.fill(0);
    urlBytes?.fill(0);
  }
}
