import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ProjectSpecError, SPEC_MAX_BYTES } from "./project-spec.js";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const saves = new Map<string, Promise<unknown>>();

/** Only the configured existing file; never accept a browser-supplied absolute path. */
async function target(cwd: string, path: string) {
  if (!isAbsolute(cwd) || /[\\:\0]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new ProjectSpecError(400, "Invalid project directory or spec path.");
  }
  const base = await realpath(cwd);
  const file = resolve(base, path);
  const local = relative(base, file);
  if (local.startsWith("../") || isAbsolute(local)) throw new ProjectSpecError(400, "Spec must be inside the project directory.");
  let current = base;
  for (const part of path.split("/")) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new ProjectSpecError(400, "Symlink spec paths are not supported. Choose a regular file inside the project directory.");
  }
  if (await realpath(file) !== file) throw new ProjectSpecError(409, "Spec path changed. Reload before saving.");
  return file;
}

async function snapshot(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new ProjectSpecError(400, "Spec must be a regular file.");
    if (before.size > SPEC_MAX_BYTES) throw new ProjectSpecError(413, "Spec exceeds the 512 KiB limit.");
    const bytes = Buffer.alloc(SPEC_MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, size);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > SPEC_MAX_BYTES) throw new ProjectSpecError(413, "Spec exceeds the 512 KiB limit.");
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ProjectSpecError(409, "Spec changed while reading. Reload.");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)); }
    catch { throw new ProjectSpecError(400, "Spec must be UTF-8 text."); }
    if (content.includes("\0")) throw new ProjectSpecError(400, "Spec must be a text file without NUL bytes.");
    const commit = digest(bytes.subarray(0, size));
    const version = digest(JSON.stringify([file, after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs, commit]));
    return { content, commit, version, mode: after.mode, links: after.nlink };
  } finally { await handle.close(); }
}

async function safe<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof ProjectSpecError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new ProjectSpecError(code === "ENOENT" ? 404 : 400, code === "ENOENT" ? "Spec file or directory is missing." : "Spec file could not be accessed. Check its path and filesystem permissions.");
  }
}

export function readLocalProjectSpec(cwd: string, path: string) {
  return safe(async () => { const { content, commit, version } = await snapshot(await target(cwd, path)); return { content, commit, version }; });
}

/** Atomic replacement avoids partial files. Serialize Dispatch saves; external writers are not locked. */
export async function saveLocalProjectSpec(cwd: string, path: string, expectedVersion: string, content: string, authorize: () => Promise<void>) {
  const key = await safe(() => target(cwd, path));
  const previous = saves.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => safe(async () => {
    await authorize();
    const file = await target(cwd, path);
    if (file !== key) throw new ProjectSpecError(409, "Spec directory changed. Reload before saving.");
    const before = await snapshot(file);
    if (before.version !== expectedVersion) {
      // Confirm only that these bytes are present now; do not attribute a prior write.
      if (before.content === content) return { content: before.content, commit: before.commit, version: before.version };
      throw new ProjectSpecError(409, "Spec changed on disk. Draft retained; reload and review before saving.");
    }
    if (before.links !== 1) throw new ProjectSpecError(400, "Saving hard-linked spec files is not supported.");
    if (Buffer.byteLength(content, "utf8") > SPEC_MAX_BYTES) throw new ProjectSpecError(413, "Spec exceeds the 512 KiB limit.");
    if (content.includes("\0") || Buffer.from(content, "utf8").toString("utf8") !== content) throw new ProjectSpecError(400, "Spec must be valid UTF-8 text without NUL bytes.");
    const temporary = join(dirname(file), `.dispatch-spec-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", before.mode & 0o777);
      try { await handle.writeFile(content, "utf8"); await handle.chmod(before.mode & 0o777); await handle.sync(); }
      finally { await handle.close(); }
      await authorize();
      if (await target(cwd, path) !== file || (await snapshot(file)).version !== expectedVersion) throw new ProjectSpecError(409, "Spec changed on disk. Draft retained; reload and review before saving.");
      await rename(temporary, file);
      const saved = await readLocalProjectSpec(cwd, path);
      if (saved.content !== content) throw new ProjectSpecError(409, "Spec changed again after writing. Save could not be confirmed; draft retained. Reload and review.");
      return saved;
    } finally { await unlink(temporary).catch(() => {}); }
  }));
  saves.set(key, pending);
  try { return await pending; } finally { if (saves.get(key) === pending) saves.delete(key); }
}
