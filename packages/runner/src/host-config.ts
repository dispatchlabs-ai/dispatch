import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ClientConnection } from "./client.js";
import type { ServiceConfig } from "./service.js";

function hostPaths(root: string, stateRoot = join(root, ".state")) {
  // Unix socket names are short even when the application lives in a deeply nested checkout.
  const key = createHash("sha256").update(stateRoot).digest("hex").slice(0, 24);
  const socket = join(tmpdir(), `dispatch-${process.getuid?.() ?? "local"}-${key}`, "host.sock");
  return { root, cwd: root, stateRoot, socket };
}

export async function localHostPaths(options: { root?: string; state?: string; socket?: string }) {
  const root = await realpath(resolve(options.root ?? "."));
  const paths = hostPaths(root, resolve(root, options.state ?? ".state"));
  if (options.socket) paths.socket = resolve(options.socket);
  return paths;
}

function settingPath(directory: string, value: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Configured paths must be nonempty strings.");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(directory, value);
}

type FileConfig = ServiceConfig & { url?: string; tokenFile?: string };

/** Resolve CLI file settings before changing directories or connecting a client. */
export async function readHostConfig(filename: string): Promise<FileConfig> {
  const input: Partial<FileConfig> = JSON.parse(await readFile(filename, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Host settings must be a JSON object.");
  const directory = await realpath(dirname(resolve(filename)));
  const root = input.root === undefined ? directory : settingPath(directory, input.root);
  const paths = hostPaths(root, input.stateRoot === undefined ? undefined : settingPath(directory, input.stateRoot));
  const config: FileConfig = { ...input, ...paths };
  if (input.cwd !== undefined) config.cwd = settingPath(directory, input.cwd);
  if (input.socket !== undefined) config.socket = settingPath(directory, input.socket);
  else if (input.http || input.url) delete config.socket;
  if (input.gateway) config.gateway = { ...input.gateway, credentialFile: settingPath(directory, input.gateway.credentialFile) };
  // Relative HTTP tokens keep the working directory of their original reader.
  if (input.http) config.http = { ...input.http, tokenFile: settingPath(config.cwd, input.http.tokenFile) };
  if (input.tokenFile !== undefined) config.tokenFile = settingPath(process.cwd(), input.tokenFile);
  return config;
}

/** Read the client endpoint from the same settings as the host. No model or tool connections are opened. */
export async function readClientConnection(filename?: string): Promise<ClientConnection> {
  if (filename === undefined) return { socket: (await localHostPaths({})).socket };
  const { socket, url, tokenFile, http } = await readHostConfig(filename);
  if (socket) return { socket };
  if (url) return tokenConnection(url, tokenFile);
  if (http) {
    const host = http.host ?? "127.0.0.1";
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      return tokenConnection(`http://${host === "::1" ? "[::1]" : host}:${http.port}`, http.tokenFile);
    }
  }
  throw new Error("Configure a service socket, a loopback HTTP listener, or a client URL for the running host.");
}

function tokenConnection(url: string, tokenFile?: string): ClientConnection {
  if (!tokenFile) return { url };
  return { url, headers: async () => ({ authorization: `Bearer ${(await readFile(tokenFile, "utf8")).trim()}` }) };
}
