#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, posix } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { catalog, loadAgent } from "./definition.js";
import { createRunner } from "./index.js";
import { connectHostModels } from "./host-models.js";
import { serviceSettings } from "./settings.js";
import { connectInTerminal, type ServiceConfig } from "./service.js";
import { chatInTerminal } from "./terminal.js";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { WorkspaceClient, type WorkspaceRecord, type WorkspaceRelease } from "./workspace.js";
import { terminalError } from "./terminal-output.js";
import type { ArtifactSource } from "./artifacts.js";
import { sessionAgent } from "./session-agent.js";

const usage = `dispatch-agent --root DEFINITIONS catalog
dispatch-agent --root DEFINITIONS run --config HOST.json [--agent AGENT] [--session KEY] [--request-id ID] --prompt TEXT
dispatch-agent --root DEFINITIONS run --config HOST.json [--agent AGENT] --session KEY --history
dispatch-agent --root DEFINITIONS watch --config HOST.json [--session KEY] [--json]

With config.socket, run connects to the supervised service; disconnect leaves work running.
Without socket, legacy sessions own separate process state directories. No listener or schedules.
New sessions use factory.yaml defaultAgent unless --agent is supplied; retained selections stay fixed.
Use --update-definitions only for an explicit idle definition migration.
dispatch-agent --root DEFINITIONS workspace --config HOST.json --agent AGENT --session KEY --action ensure|status|checkpoint|suspend|finish
SIGINT/SIGTERM suspend native work; they do not undo external effects.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" }, config: { type: "string" }, agent: { type: "string" },
      "request-id": { type: "string" },
      session: { type: "string" }, prompt: { type: "string" }, history: { type: "boolean" },
      action: { type: "string" }, "release-manifest": { type: "string" },
      "update-definitions": { type: "boolean" }, help: { type: "boolean" }, json: { type: "boolean" },
    },
  });
  if (values.help) console.log(usage);
  else {
    if (!values.root || positionals.length !== 1) throw new Error(usage);
    let root = resolve(values.root);
    if (positionals[0] === "catalog") {
      const agents = await Promise.all((await catalog(root)).filter(agent => agent.runnable)
        .map(agent => loadAgent(root, agent.id)));
      console.log(JSON.stringify(agents.map(({ id, description, model, fingerprint }) =>
        ({ id, description, model, fingerprint })), null, 2));
    } else if (positionals[0] === "watch") {
      if (values.agent || values.prompt || values.history || values.action || values["update-definitions"]) throw new Error(usage);
      const { watchCommand } = await import("./watch.js");
      await watchCommand([
        ...(values.config ? ["--config", values.config] : []),
        ...(values.session ? ["--session", values.session] : []),
        ...(values.json ? ["--json"] : []),
      ]);
    } else {
      const workspaceAction = positionals[0] === "workspace";
      if ((!workspaceAction && positionals[0] !== "run") || !values.config
        || (workspaceAction ? !values.session || !values.action :
          values.history ? values.prompt !== undefined || !values.session : !values.prompt?.trim())) {
        throw new Error(usage);
      }
      const session = values.session ?? randomUUID();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(session)) throw new Error("Invalid session key.");
      const config: Pick<ServiceConfig, "socket" | "stateRoot" | "cwd" | "namespace" | "gateway" | "modelProviders" | "retry" | "compaction" | "afterFailedRun"> & {
        workspace?: { agents: string[]; command: string[] };
        artifacts?: { module: string; export: string; args?: unknown[] };
      } =
        JSON.parse(await readFile(values.config, "utf8"));
      if (config.socket && !workspaceAction) {
        if (values["update-definitions"]) throw new Error("Migrate idle definitions at service deployment, not from a client.");
        if (!isAbsolute(config.socket)) throw new Error("socket must be an absolute path.");
        await connectInTerminal({ socket: config.socket, agent: values.agent,
          session, prompt: values.prompt, history: values.history, requestId: values["request-id"] });
      } else {
        const settings = serviceSettings(config);
        for (const field of ["stateRoot", "cwd"] as const) {
          if (typeof config[field] !== "string" || !isAbsolute(config[field])) throw new Error(`${field} must be an absolute path.`);
        }
        if (!config.gateway?.origin || !isAbsolute(config.gateway.credentialFile)) throw new Error("Supply gateway.origin and an absolute gateway.credentialFile.");
        const agentId = await sessionAgent(root, join(config.stateRoot, session), values.agent);
        const workspace = config.workspace?.agents.includes(agentId) ? new WorkspaceClient(config.workspace.command, session) : undefined;
        let artifactSource: ArtifactSource | undefined;
        if (config.artifacts) {
          if (workspace) throw new Error("Choose a workspace or an artifact source module, not both.");
          const { module, export: name, args = [] } = config.artifacts;
          if (typeof module !== "string" || !isAbsolute(module) || typeof name !== "string" || !name || !Array.isArray(args)) {
            throw new Error("Supply an absolute artifacts.module, its factory export, and optional args array.");
          }
          const factory = (await import(pathToFileURL(module).href))[name];
          if (typeof factory !== "function") throw new Error("The configured artifact source factory is unavailable.");
          artifactSource = await factory(...args);
          if (typeof artifactSource !== "function") throw new Error("The artifact source factory must return an ArtifactSource function.");
        }
        if (workspaceAction && !workspace) throw new Error("This agent has no configured disposable workspace.");
        if (workspace) {
          let record = await workspace.request<WorkspaceRecord | null>({ op: "status" });
          if (!record) {
            if (!values["release-manifest"]) throw new Error("Workspace runs require an immutable application release manifest.");
            const manifest = JSON.parse(await readFile(values["release-manifest"], "utf8"));
            const release: WorkspaceRelease = { definitionsRoot: manifest.definitionsRoot,
              runtimeRevision: manifest.dispatch.revision, runtimeEntryPoint: manifest.runtimeEntryPoint, workspace: manifest.workspace };
            record = await workspace.request<WorkspaceRecord>({ op: "bind", release });
          }
          root = record.release.definitionsRoot;
          const entry = record.release.runtimeEntryPoint;
          if (await realpath(process.execPath) !== entry.node || await realpath(process.argv[1]) !== entry.module) {
            const args = process.argv.slice(2);
            const at = args.indexOf("--root");
            if (at >= 0) args.splice(at, 2);
            if (!values.agent) args.push("--agent", agentId);
            if (!process.execve) throw new Error("Pinned workspace recovery requires Node on a supported POSIX host.");
            process.execve(entry.node, [entry.node, entry.module, "--root", root, ...args],
              Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
            throw new Error("Could not resume the pinned runtime.");
          }
          if (workspaceAction) {
            if (!["ensure", "status", "checkpoint", "suspend", "finish"].includes(values.action!)) throw new Error("Unknown workspace action.");
            console.log(JSON.stringify(await workspace.request({ op: values.action }), null, 2));
            process.exit(0);
          }
          if (!values.history) await workspace.request({ op: "ensure" });
        }
        // Host-side children such as model provider CLIs inherit this process's
        // directory. Leave the caller's directory, which may be a disposable task
        // worktree, for the configured host directory (or this session's state
        // for container workspaces, whose host cwd need not exist).
        process.chdir(workspace ? join(config.stateRoot, session) : config.cwd);
        const names = new Set<string>();
        // A trusted per-process binding for definition-owned inspection tools.
        process.env.DISPATCH_SESSION_STATE_ROOT = join(config.stateRoot, session);
        const include = async (id: string) => {
          if (names.has(id)) return;
          names.add(id);
          for (const recipient of (await loadAgent(root, id)).messages ?? []) await include(recipient);
        };
        await include(agentId);
        const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
        const modelConnection = await connectHostModels(config, models);
        try { await chatInTerminal({
          root, stateRoot: join(config.stateRoot, session), cwd: workspace ? "/workspace" : config.cwd,
          env: workspace ? target => workspace.environment(target.cwd ?? "/workspace") : undefined,
          definitionResources: true,
          artifacts: workspace ? { source: async (path, _api, context) => {
            const env = workspace.environment();
            const canonical = getOrThrow(await env.canonicalPath(path, context));
            if (!canonical.startsWith("/workspace/")) throw new Error("Publish a file inside /workspace.");
            const reader = getOrThrow(await env.openBinaryReader(canonical, { noFollow: true }, context));
            const info = getOrThrow(await reader.info(context));
            return { name: posix.basename(canonical), size: info.size, chunks: (async function* () {
              try {
                for (let offset = 0; offset < info.size;) {
                  const chunk = getOrThrow(await reader.read(offset, 1024 * 1024, context));
                  if (!chunk.length) throw new Error("Workspace artifact ended unexpectedly.");
                  offset += chunk.length; yield chunk;
                }
              } finally { await reader.close(context); }
            })() };
          } } : artifactSource ? { source: artifactSource } : undefined,
          runner: createRunner({ namespace: config.namespace }), models, names: [...names],
          agent: agentId, session, drain: !!workspace || names.size > 1, prompt: values.prompt, history: values.history,
          updateDefinitions: values["update-definitions"], settings,
        }); } finally { await modelConnection.close(); }
      }
    }
  }
} catch (error) {
  console.error(terminalError(error).message);
  process.exitCode = 1;
}
