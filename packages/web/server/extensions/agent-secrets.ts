import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ConversationId } from "@earendil-works/pi-durable";

export interface AgentSecretAccess {
  list(conversationId: ConversationId, signal?: AbortSignal): Promise<readonly { id: string; name: string }[]>;
  /** Resolve current authorization outside Pi state. Never return this value in a tool result. */
  resolve(conversationId: ConversationId, secretId: string, signal?: AbortSignal): Promise<string>;
}

const text = (message: string, isError = false) => ({ content: [{ type: "text" as const, text: message }], ...(isError ? { isError: true as const } : {}) });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
class InputError extends Error {}

/** Deliberately only GitHub HTTPS, without credentials, redirects, query strings or Git option syntax. */
function repositoryUrl(value: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) throw new InputError("Use a GitHub HTTPS repository URL without credentials, query parameters, or a trailing slash.");
  const repository = match[2].replace(/\.git$/, "");
  if (!repository || repository === "." || repository === "..") throw new InputError("Invalid repository name.");
  return `https://github.com/${match[1]}/${repository}.git`;
}

async function destinationPath(workspace: string, destination: string) {
  if (isAbsolute(destination) || destination.split(/[\\/]/).includes("..") || /[\x00-\x1f\x7f]/.test(destination))
    throw new InputError("Destination must be a new workspace-relative directory without '..'.");
  const root = await realpath(workspace);
  const destinationPath = resolve(root, destination);
  const parent = await realpath(dirname(destinationPath));
  if (parent !== root && !parent.startsWith(root + sep)) throw new InputError("Destination is outside the workspace.");
  if (destinationPath === root) throw new InputError("Destination must be a new directory.");
  try {
    await lstat(destinationPath);
    throw new InputError("Destination already exists; inspect it instead of cloning over it.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { absolute: join(parent, basename(destinationPath)), relative: relative(root, destinationPath) };
}

/** A per-operation socket: the token is held in memory, never in a helper file or environment. */
async function credentialServer(socketPath: string, repository: string, token: string) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(30000, () => socket.destroy());
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString();
      if (input.length > 8192) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      socket.removeAllListeners("data");
      try {
        const request = JSON.parse(input);
        if (request.protocol !== "https" || request.host !== "github.com" || request.path !== new URL(repository).pathname.slice(1)) {
          socket.end("null");
          return;
        }
        socket.end(JSON.stringify(token));
      } catch { socket.end("null"); }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.removeListener("error", reject); resolveListen(); });
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  };
}

export function createAgentSecrets(access: AgentSecretAccess) {
  const list = defineTool({
    name: "secrets_list",
    description: "List IDs and names of secrets currently granted to this agent. Values are never returned. Use a granted secret ID with git_clone.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      try {
        const secrets = await access.list(api.conversationId, context.abortSignal);
        // Explicit projection prevents an accidental credential field from entering Pi history.
        return text(JSON.stringify(secrets.map(({ id, name }) => ({ id, name }))));
      } catch { return text("Unable to list granted secrets.", true); }
    },
  });
  const clone = defineTool({
    name: "git_clone",
    description: "Clone a private GitHub HTTPS repository into a new workspace-relative directory using a granted secret ID (GitHub token). The token is consumed internally, never returned. Does not push, fetch submodules, overwrite destinations, or save credentials. Failed/interrupted clones may leave a partial directory; inspect it before retrying.",
    parameters: Type.Object({
      secretId: Type.String({ minLength: 1, maxLength: 200 }),
      repository: Type.String({ minLength: 1, maxLength: 2048 }),
      destination: Type.String({ minLength: 1, maxLength: 1024 }),
    }),
    // Clone changes disk. Recovery must report interruption rather than repeating external work.
    replay: "unsafe",
    execute: async (args, api, context) => {
      if (!api.env) return text("Git cloning requires a coding workspace.", true);
      let directory: string | undefined;
      let close: (() => Promise<void>) | undefined;
      try {
        const repository = repositoryUrl(args.repository);
        const destination = await destinationPath(api.env.cwd, args.destination);
        context.abortSignal?.throwIfAborted();
        const token = await access.resolve(api.conversationId, args.secretId, context.abortSignal);
        if (!/^[\x21-\x7e]{1,16384}$/.test(token)) return text("The granted secret is not a supported GitHub token.", true);
        context.abortSignal?.throwIfAborted();
        directory = await mkdtemp(join(tmpdir(), "dispatch-git-"));
        const socketPath = join(directory, "s");
        const template = join(directory, "empty-template");
        await mkdir(template);
        close = await credentialServer(socketPath, repository, token);
        const compiledHelper = fileURLToPath(new URL("./git-credential-helper.js", import.meta.url));
        const helper = existsSync(compiledHelper) ? compiledHelper : fileURLToPath(new URL("./git-credential-helper.ts", import.meta.url));
        const command = `!${quote(process.execPath)} ${quote(helper)} ${quote(socketPath)}`;
        const result = await api.env.exec([
          "git", "-c", "credential.helper=", "-c", `credential.helper=${command}`,
          "-c", "credential.useHttpPath=true", "-c", "http.followRedirects=false",
          "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
          "clone", "--quiet", `--template=${template}`, "--", repository, destination.absolute,
        ], {
          cwd: directory,
          // Ignore host Git config, credential helpers, proxy/trace injection and hooks.
          inheritEnv: false,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory, XDG_CONFIG_HOME: directory,
            GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
          timeout: 300,
          // Deliberately no output callback/spill: remote/helper errors may contain credentials.
        }, context);
        if (!result.ok || result.value.exitCode !== 0)
          return text("Git clone failed or was interrupted. Check the repository URL, token permissions, grant, and any partial destination before retrying. Raw Git output is suppressed to protect credentials.", true);
        return text(`Cloned ${repository} into ${destination.relative}. Credentials were not saved. The checkout is worker-local and may be lost on replacement.`);
      } catch (error) {
        return text(error instanceof InputError ? error.message : "Git clone could not complete. Check the current grant, workspace, Git installation, and repository access. Inspect any partial destination before retrying.", true);
      } finally {
        await close?.();
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });
  return defineExtension({
    name: "dispatch-agent-secrets",
    tools: [list, clone],
    sections: [section("agent-secrets", input => input.agent.tools.some(tool => tool.name === clone.name)
      ? "Use secrets_list to discover granted secret IDs/names and git_clone to clone a private GitHub repository. Never ask for a secret value or put one in chat, commands, URLs, or files. Grants are checked at use time. Clones are local, not durable backups; inspect partial directories after interruption instead of blindly retrying."
      : undefined)],
  });
}
