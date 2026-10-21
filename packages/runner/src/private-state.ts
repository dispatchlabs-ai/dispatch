import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { privateWindowsPaths } from "./windows-permissions.js";

async function restrict(handle: FileHandle, directory: boolean): Promise<void> {
  const info = await handle.stat();
  if (info.uid !== process.geteuid?.() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
    throw new Error("Runner state must be owned by the current user, with regular files and no hard links.");
  }
  const mode = directory ? 0o700 : 0o600;
  await handle.chmod(mode);
  if (((await handle.stat()).mode & 0o777) !== mode) {
    throw new Error("Cannot establish private runner state permissions.");
  }
}

/** Only the owning account may traverse state, including while SQLite creates sidecars. */
export async function privateStateDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    await privateWindowsPaths([{ path: directory, directory: true, create: true }]);
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await restrict(handle, true); } finally { await handle.close(); }
}

/** Called under the session's owner lock, before SQLite opens or recovers any files. */
export async function privateStateFiles(directory: string): Promise<void> {
  const names = ["session.sqlite", "session.sqlite-wal", "session.sqlite-shm", "session.sqlite-journal", "status.json", "status.json.tmp"];
  if (process.platform === "win32") {
    await privateWindowsPaths(names.map(name => ({ path: join(directory, name), directory: false, create: name === "session.sqlite" })));
    return;
  }
  for (const name of names) {
    const create = name === "session.sqlite";
    let handle: FileHandle;
    try {
      handle = await open(join(directory, name),
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0), 0o600);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try { await restrict(handle, false); } finally { await handle.close(); }
  }
}
