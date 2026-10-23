import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section, type ConversationId } from "@earendil-works/pi-durable";
import type { GitHubCredential, GitHubGrantedRepository, GitHubOperation } from "../../src/shared/github-access.js";
import { credentialServer, destinationPath, quote, repositoryUrl } from "./agent-secrets.js";

export interface AgentGitHubAccess {
  resolve(conversationId: ConversationId, bindingId?: string, operation?: GitHubOperation, signal?: AbortSignal): Promise<{ repositories: GitHubGrantedRepository[] } | GitHubCredential>;
}
type PushReceipt = { id: string; bindingId: string; ref: string; oid: string; createdAt: number; status: "uncertain" | "succeeded" };
const PushReceipts = defineDoc<{ receipts: PushReceipt[] }>({
  checkpointWhen: () => false,
  kind: "dispatch.github-push-receipts", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ receipts: [] }),
});
const text = (message: string, isError = false) => ({ content: [{ type: "text" as const, text: message }], ...(isError ? { isError: true as const } : {}) });
class GitInputError extends Error {}
const oidPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function gitRef(value: string) {
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9_./-]{1,220}$/.test(value) || value.includes("..") || value.includes("//")
    || value.split("/").some(part => part.startsWith(".") || part.endsWith(".lock") || part.endsWith(".")) || value.endsWith("/"))
    throw new GitInputError("Use one full branch or tag ref, such as refs/heads/my-branch. Wildcards, deletion and force pushes are unsupported.");
  return value;
}

async function localRepository(workspace: string, path: string) {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || /[\x00-\x1f\x7f]/.test(path)) throw new GitInputError("Use a workspace-relative repository directory.");
  const root = await realpath(workspace);
  const within = async (value: string) => {
    const actual = await realpath(value);
    if (actual !== root && !actual.startsWith(root + sep)) throw new GitInputError("Repository data is outside the workspace.");
    return actual;
  };
  const directory = await within(resolve(root, path));
  let gitDir = join(directory, ".git");
  if ((await lstat(gitDir)).isFile()) {
    const pointer = /^gitdir: ([^\r\n]+)\s*$/.exec(await readFile(gitDir, "utf8"));
    if (!pointer) throw new GitInputError("Invalid Git worktree directory.");
    gitDir = resolve(directory, pointer[1]);
  }
  gitDir = await within(gitDir);
  let commonDir = gitDir;
  try { commonDir = await within(resolve(gitDir, (await readFile(join(gitDir, "commondir"), "utf8")).trim())); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { directory, gitDir, objects: await within(join(commonDir, "objects")) };
}

export function createAgentGitHub(access: AgentGitHubAccess) {
  const list = defineTool({
    name: "github_repositories", description: "List project repositories explicitly granted to this agent, GitHub bot identity, and recent push receipts. Repository URLs in project metadata alone do not grant access.",
    parameters: Type.Object({}), replay: "safe",
    execute: async (_args, api, context) => {
      try {
        const result = await access.resolve(api.conversationId, undefined, undefined, context.abortSignal);
        if (!("repositories" in result)) throw new Error();
        const receipts = await api.snapshot(PushReceipts, api.conversationId, context);
        return text(JSON.stringify({ repositories: result.repositories,
          pushes: (receipts?.receipts ?? []).filter(receipt => result.repositories.some(repository => repository.bindingId === receipt.bindingId)) }));
      } catch { return text("GitHub access is unavailable. A project manager must connect a repository and grant this agent access.", true); }
    },
  });
  const execute = defineTool({
    name: "github_git",
    description: "Perform an authenticated GitHub clone, fetch, push, or remote-ref inspection using a saved repository binding. Credentials are resolved internally at execution time. Local commits and merges use bash. Fetch updates refs/remotes/dispatch/<bindingId>/<branch>; merge that ref locally. Push sends one exact commit to one full ref; it never forces or deletes. Inspect a push receipt after interruption before deciding how to proceed.",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("clone"), Type.Literal("fetch"), Type.Literal("push"), Type.Literal("inspect")]),
      bindingId: Type.String({ minLength: 1, maxLength: 200 }),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, description: "New destination for clone; existing checkout for fetch/push." })),
      ref: Type.Optional(Type.String({ maxLength: 240, description: "Full remote ref, e.g. refs/heads/main. Required for fetch/push/inspect." })),
      source: Type.Optional(Type.String({ maxLength: 240, description: "Local commit OID or ref to push, default HEAD." })),
      pushReceiptId: Type.Optional(Type.String({ maxLength: 200, description: "For inspect: compare the remote ref to this durable push intent." })),
    }),
    replay: "unsafe",
    execute: async (args, api, context) => {
      if (!api.env) return text("GitHub Git operations require a coding workspace.", true);
      let temporary: string | undefined;
      let close: (() => Promise<void>) | undefined;
      let pushReceipt: PushReceipt | undefined;
      try {
        context.abortSignal?.throwIfAborted();
        const ref = args.operation === "clone" ? undefined : gitRef(args.ref ?? "");
        const destination = args.operation === "clone" ? await destinationPath(api.env.cwd, args.path ?? "") : undefined;
        const checkout = args.operation === "fetch" || args.operation === "push" ? await localRepository(api.env.cwd, args.path ?? "") : undefined;
        temporary = await mkdtemp(join(tmpdir(), "dispatch-github-"));
        const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: temporary, XDG_CONFIG_HOME: temporary,
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
        const run = async (command: string[], extra: Record<string, string> = {}) => {
          let stdout = "";
          const result = await api.env!.exec(command, {
            cwd: temporary!, inheritEnv: false, env: { ...environment, ...extra }, timeout: 300,
            // Retain only a bounded in-memory result. Never spill credentialed
            // Git output or send it to activity/history/logging callbacks.
            onOutput: (chunk, _context, info) => { if (info.stream === "stdout") stdout = (stdout + chunk).slice(0, 4096); },
          }, context);
          return result.ok ? { ...result, value: { ...result.value, stdout } } : result;
        };
        const bare = join(temporary, "remote.git");
        const template = join(temporary, "template");
        await mkdir(template);
        if (checkout) {
          const initialized = await run(["git", "init", "--bare", "--quiet", `--template=${template}`, bare]);
          if (!initialized.ok || initialized.value.exitCode !== 0) throw new Error();
        }
        let oid: string | undefined;
        if (args.operation === "push") {
          const source = args.source ?? "HEAD";
          if (!/^[A-Za-z0-9_./-]{1,240}$/.test(source) || source.startsWith("-") || source.includes("..")) throw new GitInputError("Use HEAD, a local ref or a full commit OID as the push source.");
          const resolved = await run(["git", `--git-dir=${checkout!.gitDir}`, "rev-parse", "--verify", `${source}^{commit}`]);
          oid = resolved.ok && resolved.value.exitCode === 0 ? resolved.value.stdout.trim() : "";
          if (!oidPattern.test(oid)) throw new GitInputError("The push source does not resolve to a local commit.");
          const validated = await run(["git", `--git-dir=${bare}`, "cat-file", "-t", oid], { GIT_OBJECT_DIRECTORY: checkout!.objects });
          if (!validated.ok || validated.value.exitCode !== 0 || validated.value.stdout.trim() !== "commit") throw new GitInputError("The source commit is not available in this checkout's object store.");
          pushReceipt = { id: `${api.taskId}:${api.callId}`, bindingId: args.bindingId, ref: ref!, oid, createdAt: Date.now(), status: "uncertain" };
          await api.commit(async tx => {
            const state = await tx.doc(PushReceipts, api.conversationId);
            if (state.receipts.some(receipt => receipt.id === pushReceipt!.id)) throw new GitInputError("This push already has a durable intent. Inspect its remote ref before taking further action.");
            state.receipts.push(pushReceipt!);
          }, context);
        }
        const credential = await access.resolve(api.conversationId, args.bindingId, args.operation, context.abortSignal);
        if (!("token" in credential) || !/^[\x21-\x7e]{1,16384}$/.test(credential.token)) throw new Error();
        const repository = repositoryUrl(credential.url);
        const socket = join(temporary, "credential");
        close = await credentialServer(socket, repository, credential.token);
        const compiled = fileURLToPath(new URL("./git-credential-helper.js", import.meta.url));
        const helper = existsSync(compiled) ? compiled : fileURLToPath(new URL("./git-credential-helper.ts", import.meta.url));
        const git = ["git", "-c", "credential.helper=", "-c", `credential.helper=!${quote(process.execPath)} ${quote(helper)} ${quote(socket)}`,
          "-c", "credential.useHttpPath=true", "-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always"];
        let result;
        if (args.operation === "clone") result = await run([...git, "clone", "--quiet", `--template=${template}`, "--", repository, destination!.absolute]);
        else if (args.operation === "inspect") result = await run([...git, "ls-remote", "--refs", "--", repository, ref!]);
        else if (args.operation === "fetch") result = await run([...git, `--git-dir=${bare}`, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", repository, `${ref}:refs/heads/fetched`], { GIT_OBJECT_DIRECTORY: checkout!.objects });
        else result = await run([...git, `--git-dir=${bare}`, "push", "--porcelain", "--", repository, `${oid}:${ref}`], { GIT_OBJECT_DIRECTORY: checkout!.objects });
        // No checkout configuration or hook is consulted while credentials exist.
        await close(); close = undefined;
        if (!result.ok || result.value.exitCode !== 0) return text(args.operation === "push"
          ? `Push outcome is uncertain or rejected. Receipt ${pushReceipt!.id} records the exact intent. Inspect the remote ref; do not force or blindly retry. Raw Git output is suppressed.`
          : "Git operation failed or was interrupted. Check current access and any partial checkout. Raw Git output is suppressed to protect credentials.", true);
        if (args.operation === "push") {
          await api.commit(async tx => {
            const receipt = (await tx.doc(PushReceipts, api.conversationId)).receipts.find(receipt => receipt.id === pushReceipt!.id)!;
            receipt.status = "succeeded";
          }, context);
          return text(`Pushed ${oid} to ${credential.name} ${ref}. Receipt ${pushReceipt!.id}.`);
        }
        if (args.operation === "inspect") {
          const line = result.value.stdout.split("\n").find(line => line.split("\t")[1] === ref);
          const current = line?.split("\t")[0];
          if (current && !oidPattern.test(current)) throw new Error();
          const receipt = args.pushReceiptId ? (await api.snapshot(PushReceipts, api.conversationId, context))?.receipts.find(item => item.id === args.pushReceiptId && item.bindingId === args.bindingId && item.ref === ref) : undefined;
          if (args.pushReceiptId && !receipt) throw new GitInputError("No matching push receipt exists for this agent, repository and ref.");
          return text(JSON.stringify({ repository: credential.name, ref, currentOid: current ?? null, ...(receipt ? { intent: receipt,
            matchesIntent: current === receipt.oid, interpretation: current === receipt.oid ? "The ref currently matches the intended commit." : "The current ref differs. This does not prove the earlier push never succeeded and does not authorize a force push." } : {}) }));
        }
        if (args.operation === "fetch") {
          const fetched = await run(["git", `--git-dir=${bare}`, "rev-parse", "--verify", "refs/heads/fetched"]);
          const fetchedOid = fetched.ok && fetched.value.exitCode === 0 ? fetched.value.stdout.trim() : "";
          if (!oidPattern.test(fetchedOid)) throw new Error();
          const localRef = `refs/remotes/dispatch/${args.bindingId}/${ref!.slice("refs/".length)}`;
          const updated = await run(["git", `--git-dir=${checkout!.gitDir}`, "update-ref", localRef, fetchedOid]);
          if (!updated.ok || updated.value.exitCode !== 0) throw new Error();
          return text(`Fetched ${credential.name} ${ref} at ${fetchedOid}. Local ref: ${localRef}. Merge or rebase locally as appropriate.`);
        }
        for (const [key, value] of [["user.name", credential.bot.login], ["user.email", credential.bot.email]]) {
          const configured = await run(["git", "-C", destination!.absolute, "config", "--local", key, value]);
          if (!configured.ok || configured.value.exitCode !== 0) throw new Error();
        }
        return text(`Cloned ${credential.name} into ${destination!.relative}. Commit identity: ${credential.bot.login} <${credential.bot.email}>. Include Dispatch-Agent-Instance: ${api.conversationId} in commit trailers. Files are worker-local; commit and push work that must survive replacement.`);
      } catch (error) {
        return text(error instanceof GitInputError ? error.message : `GitHub operation could not complete. Check current repository access and workspace state.${pushReceipt ? ` Push receipt ${pushReceipt.id} records an uncertain intent; inspect the remote ref before retrying.` : ""}`, true);
      } finally {
        await close?.();
        if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });
  return defineExtension({ name: "dispatch-github", tools: [list, execute], sections: [section("github-access", input => input.agent.tools.some(tool => tool.name === execute.name)
    ? "Use github_repositories and github_git for authenticated remote Git. Ordinary bash git commands do not receive GitHub credentials. Local status, diff, branch, commit, merge and rebase remain shell operations. Use the returned bot identity and Dispatch-Agent-Instance trailer when committing. Never request or print credentials. Grant checks apply at each operation. Inspect durable push receipts after interruption; never force or blindly retry an uncertain push. Pushes changing GitHub workflow files are unsupported by this connection. Worker-local unpushed files may be lost on replacement."
    : undefined)] });
}
