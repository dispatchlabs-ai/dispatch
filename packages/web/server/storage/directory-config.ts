import { z } from "zod";
import type { PiStorageConfig } from "./open.js";
import { readRestrictedConfigurationFile } from "./restricted-config-file.js";
import { verifiedPostgresConfig } from "./postgres/tls.js";

export const directoryStoreConfigSchema = z.object({
  storeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  databaseUrlFile: z.string().startsWith("/"),
  databaseCaFile: z.string().startsWith("/"),
}).strict();

/** Load only: no database connection, migration, or local store-marker changes. */
export async function readDirectoryStoreConfig(filename: string): Promise<Extract<PiStorageConfig, { kind: "postgres" }>> {
  let urlBytes: Buffer | undefined;
  try {
    const config = directoryStoreConfigSchema.parse(JSON.parse(
      (await readRestrictedConfigurationFile(filename, false)).toString("utf8"),
    ));
    urlBytes = await readRestrictedConfigurationFile(config.databaseUrlFile, true);
    const connectionString = urlBytes.toString("utf8").trim();
    const ca = (await readRestrictedConfigurationFile(config.databaseCaFile, false)).toString("utf8");
    verifiedPostgresConfig(connectionString, ca);
    return { kind: "postgres", storeId: config.storeId, connectionString, ca };
  } catch {
    // Do not expose credentials, filenames or parser diagnostics to callers.
    throw new Error("Cannot read directory store configuration; check schema, restricted files and verified TLS.");
  } finally {
    urlBytes?.fill(0);
  }
}
