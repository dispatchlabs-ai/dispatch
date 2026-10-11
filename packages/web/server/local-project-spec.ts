import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ProjectSpecError, SPEC_MAX_BYTES } from "./project-spec.js";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

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
  if (await realpath(file) !== file) throw new ProjectSpecError(409, "Spec path changed. Reload before importing.");
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
    return { content, commit, version };
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
