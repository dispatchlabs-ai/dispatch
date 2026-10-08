import { constants } from "node:fs";
import { open } from "node:fs/promises";
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

/** Restricted regular files only. Never repair permissions or regenerate keys. */
async function readConfigurationFile(filename: string, secret: boolean): Promise<Buffer> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    const uid = process.geteuid?.();
    const permissionsValid = secret
      ? (stat.mode & 0o7777) === 0o600 && stat.uid === uid
      : (stat.mode & 0o022) === 0 && (stat.uid === 0 || stat.uid === uid);
    if (!stat.isFile() || stat.size > 1_048_576 || !permissionsValid)
      throw new Error("Provider credential configuration requires restricted operator-owned regular files.");
    return await file.readFile();
  } finally { await file.close(); }
}

export async function readProviderCredentialConfig(filename: string): Promise<ProviderCredentialConfig> {
  try { return providerCredentialConfigSchema.parse(JSON.parse((await readConfigurationFile(filename, false)).toString("utf8"))); }
  catch { throw new Error("Cannot read provider credential configuration; check schema, ownership and permissions."); }
}

/** Shared by the backend and stopped-backend maintenance CLI; TLS is mandatory. */
export async function openConfiguredProviderCredentials(input: ProviderCredentialConfig, recoverOwnerId?: string): Promise<PostgresCredentialStore> {
  let encryptionKey: Buffer | undefined;
  let urlBytes: Buffer | undefined;
  try {
    const config = providerCredentialConfigSchema.parse(input);
    urlBytes = await readConfigurationFile(config.databaseUrlFile, true);
    const connectionString = urlBytes.toString("utf8").trim();
    const ca = (await readConfigurationFile(config.databaseCaFile, false)).toString("utf8");
    const database = verifiedPostgresConfig(connectionString, ca);
    encryptionKey = await readConfigurationFile(config.encryptionKeyFile, true);
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
