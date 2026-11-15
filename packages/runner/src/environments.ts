import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import type { LoadedAgent } from "./definition.js";
import type { McpServers } from "./mcp.js";
import type { JsonValue } from "@earendil-works/chord/json";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { privateStateDirectory } from "./private-state.js";

/** Requirements live with the application; installed machines and sessions live in host state. */
export type AgentEnvironment = { recipe: string };
export type EnvironmentKind = "desktop" | "container" | "sandbox" | "vm";
type Manifest = {
  version: 1; name: string; kind: EnvironmentKind; driver: "docker";
  image: string; platform: string; port?: number; volumes: Record<string, string>;
  instructions?: string;
};
type Instance = {
  version: 1; recipe: string; space?: string; identity?: string;
  docker?: { name: string; context: string; manifest: Manifest };
};
const builder = "nixos/nix@sha256:7a007c766426c1877758ddc5cb87a965ac131fc78c582ce0083d922d51ae945c";
const nixDirectory = fileURLToPath(new URL("../nix/", import.meta.url));
const cuaTools = ["space_bash", "space_write", "list_tools", "call_tool", "upload", "download", "open_space_viewer"];

function command(executable: string, args: string[], options: { env?: NodeJS.ProcessEnv; stream?: boolean; signal?: AbortSignal; raw?: boolean } = {}): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { env: { ...process.env, ...options.env }, signal: options.signal,
      stdio: ["ignore", "pipe", options.stream ? "inherit" : "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; if (options.stream) process.stderr.write(chunk); });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.on("error", error => reject((error as NodeJS.ErrnoException).code === "ENOENT"
      ? new Error(`Install ${executable} and make it available on PATH before preparing this environment.`) : error));
    child.on("close", code => code === 0 ? accept(options.raw ? stdout : stdout.trim())
      : reject(new Error(`${executable} ${args[0]} failed (${code}). ${stderr.trim()}`)));
  });
}

async function softwareSource(root: string, destination: string) {
  const paths = (await command("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { raw: true })).split("\0").filter(Boolean);
  for (const path of new Set(paths)) {
    if (path.split("/").some(part => [".git", ".state", "node_modules"].includes(part))
      || /(^|\/)(host\.json|\.env(?:\..*)?|[^/]*\.local\.json)$/.test(path)) continue;
    const source = join(root, path);
    const resolved = await realpath(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined; // A tracked file may be deleted in the worktree.
      throw error;
    });
    if (!resolved) continue;
    const child = relative(root, resolved);
    if (child.startsWith("..") || isAbsolute(child)) throw new Error(`Build input ${path} points outside the application repository.`);
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { dereference: false, verbatimSymlinks: true });
  }
}

async function save(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

async function readInstance(directory: string): Promise<Instance | undefined> {
  const text = await readFile(join(directory, "instance.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!text) return undefined;
  const value: Instance = JSON.parse(text);
  if (value.version !== 1 || typeof value.recipe !== "string" || (!value.docker && !value.space)) throw new Error("Invalid environment instance record.");
  return value;
}

async function checkSpace(space: string) {
  const client = new McpClient({ name: "dispatch-environment-setup", version: "1" });
  try {
    await client.connect(new StdioTransport({ command: "cua", args: ["mcp", "--embedded"] }));
    const result = await client.callTool("space_bash", { space, command: "echo dispatch-environment-ready", timeout: 0 }, { timeoutMs: 0 });
    if (result.isError) throw new Error(`Cua cannot reach Space ${space}; check its existing owner's startup and connection settings.`);
  } finally { await client.close(); }
}

export function environmentDirectory(stateRoot: string, agent: LoadedAgent) {
  return join(stateRoot, "environments", agent.id);
}

async function recipePath(agent: LoadedAgent) {
  if (!agent.environment) throw new Error(`Agent ${agent.id} does not select an environment.`);
  const root = await realpath(agent.root);
  const path = await realpath(resolve(root, agent.environment.recipe));
  const child = relative(root, path);
  if (child.startsWith("..") || isAbsolute(child)) throw new Error("An environment recipe must be inside its application repository.");
  return { root, recipe: child };
}

/** Docker supplies the Linux builder on macOS too. No host Nix installation or remote builder is required. */
async function build(agent: LoadedAgent, directory: string) {
  const source = await recipePath(agent);
  const context = await command("docker", ["context", "show"]);
  const platform = await command("docker", ["info", "--format", "{{.Architecture}}"]);
  const system = platform === "aarch64" || platform === "arm64" ? "aarch64-linux"
    : platform === "x86_64" || platform === "amd64" ? "x86_64-linux" : undefined;
  if (!system) throw new Error(`The Docker engine architecture ${platform} is not supported by the Nix builder.`);
  const staging = join(directory, `build-${randomUUID()}`);
  const builderName = `dispatch-build-${randomUUID()}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  await mkdir(staging, { mode: 0o700 });
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const snapshot = join(staging, "source");
    await mkdir(snapshot);
    await softwareSource(source.root, snapshot);
    // Mount a software snapshot, not the live checkout with credentials and retained sessions.
    await command("docker", ["--context", context, "run", "--name", builderName, "--init",
      "--sysctl", "net.ipv4.ip_unprivileged_port_start=1024",
      "--mount", `type=volume,src=dispatch-nix-${system},dst=/nix`,
      "--mount", `type=bind,src=${snapshot},dst=/application,readonly`,
      "--mount", `type=bind,src=${nixDirectory},dst=/builder,readonly`,
      "--mount", `type=bind,src=${staging},dst=/result`,
      builder, "sh", "-ec",
      'out=$(nix-build /builder/environments/build.nix --argstr recipe "$1" --argstr system "$2" --no-out-link --option sandbox false --option filter-syscalls false); cp -L "$out/environment.json" /result/environment.json; cp -L "$out/image.tar.gz" /result/image.tar.gz; chmod 644 /result/environment.json /result/image.tar.gz',
      "dispatch-build", `/application/${source.recipe}`, system], { stream: true, signal: controller.signal });
    const manifest: Manifest = JSON.parse(await readFile(join(staging, "environment.json"), "utf8"));
    if (manifest.version !== 1 || manifest.driver !== "docker" || !manifest.image || !manifest.volumes
      || !["desktop", "container", "sandbox", "vm"].includes(manifest.kind)) throw new Error("Unsupported environment artifact manifest.");
    await command("docker", ["--context", context, "load", "--input", join(staging, "image.tar.gz")], { stream: true });
    return { context, manifest };
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    // A disconnected Docker client does not prove its build container stopped.
    try {
      const remaining = await command("docker", ["--context", context, "ps", "-aq", "--filter", `name=^/${builderName}$`]);
      if (remaining) await command("docker", ["--context", context, "rm", "--force", builderName]);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}

async function docker(instance: Instance, args: string[], stream = false) {
  if (!instance.docker) throw new Error("This is an attached Cua Space; its existing owner manages its lifecycle.");
  return command("docker", ["--context", instance.docker.context, ...args], { stream });
}

async function inspect(instance: Instance) {
  try { return JSON.parse(await docker(instance, ["inspect", instance.docker!.name]))[0]; }
  catch (error) {
    if (error instanceof Error && /No such (object|container)/i.test(error.message)) return undefined;
    throw error;
  }
}

async function createContainer(instance: Instance, directory: string) {
  const { name, manifest } = instance.docker!;
  const key = createHash("sha256").update(await realpath(directory)).digest("hex").slice(0, 16);
  await docker(instance, ["create", "--name", name, "--hostname", name, "--init", "--platform", manifest.platform,
    "--label", `ai.dispatch.environment=${key}`, "--shm-size", "1g",
    ...Object.entries(manifest.volumes).flatMap(([target, volume]) => ["--mount", `type=volume,src=${name}-${volume},dst=${target}`]),
    "--mount", `type=bind,src=${join(directory, "settings")},dst=/run/dispatch-settings,readonly`,
    ...(manifest.port ? ["--publish", `127.0.0.1::${manifest.port}`] : []), manifest.image]);
}

async function refresh(instance: Instance, directory: string) {
  if (!instance.docker) return instance;
  const { name, manifest } = instance.docker;
  let inspection = await inspect(instance);
  if (!inspection) { await createContainer(instance, directory); inspection = await inspect(instance); }
  if (!inspection.State.Running) await docker(instance, ["start", name]);
  if (!manifest.port) return instance;
  const started = JSON.parse(await docker(instance, ["inspect", name]))[0];
  const binding = started.NetworkSettings.Ports[`${manifest.port}/tcp`]?.[0];
  if (!binding || binding.HostIp !== "127.0.0.1") throw new Error("The managed desktop needs a loopback Cua port binding.");
  const endpoint = `http://127.0.0.1:${binding.HostPort}`;
  // The desktop's own health check owns readiness; avoid adding a competing startup deadline.
  while (true) {
    const state = JSON.parse(await docker(instance, ["inspect", name]))[0].State;
    if (!state.Running || state.Health?.Status === "unhealthy") throw new Error(`Environment ${name} failed to start. Inspect docker logs ${name}.`);
    if (!state.Health || state.Health.Status === "healthy") break;
    await new Promise(accept => setTimeout(accept, 500));
  }
  const token = (await docker(instance, ["exec", name, "cat", "/run/cua/env-token"])).trim();
  const added = JSON.parse(await command("cua", ["spaces", "add", endpoint, "--embedded", "--name", name, "--json"], { env: { CUA_ENV_TOKEN: token } }));
  if (typeof added.id !== "string") throw new Error("Cua did not return a registered Space identity.");
  const previous = instance.space;
  instance.space = added.id;
  await save(join(directory, "instance.json"), instance);
  if (previous && previous !== instance.space) await command("cua", ["spaces", "rm", previous, "--embedded"]);
  return instance;
}

export async function environmentOperation(agent: LoadedAgent, stateRoot: string, action: string,
  options: { space?: string; identity?: string; vaultServer?: string; rebuild?: boolean } = {}) {
  await recipePath(agent);
  const directory = environmentDirectory(stateRoot, agent);
  await privateStateDirectory(directory);
  const unlock = await lockfile.lock(directory, { realpath: false });
  try {
    let instance = await readInstance(directory);
    if (action === "describe" || action === "status") {
      const status = instance?.docker ? (await inspect(instance))?.State.Status ?? "missing container"
        : instance?.space ? "attached" : "not configured";
      return { agent: agent.id, recipe: agent.environment!.recipe, status, ...instance };
    }
    if (action === "build") return build(agent, directory);
    if (action === "stop") {
      if (!instance?.docker) throw new Error("Only a Dispatch-managed container can be stopped here. Use its existing owner for an attached Space.");
      await docker(instance, ["stop", instance.docker.name]);
      return { agent: agent.id, status: "stopped", retained: "home, browser sessions and control identity" };
    }
    if (action !== "setup" && action !== "start") throw new Error("Use environment describe, build, setup, status, start or stop.");
    if (instance && instance.recipe !== agent.environment!.recipe && !options.rebuild && !options.space)
      throw new Error("The selected recipe changed. Stop the environment and run setup --rebuild to apply it.");
    if (options.space) {
      if (instance?.docker) throw new Error("This agent already owns a desktop. Stop and preserve it before changing its binding; use a separate host state directory for another installation.");
      const spaces = JSON.parse(await command("cua", ["spaces", "ls", "--json"]));
      const records = Array.isArray(spaces) ? spaces : spaces.spaces;
      const matches = records.filter((value: { id: string; name: string }) => value.id === options.space || value.name === options.space);
      if (matches.length !== 1) throw new Error("Choose one registered Cua Space by its exact ID (cua spaces ls --json).");
      await checkSpace(matches[0].id);
      instance = { version: 1, recipe: agent.environment!.recipe, space: matches[0].id,
        ...(options.identity ? { identity: options.identity } : {}) };
      await save(join(directory, "instance.json"), instance);
      return { agent: agent.id, ...instance };
    }
    if (action === "start" && !instance) throw new Error("Run environment setup first.");
    if (instance && !instance.docker) {
      if (options.rebuild || options.vaultServer) throw new Error("An attached Space is updated by its existing owner.");
      if (options.identity) { instance.identity = options.identity; await save(join(directory, "instance.json"), instance); }
      return { agent: agent.id, ...instance };
    }
    if (instance?.docker && (options.rebuild || options.vaultServer)) {
      const running = (await inspect(instance))?.State.Running;
      if (running) throw new Error("Stop the environment before rebuilding or changing browser settings so its browser can save its profile.");
    }
    const settings = join(directory, "settings");
    await privateStateDirectory(settings);
    if (options.vaultServer) {
      const url = new URL(options.vaultServer);
      if (url.protocol !== "https:" || url.origin !== options.vaultServer || url.username || url.password) throw new Error("--vault-server must be an HTTPS origin reachable from the desktop.");
      await save(join(settings, "browser.json"), { vaultServer: options.vaultServer });
    }
    if (instance && options.identity) { instance.identity = options.identity; await save(join(directory, "instance.json"), instance); }
    if (instance && !options.rebuild) return { agent: agent.id, ...await refresh(instance, directory) };
    const artifact = await build(agent, directory);
    if (artifact.manifest.port) await command("cua", ["--version"]);
    const key = createHash("sha256").update(await realpath(directory)).digest("hex").slice(0, 16);
    const name = `dispatch-${agent.id}-${key}`;
    if (instance?.docker) {
      if (instance.docker.context !== artifact.context) throw new Error(`Select Docker context ${instance.docker.context} before rebuilding this instance.`);
      if (await inspect(instance)) await docker(instance, ["rm", name]);
    }
    instance = { version: 1, recipe: agent.environment!.recipe, docker: { ...artifact, name },
      ...(instance?.space ? { space: instance.space } : {}),
      ...(options.identity || instance?.identity ? { identity: options.identity ?? instance?.identity } : {}) };
    await save(join(directory, "instance.json"), instance);
    return { agent: agent.id, ...await refresh(instance, directory) };
  } finally { await unlock(); }
}

/** Reuse Pi MCP and Cua's public interface. The host binds the target, never the model. */
export async function environmentConnections(agents: LoadedAgent[], stateRoot: string) {
  const servers: McpServers = {};
  const argumentsByServer: Record<string, Record<string, Record<string, JsonValue>>> = {};
  const selected = new Map<string, { server?: string; instructions: string; identity: string }>();
  for (const agent of agents) {
    if (!agent.environment || selected.has(agent.id)) continue;
    const directory = environmentDirectory(stateRoot, agent);
    let instance = await readInstance(directory);
    if (!instance) {
      selected.set(agent.id, { identity: "unconfigured", instructions: `Your execution environment is not configured. The host owner can run npx dispatch environment setup --agent ${agent.id}.` });
      continue;
    }
    if (instance.recipe !== agent.environment.recipe) throw new Error(`Agent ${agent.id}'s environment recipe changed. Stop and rebuild its environment before starting the host.`);
    if (instance.docker) {
      const unlock = await lockfile.lock(directory, { realpath: false });
      try { instance = await refresh(instance, directory); } finally { await unlock(); }
    }
    const server = `environment_${agent.id.replaceAll("-", "_")}`;
    if (instance.space) {
      servers[server] = { command: "cua", args: ["mcp", "--embedded"], tools: cuaTools };
      argumentsByServer[server] = Object.fromEntries(cuaTools.map(tool => [tool,
        { space: instance!.space!, ...(tool === "space_bash" ? { timeout: 0 } : {}) }]));
    }
    selected.set(agent.id, { ...(instance.space ? { server } : {}), identity: JSON.stringify(instance),
      instructions: `Execution environment: ${instance.space ?? instance.docker!.name}. ${instance.docker?.manifest.instructions ?? ""}\n`
        + (instance.space ? "The environment MCP tools are bound to this computer. Use list_tools then call_tool for its installed GUI tools, and space_bash for its shell. "
          : `This container has no Cua service. Its Docker context is ${instance.docker!.context}; use Docker for container operations. `)
        + "Your stock coding tools still run on the host. "
        + (instance.identity ? `Verify the signed-in account is ${instance.identity} before using private services.` : "Verify the intended signed-in account before using private services.") });
  }
  return { servers, argumentsByServer, selected };
}
