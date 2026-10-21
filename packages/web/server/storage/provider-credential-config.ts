import { readRestrictedConfigurationFile } from "./restricted-config-file.js";
import { verifiedPostgresConfig } from "./postgres/tls.js";
import { z } from "zod";
import { PostgresCredentialStore } from "./provider-credentials.js";

export const providerCredentialConfigSchema = z.object({
  installationId: z.string().min(1).max(200),
  databaseUrlFile: z.string().startsWith("/"),
  databaseCaFile: z.string().startsWith("/"),
  encryptionKeyFile: z.string().startsWith("/"),
}).strict();
export type ProviderCredentialConfig = z.infer<typeof providerCredentialConfigSchema>;

export async function readProviderCredentialConfig(filename: string): Promise<ProviderCredentialConfig> {
  try { return providerCredentialConfigSchema.parse(JSON.parse((await readRestrictedConfigurationFile(filename, false)).toString("utf8"))); }
  catch { throw new Error("Cannot read provider credential configuration; check schema, ownership and permissions."); }
}

/** Shared by the backend and stopped-backend maintenance CLI; TLS is mandatory. */
export async function openConfiguredProviderCredentials(input: ProviderCredentialConfig, recoverOwnerId?: string): Promise<PostgresCredentialStore> {
  let encryptionKey: Buffer | undefined;
  let urlBytes: Buffer | undefined;
  try {
    const config = providerCredentialConfigSchema.parse(input);
    urlBytes = await readRestrictedConfigurationFile(config.databaseUrlFile, true);
    const connectionString = urlBytes.toString("utf8").trim();
    const ca = (await readRestrictedConfigurationFile(config.databaseCaFile, false)).toString("utf8");
    const database = verifiedPostgresConfig(connectionString, ca);
    encryptionKey = await readRestrictedConfigurationFile(config.encryptionKeyFile, true);
    return await PostgresCredentialStore.open({
      installationId: config.installationId, encryptionKey, recoverOwnerId,
      database,
    });
  } catch {
    throw new Error("Cannot open provider credential configuration/store; check verified TLS, restricted files, key and retired-owner recovery.");
  } finally {
    encryptionKey?.fill(0);
    urlBytes?.fill(0);
  }
}
