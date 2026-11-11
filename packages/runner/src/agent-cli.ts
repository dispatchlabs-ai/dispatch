#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, posix } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { catalog, loadAgent } from "./definition.js";
import { createRunner } from "./index.js";
import { connectHostModels } from "./host-models.js";
import { serviceSettings } from "./settings.js";
import { connectInTerminal, serveService, type ServiceConfig } from "./service.js";
import { run, type RunOptions } from "./run.js";
import { ensureSessionService, retireSessionService, sessionServiceIdentity, sessionServiceSocket, publishSessionService } from "./session-service.js";
import { piDurableVersion, selectRuntime, takeInterruptedSessions } from "./runtime-version.js";
import { deferredDefinitionUpdates } from "./runtime.js";
import { spawn } from "node:child_process";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { WorkspaceClient, type WorkspaceRecord, type WorkspaceRelease } from "./workspace.js";
import { terminalError } from "./terminal-output.js";
import type { ArtifactSource } from "./artifacts.js";
import { sessionAgent } from "./session-agent.js";

const usage = `dispatch-agent --root DEFINITIONS catalog
dispatch-agent --root DEFINITIONS run --config HOST.json [--agent AGENT] [--session KEY] [--request-id ID] --prompt TEXT
dispatch-agent --root DEFINITIONS run --config HOST.json [--agent AGENT] --session KEY --history
dispatch-agent --root DEFINITIONS run --config HOST.json --agent AGENT --session KEY --resume-only
dispatch-agent --root DEFINITIONS watch --config HOST.json [--session KEY] [--json]

With config.socket, run connects to the supervised service; disconnect leaves work running.
Without socket, run starts or joins a detached owner in the exact ordinary session directory. No factory schedules.
New sessions use factory.yaml defaultAgent unless --agent is supplied; retained selections stay fixed.
One state root runs one Pi Durable: an older launcher refuses to start, and a newer one closes owners
on any other version and resumes their unfinished work itself. A session follows the selected release;
changed definitions apply once its saved work is idle. --update-definitions and --replace-owner are
accepted and no longer needed. An owner exits after config.ownerIdleMinutes (default 60; 0 keeps it).
dispatch-agent --root DEFINITIONS workspace --config HOST.json --agent AGENT --session KEY --action ensure|status|checkpoint|suspend|finish
Client SIGINT/SIGTERM disconnect only. Owner SIGINT/SIGTERM suspend native work, not external effects.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" }, config: { type: "string" }, agent: { type: "string" },
      "session-owner": { type: "boolean" }, "owner-identity": { type: "string" }, "owner-host": { type: "string" }, "resume-only": { type: "boolean" }, "replace-owner": { type: "boolean" },
      "request-id": { type: "string" },
      session: { type: "string" }, prompt: { type: "string" }, history: { type: "boolean" },
      action: { type: "string" }, "release-manifest": { type: "string" },
      "update-definitions": { type: "boolean" }, help: { type: "boolean" }, json: { type: "boolean" },
    },
  });
  if (values["session-owner"] && !process.connected) throw new Error("--session-owner is internal; use ordinary run or --resume-only.");
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
          values["resume-only"] ? !values.session || values.prompt !== undefined || values.history :
          values.history ? values.prompt !== undefined || !values.session : !values["session-owner"] && values.prompt !== undefined && !values.prompt.trim())) {
        throw new Error(usage);
      }
      const session = values.session ?? randomUUID();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(session)) throw new Error("Invalid session key.");
      const config: Pick<ServiceConfig, "socket" | "stateRoot" | "cwd" | "namespace" | "gateway" | "modelProviders" | "retry" | "compaction" | "afterFailedRun"> & {
        ownerIdleMinutes?: number;
        workspace?: { agents: string[]; command: string[] };
        artifacts?: { module: string; export: string; args?: unknown[] };
      } =
        JSON.parse(await readFile(values.config, "utf8"));
      if (config.socket && !workspaceAction) {
        if (values["resume-only"]) throw new Error("--resume-only requires an ordinary native session, not config.socket.");
        if (values["update-definitions"]) throw new Error("Migrate idle definitions at service deployment, not from a client.");
        if (!isAbsolute(config.socket)) throw new Error("socket must be an absolute path.");
        await connectInTerminal({ socket: config.socket, agent: values.agent,
          session, prompt: values.prompt, history: values.history, requestId: values["request-id"] });
      } else {
        const settings = serviceSettings(config);
        for (const field of ["stateRoot", "cwd"] as const) {
          if (typeof config[field] !== "string" || !isAbsolute(config[field])) throw new Error(`${field} must be an absolute path.`);
        }

        const stateRoot = join(config.stateRoot, session);
        // Before anything is created or opened under an installation another Pi Durable owns.
        if (!values.history) await selectRuntime(config.stateRoot);
        // History never opens/resumes an owner merely to observe saved work.
        if (values.history) {
          const { discoverWatchRuns, readWatchChatProjection, readWatchChat } = await import("./watch-reader.js");
          const { terminalText } = await import("./terminal-output.js");
          const found = await discoverWatchRuns({ stateRoot: config.stateRoot, session, saved: true });
          const candidates = found.runs.flatMap(run => run.stores.filter(store => !values.agent || store.agent === values.agent).map(store => ({run, store})));
          const selected = values.agent ?? JSON.parse(await readFile(join(stateRoot, "conversation-agent.json"), "utf8")).agent;
          const item = candidates.find(item => item.store.agent === selected);
          if (!item) throw new Error("Saved session is unavailable; history did not create or resume native work.");
          const chat = await readWatchChat(item.run, selected, `terminal:${session}`);
          if (!chat) throw new Error("No retained conversation matches this session. History never creates one.");
          for (const message of (await readWatchChatProjection(item.run, chat.id)).messages) {
            console.log(terminalText(`${message.role}: ${message.text}${message.error ? `\nError: ${message.error}` : ""}`));
            for (const file of message.artifacts ?? []) console.log(terminalText(`Attachment: ${file.name} (${file.size} bytes)\n${join(stateRoot, selected, "artifacts", String(chat.conversationId), "files", file.id)}`));
          }
          process.exit(0);
        }
        if (values["resume-only"]) {
          if (!values.agent || !/^[a-z][a-z0-9-]*$/.test(values.agent)) throw new Error("--resume-only requires the original --agent.");
          await stat(join(stateRoot, values.agent, "session.sqlite"));
        }
        const agentId = await sessionAgent(root, stateRoot, values.agent);
        const workspace = config.workspace?.agents.includes(agentId) ? new WorkspaceClient(config.workspace.command, session) : undefined;
        if (config.artifacts && workspace) throw new Error("Choose a workspace or an artifact source module, not both.");
        let artifactSource: ArtifactSource | undefined;
        if (config.artifacts && values["session-owner"]) {
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
        const identity = await sessionServiceIdentity(root, config, agentId);
        if (values["session-owner"] && identity !== values["owner-identity"])
          throw new Error("Launcher selection changed during startup. No native work was opened; retry with the intended immutable release/configuration.");
        if (!workspaceAction && !values["session-owner"]) {
          const agent = agentId;
          const args = ["--root", root, "run", "--config", resolve(values.config), "--agent", agent, "--session", session,
            ...(values["release-manifest"] ? ["--release-manifest", resolve(values["release-manifest"])] : [])];
          // The runtime was selected above, so every owner another version had is closed.
          // Resume the ones a takeover interrupted, now that none of them is left running.
          for (const other of await takeInterruptedSessions(config.stateRoot)) {
            if (other === session) continue;
            const saved = await readFile(join(config.stateRoot, other, "conversation-agent.json"), "utf8").then(text => JSON.parse(text).agent as string, () => undefined);
            if (!saved) { console.error(`Session ${other} was closed for the runtime change; resume it with --session ${other} --resume-only and its agent.`); continue; }
            spawn(process.execPath, [process.argv[1], "--root", resolve(values.root!), "run", "--config", resolve(values.config!), "--agent", saved, "--session", other, "--resume-only"],
              { detached: true, stdio: "ignore", env: process.env }).unref();
          }
          const host = createHash("sha256").update(JSON.stringify(config)).digest("hex");
          const endpoint = await ensureSessionService({ stateRoot, identity, host, args: [...args, "--owner-host", host] });
          if (values["resume-only"]) console.log(JSON.stringify(endpoint));
          else await connectInTerminal({ socket: endpoint.socket, agent, session, prompt: values.prompt, requestId: values["request-id"],
            expected: { stateRoot: endpoint.stateRoot, identity: endpoint.identity }, drain: true,
            artifactDirectory: join(stateRoot, agent, "artifacts") });
          process.exit(process.exitCode ?? 0);
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
        try {
          const options: RunOptions = {
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
            // An ordinary session follows the selected release. Unfinished work keeps
            // its stored configuration; the changed definition applies at the next idle start.
            updateDefinitions: "when-idle", runtimeRoot: config.stateRoot, settings,
          };
          // Open exactly the ordinary session, never enable its factory jobs.
          const app = await run({ ...options, schedules: false, resume: false });
          let listener: Awaited<ReturnType<typeof serveService>> | undefined;
          let retired: Parameters<typeof retireSessionService>[0] | undefined;
          try {
            const socket = await sessionServiceSocket(stateRoot);
            await app.service.start();
            // Reads (a watching Web sidebar) do not keep an owner alive; admitted
            // commands, a waiting client and unfinished native work do.
            const idleMinutes = config.ownerIdleMinutes ?? 60;
            if (typeof idleMinutes !== "number" || !Number.isFinite(idleMinutes) || idleMinutes < 0) throw new Error("ownerIdleMinutes must be a nonnegative number.");
            let lastUse = Date.now(), waiting = 0;
            const used = new Set(["create", "send", "message", "stop", "compact", "drain"]);
            listener = await serveService(app.service, socket, app.adapters, { stateRoot: await realpath(stateRoot), identity, defaultAgent: agentId },
              { onCommand: (method, phase) => { if (used.has(method)) { waiting += phase === "start" ? 1 : -1; lastUse = Date.now(); } } });
            const endpoint = { version: 1 as const, socket, stateRoot: await realpath(stateRoot), identity, pid: process.pid, piDurable: piDurableVersion, host: values["owner-host"] };
            await publishSessionService(endpoint);
            if (process.connected) process.send?.({ ready: endpoint, info: { stateRoot: endpoint.stateRoot, identity, defaultAgent: agentId } }, () => {});
            let idle = false;
            await new Promise<void>(done => {
              process.once("SIGTERM", done); process.once("SIGINT", done);
              // A deferred definition update applies at the next start, so leave as soon as the saved work is done.
              const idleFor = deferredDefinitionUpdates.size ? 0 : idleMinutes * 60_000;
              if (!idleMinutes && !deferredDefinitionUpdates.size) return;
              const timer = setInterval(async () => {
                try {
                  if (waiting > 0 || Date.now() - lastUse < idleFor) return;
                  const adapterBusy = (await Promise.all(app.adapters.map(adapter => adapter.busy?.() ?? false))).some(Boolean);
                  if (adapterBusy || (await app.service.activity()).busy) { lastUse = Date.now(); return; }
                  if (waiting > 0) return;
                  idle = true; clearInterval(timer); done();
                } catch (error) { console.error(terminalError(error).message); }
              }, 15_000);
              timer.unref();
            });
            if (idle) { console.error("Session owner is idle; exiting. The next run starts it on the selected release."); retired = endpoint; }
          } finally { try { await listener?.close(); } finally { await app.close(); } }
          // Only after native state is closed, so a new owner never races this one.
          if (retired) await retireSessionService(retired);
        } finally { await modelConnection.close(); }
      }
    }
  }
} catch (error) {
  if (process.connected) process.send?.({ error: terminalError(error).message }, () => {});
  console.error(terminalError(error).message);
  process.exitCode = 1;
}
