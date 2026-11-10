import { constants } from "node:fs";
import { access, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";

export const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
export const sessionRenewal = 24 * 60 * 60 * 1000;
type State = { version: 1; credential: string; sessions: Record<string, number> };

/** One hosted Web writer; only token digests/expiry ever reach this private file. */
export async function sessionState(path: string | undefined, credential: string) {
  if (!path || !isAbsolute(path)) throw new Error("Set DISPATCH_SESSION_STATE_FILE to a stable absolute private state file.");
  const file = path, directory = dirname(file);
  async function checkDirectory() {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(directory) !== directory)
      throw new Error("Session state requires a canonical owned private directory.");
    await access(directory, constants.W_OK);
  }
  async function read(): Promise<State> {
    await checkDirectory();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600)
        throw new Error("Session state must be an owned regular 0600 file.");
      const value = JSON.parse(await handle.readFile("utf8"));
      if (Object.keys(value ?? {}).some(key => !["version", "credential", "sessions"].includes(key)) || value?.version !== 1 || typeof value.credential !== "string" || !/^[a-f0-9]{64}$/.test(value.credential) ||
          !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions) ||
          Object.entries(value.sessions).some(([key, expires]) => !/^[a-f0-9]{64}$/.test(key) ||
            !Number.isSafeInteger(expires) || Number(expires) <= 0 || Number(expires) > Date.now() + sessionLifetime))
        throw new Error("Invalid session state; authentication is unavailable.");
      return value;
    } finally { await handle.close(); }
  }
  async function write(state: State, existing = true) {
    await checkDirectory();
    // Validate the current file before replacing it; never repair unsafe/corrupt state implicitly.
    if (existing) await read();
    const temporary = join(directory, `.session-${randomBytes(16).toString("hex")}`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, file);
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  const empty = (): State => ({ version: 1, credential, sessions: {} });
  await checkDirectory();
  try { await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await write(empty(), false);
  }
  const initial = await read();
  // Probe atomic persistence even without a login. Unwritable state cannot serve auth.
  await write(initial.credential === credential ? initial : empty());
  return {
    read: async () => {
      const state = await read();
      if (state.credential !== credential) {
        await write(empty());
        return empty();
      }
      return state;
    },
    write,
  };
}
