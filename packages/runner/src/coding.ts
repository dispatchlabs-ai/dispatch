import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section, type EnvTarget } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { parse } from "yaml";

type Checkout = { path: string; repository: string; branch: string; gitDir: string; commonDir: string };
export function createCoding(namespace: string, workspacePrefix = "agent") {
  const Workspace = defineDoc<{ selected: string | null; checkouts: Record<string, Checkout> }>({
    kind: `${namespace}.workspace`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ selected: null, checkouts: {} }),
  });
  const execute = promisify(execFile);
  const within = (root: string, path: string) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith(`..`) && !isAbsolute(rel));
  };

  async function git(cwd: string, args: string[], context: Context) {
    const result = await execute("git", ["-C", cwd, ...args], {
      encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal: context.abortSignal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout.trim();
  }

  /** Native coding tools use this environment for every file or shell operation. */
  class CodingEnvironment extends NodeExecutionEnv {
    private checkout: Checkout;
    constructor(checkout: Checkout) { super({ cwd: checkout.path }); this.checkout = checkout; }
    private async writable(path: string) {
      const target = resolve(this.cwd, path);
      if (!within(this.cwd, target) || basename(target) === "USE_CASES.md") {
        throw new Error("Writes are limited to this conversation's checkout; USE_CASES.md is protected.");
      }
      let ancestor = target;
      while (true) {
        try {
          if (!within(this.cwd, await realpath(ancestor))) throw new Error("Write escapes the private checkout through a symlink.");
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          ancestor = dirname(ancestor);
        }
      }
    }
    override async writeFile(path: string, content: string | Uint8Array, context: Context) {
      await this.writable(path);
      return super.writeFile(path, content, context);
    }
    override async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
      await this.writable(path);
      return super.createDir(path, options, context);
    }
    override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
      if (process.platform !== "darwin") throw new Error("The local coding shell currently requires macOS sandbox-exec.");
      const { path, gitDir, commonDir, branch } = this.checkout;
      const scratch = join(gitDir, `${namespace}-tmp`);
      await mkdir(scratch, { recursive: true });
      const quote = (value: string) => JSON.stringify(value);
      const ref = join(commonDir, "refs", "heads", branch);
      const profile = [
        "(version 1)", "(allow default)", "(deny file-write*)",
        `(allow file-write* (subpath ${quote(path)}) (subpath ${quote(gitDir)})`,
        `(subpath ${quote(join(commonDir, "objects"))}) (literal ${quote(ref)}) (literal ${quote(`${ref}.lock`)})`,
        `(literal ${quote(join(commonDir, "logs", "refs", "heads", branch))}) (literal "/dev/null"))`,
        '(deny file-write* (regex #"/USE_CASES[.]md$"))',
      ].join("\n");
      const argv = typeof command === "string" ? ["/bin/bash", "--noprofile", "--norc", "-c", command] : [...command];
      return super.exec(["/usr/bin/sandbox-exec", "-p", profile, ...argv], {
        ...options, inheritEnv: false,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: homedir(), USER: process.env.USER ?? basename(homedir()),
          LANG: process.env.LANG ?? "en_US.UTF-8", TMPDIR: scratch,
          npm_config_cache: join(scratch, "npm-cache"), XDG_CACHE_HOME: join(scratch, "cache"),
        },
      }, context);
    }
  }

  async function codingExtension(root: string, stateDirectory: string) {
    const config = parse(await readFile(join(root, "factory.yaml"), "utf8")).coding ?? {};
    const repositories = resolve(root, config.repositoriesDirectory ?? "..");
    const worktrees = resolve(root, config.worktreesDirectory ?? "../../worktrees");
    const owner = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 12);
    const select = defineTool({
      name: "select_repository",
      description: `Choose a repository only when code access is needed. Pass a local directory/name under ${repositories}, or an HTTPS/SSH Git URL to clone. Creates a private worktree for this conversation and reuses it on later calls. You can select several repos and switch between them. Committed local HEAD is the starting point; existing uncommitted work is preserved.`,
      parameters: Type.Object({ repository: Type.String({ minLength: 1 }) }),
      replay: "safe", executionMode: "sequential",
      async execute({ repository }, api, context) {
        const key = createHash("sha256").update(repository).digest("hex").slice(0, 12);
        const saved = await api.snapshot(Workspace, api.conversationId, context);
        let checkout = saved?.checkouts[key];
        if (!checkout) {
          const remote = /^(https:\/\/|ssh:\/\/|git@)/.test(repository);
          if (repository.startsWith("https://") && new URL(repository).username) throw new Error("Use a credential-free Git URL.");
          const source = remote ? repository : await realpath(resolve(repositories, repository));
          if (!remote && !within(await realpath(repositories), source)) throw new Error("Select a repo inside the configured repositories directory.");
          if (!remote) {
            const ownGit = resolve(root, await git(root, ["rev-parse", "--git-common-dir"], context));
            const sourceGit = resolve(source, await git(source, ["rev-parse", "--git-common-dir"], context));
            if (await realpath(ownGit) === await realpath(sourceGit)) throw new Error("Agents cannot select their own definition repository.");
          }
          const name = basename(repository.replace(/\/$/, "")).replace(/\.git$/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
          const branch = `codex/${workspacePrefix}-${owner}-${api.conversationId}-${key}`;
          const path = join(worktrees, name, `${workspacePrefix}-${owner}-${api.conversationId}-${key}`);
          await mkdir(dirname(path), { recursive: true });
          const exists = await stat(join(path, ".git")).then(() => true, error => {
            if (error.code === "ENOENT") return false;
            throw error;
          });
          if (!exists) {
            if (remote) {
              await git(dirname(path), ["clone", "--", repository, path], context);
              await git(path, ["switch", "-c", branch], context);
            } else {
              if (await git(source, ["rev-parse", "--show-toplevel"], context) !== source) throw new Error("Select the repository root.");
              await git(source, ["worktree", "add", "-b", branch, path, "HEAD"], context);
            }
          }
          if (await git(path, ["branch", "--show-current"], context) !== branch) throw new Error("The reserved worktree belongs to another branch.");
          checkout = {
            path: await realpath(path), repository: source, branch,
            gitDir: resolve(path, await git(path, ["rev-parse", "--git-dir"], context)),
            commonDir: resolve(path, await git(path, ["rev-parse", "--git-common-dir"], context)),
          };
        }
        await api.commit(async tx => {
          const workspace = await tx.doc(Workspace, api.conversationId);
          workspace.checkouts[key] = checkout!;
          workspace.selected = key;
        }, context);
        return { output: [{ type: "text", text: JSON.stringify(checkout) }] };
      },
    });
    const extension = defineExtension({
      name: `${namespace}.coding-workspace`, tools: [select],
      sections: [section("workspace", input => {
        return input.env?.cwd ? `Private checkout: ${input.env.cwd}` :
          `No checkout selected. Choose a repository with select_repository if needed. Local repos: ${repositories}.`;
      })],
    });
    return { extensions: [CodingTools, extension] };
  }

  async function codingEnvironment(target: EnvTarget, context: Context): Promise<ExecutionEnv | undefined> {
    const state = await target.read.snapshot(Workspace, target.conversationId, context);
    return state?.selected ? new CodingEnvironment(state.checkouts[state.selected]) : undefined;
  }

  return { Workspace, codingExtension, codingEnvironment };
}
