import { createHash } from "node:crypto";
import { z } from "zod";
import { BUNDLE_MAX_BYTES, BundleError, bundleSchema, validateBundle } from "./bundles.js";

const segment = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/).max(100);
export const githubSourceSchema = z.object({
  owner: segment, repository: segment,
  commit: z.string().regex(/^[a-fA-F0-9]{40}$/).transform(value => value.toLowerCase()),
  path: z.string().max(240).refine(value => value === "" || safeRelativePath(value), "Use a relative package directory."),
}).strict();
export type GithubSourceInput = z.infer<typeof githubSourceSchema>;
function safeRelativePath(value: string) {
  return /^[A-Za-z0-9_./-]+$/.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** Public immutable GitHub data only. Never forwards user credentials or follows redirects. */
export async function fetchGithubBundle(input: GithubSourceInput) {
  const source = githubSourceSchema.parse(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let total = 0;
  async function read(path: string): Promise<string> {
    const relative = [source.path, path].filter(Boolean).join("/");
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/${source.commit}/${relative.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, { redirect: "error", signal: controller.signal, headers: { Accept: "text/plain", "User-Agent": "Dispatch-Bundles" } });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new BundleError("GitHub file unavailable. Check the public repository, commit and package path.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength; total += next.value.byteLength;
        if (size > 512 * 1024 || total > BUNDLE_MAX_BYTES) throw new BundleError("GitHub bundle exceeds size limits.");
        chunks.push(next.value);
      }
      try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { throw new BundleError("GitHub bundle files must be UTF-8."); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  try {
    const manifestText = await read("dispatch.json");
    let json: unknown;
    try { json = JSON.parse(manifestText); } catch { throw new BundleError("GitHub dispatch.json is invalid JSON."); }
    const manifest = bundleSchema.parse(json);
    const files = new Map<string, string>();
    for (const entry of [...manifest.agents, ...manifest.skills]) {
      const path = entry.instructions;
      if (path.length > 240 || !safeRelativePath(path) || !path.endsWith(".md")) throw new BundleError("Invalid GitHub instruction path.");
      if (!files.has(path)) files.set(path, await read(path));
      entry.instructions = files.get(path)!;
    }
    const bundle = validateBundle(manifest);
    const digest = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
    return { bundle, source, digest };
  } catch (error) {
    if (error instanceof BundleError || error instanceof z.ZodError) throw error;
    throw new BundleError("GitHub fetch failed or timed out. Retry the pinned commit.");
  } finally { clearTimeout(timeout); }
}
