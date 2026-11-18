import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SourceEdit = { path: string; before: string; after: string };
export type Proposal = { title: string; reason: string; edits: SourceEdit[] };
export type SourceView = { base: string; files: string[]; read(path: string): Promise<string> };

export function repositoryName(value: string) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(value) || /\/\.{1,2}$/.test(value))
    throw new Error("Configure a GitHub repository as owner/name.");
  return value.toLowerCase();
}

function git(directory: string, args: string[], signal?: AbortSignal, input?: string): Promise<string> {
  // No ambient credential helper, repository hooks, SSH agent or user URL rewrites.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    HOME: process.env.HOME, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR, GH_TOKEN: process.env.GH_TOKEN, GH_PROMPT_DISABLED: "1" };
  return new Promise((accept, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "http.followRedirects=false", ...args],
      { cwd: directory, env, signal, stdio: "pipe" });
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.once("error", reject);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.once("close", code => code === 0 ? accept(Buffer.concat(output).toString("utf8"))
      : reject(new Error(Buffer.concat(errors).toString("utf8").trim() || "Git " + args[0] + " failed.")));
  });
}

export async function localReviewBase(root: string, repository: string) {
  const origin = (await git(root, ["remote", "get-url", "origin"])).trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/i.exec(origin);
  if (!match || repositoryName(match[1]) !== repository) throw new Error("The checkout origin must match the configured proposal repository.");
  return (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
}

export async function reviewSource(origin: string, base: string, paths: string[], signal?: AbortSignal) {
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error("Invalid source commit.");
  if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== "string" || !p || p.startsWith("/") || p.split("/").includes("..")))
    throw new Error("openDraftPR.paths must select committed application files or directories.");
  const directory = await mkdtemp(join(tmpdir(), "dispatch-review-source-"));
  const run = (args: string[], input?: string) => git(directory, args, signal, input);
  const close = () => rm(directory, { recursive: true, force: true });
  try {
    await run(["init", "--bare", "--quiet"]);
    const transport = origin.startsWith("https://github.com/") ? ["-c", "credential.helper=!gh auth git-credential"] : [];
    await git(directory, [...transport, "fetch", "--quiet", "--no-tags", origin, base], signal);
    await run(["read-tree", base]);
    const all = (await run(["ls-tree", "-r", "-z", base])).split("\0");
    const entries = new Map<string, { mode: string; sha: string }>();
    for (const line of all) {
      const m = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(line);
      if (m && !m[3].startsWith(".github/workflows/") && paths.some(p => p === "." || m[3] === p || m[3].startsWith(p.replace(/\/$/, "") + "/")))
        entries.set(m[3], { mode: m[1], sha: m[2] });
    }
    const read = async (path: string) => {
      const entry = entries.get(path);
      if (!entry) throw new Error("The requested path is outside the configured source files.");
      const value = await run(["cat-file", "blob", entry.sha]);
      if (value.includes("\0") || value.includes("\uFFFD")) throw new Error("A proposal requires a text source file.");
      return value;
    };
    return { base, files: [...entries.keys()], read, close,
      async stage(proposal: Proposal) {
        const changes = new Map<string, string>();
        for (const { path, before, after } of proposal.edits) {
          const current = changes.get(path) ?? await read(path);
          const index = current.indexOf(before);
          if (!before || before === after || index < 0 || current.indexOf(before, index + 1) !== -1)
            throw new Error("The edit must match one exact passage in " + path);
          changes.set(path, current.slice(0, index) + after + current.slice(index + before.length));
        }
        for (const [path, content] of changes) {
          const blob = (await run(["hash-object", "-w", "--stdin"], content)).trim();
          await run(["update-index", "--add", "--cacheinfo", entries.get(path)!.mode, blob, path]);
        }
        await run(["diff", "--cached", "--check", base]);
        const patch = await run(["diff", "--cached", "--no-ext-diff", "--no-textconv", base]);
        if (!patch || !changes.size) throw new Error("The proposal produced an empty change.");
        const files = [...changes].map(([path, content]) => ({ path, mode: entries.get(path)!.mode, content }));
        return { patch, files };
      },
    };
  } catch (error) { await close(); throw error; }
}
