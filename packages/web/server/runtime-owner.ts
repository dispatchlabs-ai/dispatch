import { chmod, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A held SQLite transaction supplies an OS-backed lock that releases on process death. */
export async function acquireRuntimeOwner(stateDir: string) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await realpath(stateDir);
  await chmod(directory, 0o700);
  const filename = join(directory, "runtime-owner.sqlite");
  const database = new DatabaseSync(filename);
  try {
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER)");
    await chmod(filename, 0o600);
  } catch (cause) {
    database.close();
    throw new Error("This state directory is already owned by another Dispatch service, or its ownership lock is unavailable.", { cause });
  }
  return { directory, release: () => database.close() };
}
