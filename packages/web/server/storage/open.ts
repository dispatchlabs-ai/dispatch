import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { lstat, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PostgresStorageOptions } from "./postgres/database.js";

export type PiStorageConfig = { kind: "sqlite" } | ({ kind: "postgres" } & PostgresStorageOptions);

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Caller holds the local runtime-owner lock. Backend selection never migrates or merges state. */
export async function openPiStorage(directory: string, config: PiStorageConfig) {
  const sqlite = join(directory, "pi.sqlite");
  const marker = join(directory, "postgres-store.json");
  if (config.kind === "sqlite") {
    if (await exists(marker)) throw new Error("This runtime directory belongs to PostgreSQL; use its original configuration or a fresh directory");
    const storage = await openNodeSqliteStorage(sqlite);
    try { await chmod(sqlite, 0o600); }
    catch (error) { await storage.close(BACKGROUND_CONTEXT); throw error; }
    return storage;
  }
  if (await exists(sqlite)) throw new Error("PostgreSQL mode requires a separate runtime directory without pi.sqlite; migration is not supported");
  const url = new URL(config.connectionString);
  // Prevent PGPORT from silently selecting a different database endpoint than the marker.
  url.port ||= "5432";
  // No passwords, usernames or TLS parameters in the local identity marker.
  const identity = JSON.stringify({ storeId: config.storeId, endpoint: `${url.hostname}:${url.port || "5432"}${url.pathname}` });
  if (await exists(marker)) {
    if (await readFile(marker, "utf8") !== identity) {
      throw new Error("This runtime directory is bound to a different PostgreSQL store; use the original settings or a fresh directory");
    }
  } else {
    // Bind before opening remote state; a failed attempt remains explicitly PostgreSQL-only.
    await writeFile(marker, identity, { flag: "wx", mode: 0o600 });
  }
  const { PostgresStorage } = await import("./postgres/storage.js");
  return PostgresStorage.open({ ...config, connectionString: url.toString() });
}
