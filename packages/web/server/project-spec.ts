/** Status-bearing, user-safe spec loading failure. */
export class ProjectSpecError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const SPEC_MAX_BYTES = 512 * 1024;
const REFS_MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 20_000;
const segment = /^[A-Za-z0-9_.-]{1,100}$/;

/** Returns owner/repository for supported public GitHub URLs, otherwise undefined. */
export function githubRepository(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.search || parsed.hash) return undefined;
  const parts = parsed.pathname.replace(/\/$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length !== 2 || !parts.every(part => segment.test(part) && part !== "." && part !== "..")) return undefined;
  return { owner: parts[0]!, repository: parts[1]! };
}

async function readLimited(response: Response, limit: number, stopEarly?: (bytes: Uint8Array) => boolean) {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) return { tooLarge: true as const, bytes: Buffer.concat(chunks) };
      chunks.push(next.value);
      if (stopEarly?.(Buffer.concat(chunks))) break;
    }
    return { tooLarge: false as const, bytes: Buffer.concat(chunks) };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Parses the advertised HEAD commit from a Git smart-HTTP upload-pack advertisement. */
function advertisedHead(bytes: Uint8Array): string | undefined | null {
  const text = Buffer.from(bytes).toString("latin1");
  let offset = 0;
  while (offset + 4 <= text.length) {
    const length = parseInt(text.slice(offset, offset + 4), 16);
    if (Number.isNaN(length)) return null;
    if (length === 0) { offset += 4; continue; }
    if (offset + length > text.length) return undefined;
    const line = text.slice(offset + 4, offset + length);
    offset += length;
    if (line.startsWith("# service=")) continue;
    const match = /^([0-9a-f]{40}) (\S+?)(?:\0|\n|$)/.exec(line);
    if (!match) return null;
    // An empty repository advertises only capabilities with a zero ID.
    return match[2] === "HEAD" && !/^0+$/.test(match[1]!) ? match[1] : null;
  }
  return undefined;
}

/**
 * Public, immutable GitHub reads only: resolves the default branch to a full
 * commit, then reads one repository-relative file at that commit. Never sends
 * credentials or follows redirects.
 */
export async function fetchPublicGithubSpec(url: string, path: string) {
  const repo = githubRepository(url);
  if (!repo) throw new ProjectSpecError(400, "Only public GitHub repositories can be loaded. Use an https://github.com/owner/repository URL.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { "User-Agent": "Dispatch-Spec" };
  try {
    const refs = await fetch(`https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repository)}.git/info/refs?service=git-upload-pack`,
      { redirect: "error", signal: controller.signal, headers });
    if (refs.status === 401 || refs.status === 403 || refs.status === 404) {
      await refs.body?.cancel();
      throw new ProjectSpecError(404, "Repository not found or not public. Only public GitHub repositories can be loaded.");
    }
    if (!refs.ok || !refs.body) { await refs.body?.cancel(); throw new ProjectSpecError(502, "GitHub is unavailable. Try again in a moment."); }
    const advertised = await readLimited(refs, REFS_MAX_BYTES, bytes => advertisedHead(bytes) !== undefined);
    const commit = advertisedHead(advertised.bytes);
    if (!commit) throw new ProjectSpecError(404, "This repository has no default-branch commit to load.");

    const file = path.split("/").map(encodeURIComponent).join("/");
    const raw = await fetch(`https://raw.githubusercontent.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repository)}/${commit}/${file}`,
      { redirect: "error", signal: controller.signal, headers: { ...headers, Accept: "text/plain" } });
    if (raw.status === 404) { await raw.body?.cancel(); throw new ProjectSpecError(404, "Spec file not found at this commit. Check the path in project settings."); }
    if (!raw.ok || !raw.body) { await raw.body?.cancel(); throw new ProjectSpecError(502, "GitHub is unavailable. Try again in a moment."); }
    const body = await readLimited(raw, SPEC_MAX_BYTES);
    if (body.tooLarge) throw new ProjectSpecError(413, "Spec file is larger than 512 KB and can't be opened here.");
    let content: string;
    // Preserve a leading BOM so displayed source matches the repository bytes.
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body.bytes); }
    catch { throw new ProjectSpecError(415, "Spec file isn't UTF-8 text and can't be opened here."); }
    return { commit, content };
  } catch (error) {
    if (error instanceof ProjectSpecError) throw error;
    throw new ProjectSpecError(502, "GitHub couldn't be reached or timed out. Try again.");
  } finally { clearTimeout(timeout); }
}
