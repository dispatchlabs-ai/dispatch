import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { reportError } from "./terminal-output.js";
import {
  ExecutionError, FileError, LineScanner, err, ok,
  type BinaryReader, type DirReader, type ExecutionEnv, type FileInfo, type Result,
  type ShellExecOptions, type ShellExecResult, type TextLineReader,
} from "@earendil-works/pi-durable/env";

export type WorkspaceImage = { format: 1; contract: "dispatch-workspace-v1"; platform: "linux/amd64" | "linux/arm64"; image: string; sourceRevision: string };
export type WorkspaceRelease = {
  definitionsRoot: string; runtimeRevision: string;
  runtimeEntryPoint: { node: string; module: string };
  workspace: WorkspaceImage;
};
export type WorkspaceRecord = { run: string; release: WorkspaceRelease; state: string; finished?: boolean; sandbox?: string };

/** A host-owned, run-bound route to the workspace controller. */
export interface WorkspaceTransport {
  readonly run: string;
  /** False while this chat has never had a workspace; absent when the embedding host creates it before work. */
  readonly created?: boolean;
  request<T>(request: Record<string, unknown>, signal?: AbortSignal, output?: ShellExecOptions["onOutput"], context?: Context): Promise<T>;
}

/** The trusted host chooses the command and run. Neither comes from model arguments. */
export class WorkspaceClient implements WorkspaceTransport {
  constructor(readonly command: readonly string[], readonly run: string) {
    if (!command.length || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(run)) throw new Error("Invalid workspace command or run.");
  }
  request<T>(request: Record<string, unknown>, signal?: AbortSignal, output?: ShellExecOptions["onOutput"], context?: Context): Promise<T> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.command[0], this.command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", framed: T | undefined, failure: unknown;
      const abort = () => { failure = signal?.reason ?? new Error("Workspace request aborted."); child.kill("SIGTERM"); };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stderr.on("data", (value: string) => { stderr += value; });
      child.stdout.on("data", (value: string) => {
        stdout += value;
        if (!request.stream) return;
        let end: number;
        while ((end = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
          try {
            const frame = JSON.parse(line);
            if (frame.error) throw new Error(frame.error.message);
            if (frame.result) framed = frame.result;
            if (frame.output) output?.(frame.output, context!, { stream: frame.stream });
          } catch (error) { failure = error; child.kill("SIGTERM"); }
        }
      });
      child.on("error", error => { failure = error; });
      child.stdin.on("error", error => { failure ??= error; });
      child.on("close", code => {
        signal?.removeEventListener("abort", abort);
        if (failure) { reject(failure); return; }
        try {
          if (request.stream) {
            if (code || framed === undefined) throw new Error(stderr || stdout || "Workspace command did not return a result.");
            resolve(framed); return;
          }
          const result = JSON.parse(stdout);
          if (code || result?.error) throw new Error(result?.error?.message ?? stderr ?? "Workspace request failed.");
          resolve(result);
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ ...request, run: this.run }));
    });
  }
  environment(cwd = "/workspace") { return new WorkspaceEnvironment(this, cwd); }
}

/** Native tools retain Pi's task identities while all code and file access stays in the guest. */
export class WorkspaceEnvironment implements ExecutionEnv {
  readonly id: string;
  private commands = new Set<AbortController>();
  constructor(readonly client: WorkspaceTransport, public cwd = "/workspace") { this.id = `dispatch-workspace:${client.run}`; }
  private path(path: string) { return posix.resolve(this.cwd, path); }
  private async fs<T>(action: string, request: Record<string, unknown>, context: Context): Promise<Result<T, FileError>> {
    try { return ok(await this.client.request<T>({ op: "fs", request: { action, ...request } }, context.abortSignal)); }
    catch (error) {
      let code: FileError["code"] = context.abortSignal?.aborted ? "aborted" : "unknown";
      let message = String(error);
      try {
        const value = JSON.parse((error as Error).message); message = value.message;
        code = ({ 2: "not_found", 13: "permission_denied", 20: "not_directory", 21: "is_directory", 40: "invalid" } as const)[value.errno as 2] ?? code;
      } catch { /* A controller failure has no guest errno. */ }
      return err(new FileError(code, message, typeof request.path === "string" ? request.path : undefined));
    }
  }
  async absolutePath(path: string) { return ok<string, FileError>(this.path(path)); }
  async joinPath(parts: string[]) { return ok<string, FileError>(posix.join(...parts)); }
  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const result = await this.fs<{ content: string }>("read", { path: this.path(path) }, context);
    return result.ok ? ok(Buffer.from(result.value.content, "base64")) : result;
  }
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const result = await this.readBinaryFile(path, context);
    return result.ok ? ok(new TextDecoder().decode(result.value)) : result;
  }
  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const opened = await this.fs<{ handle: string; info: FileInfo }>("reader-open", { path: this.path(path), ...options }, context);
    if (!opened.ok) return opened;
    const request = { path: opened.value.handle };
    const read: BinaryReader["read"] = async (offset, length, ctx) => {
      const result = await this.fs<{ content: string }>("reader-read", { ...request, offset, length }, ctx);
      return result.ok ? ok(Buffer.from(result.value.content, "base64")) : result;
    };
    return ok({
      info: async () => ok(opened.value.info), read,
      scanLines: async (options, ctx) => {
        const scanner = new LineScanner(options.startLine, options.endLine);
        for (let offset = 0; offset < opened.value.info.size;) {
          const part = await read(offset, 65536, ctx); if (!part.ok) return part;
          if (!part.value.length) return err(new FileError("invalid", "Opened file ended unexpectedly.", path));
          scanner.push(part.value); offset += part.value.length;
        }
        return ok(scanner.finish());
      },
      close: async ctx => { const result = await this.fs<void>("reader-close", request, ctx); if (!result.ok) throw result.error; },
    });
  }
  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const opened = await this.openBinaryReader(path, undefined, context); if (!opened.ok) return opened;
    const reader = opened.value; const decoder = new TextDecoder();
    let offset = 0, text = "", ended = false;
    return ok({
      readLine: async ctx => {
        while (!ended && !text.includes("\n")) {
          const part = await reader.read(offset, 65536, ctx); if (!part.ok) return part;
          offset += part.value.length; ended = !part.value.length;
          text += decoder.decode(part.value, { stream: !ended });
        }
        const end = text.indexOf("\n");
        if (end >= 0) { const line = text.slice(0, end).replace(/\r$/, ""); text = text.slice(end + 1); return ok({ text: line, terminated: true }); }
        if (!text) return ok(undefined);
        const line = text; text = ""; return ok({ text: line, terminated: false });
      }, close: ctx => reader.close(ctx),
    });
  }
  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const opened = await this.openTextLineReader(path, context); if (!opened.ok) return opened;
    try {
      const lines: string[] = [];
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context); if (!line.ok) return line;
        if (!line.value) break; lines.push(line.value.text);
      }
      return ok(lines);
    } finally { await opened.value.close(context); }
  }
  writeFile(path: string, content: string | Uint8Array, context: Context) { return this.fs<void>("write", { path: this.path(path), content: Buffer.from(content).toString("base64") }, context); }
  appendFile(path: string, content: string | Uint8Array, context: Context) { return this.fs<void>("append", { path: this.path(path), content: Buffer.from(content).toString("base64") }, context); }
  truncateFile(path: string, size: number, context: Context) { return this.fs<void>("truncate", { path: this.path(path), size }, context); }
  flushFile(path: string, context: Context) { return this.fs<void>("flush", { path: this.path(path) }, context); }
  renameFile(path: string, destination: string, context: Context) { return this.fs<void>("rename", { path: this.path(path), destination: this.path(destination) }, context); }
  fileInfo(path: string, context: Context) { return this.fs<FileInfo>("info", { path: this.path(path) }, context); }
  listDir(path: string, context: Context) { return this.fs<FileInfo[]>("list", { path: this.path(path) }, context); }
  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const result = await this.listDir(path, context); if (!result.ok) return result;
    let offset = 0;
    return ok({ next: async maxEntries => { const entries = result.value.slice(offset, offset + maxEntries); offset += entries.length; return ok({ entries, done: offset === result.value.length }); }, close: async () => {} });
  }
  async watch() { return err<never, FileError>(new FileError("not_supported", "Disposable workspace file watching is not available.")); }
  canonicalPath(path: string, context: Context) { return this.fs<string>("canonical", { path: this.path(path) }, context); }
  exists(path: string, context: Context) { return this.fs<boolean>("exists", { path: this.path(path) }, context); }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) { return this.fs<void>("mkdir", { path: this.path(path), ...options }, context); }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) { return this.fs<void>("remove", { path: this.path(path), ...options }, context); }
  createTempDir(prefix: string | undefined, context: Context) { return this.fs<string>("temp-dir", { prefix }, context); }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) { return this.fs<string>("temp-file", { ...options }, context); }
  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const controller = new AbortController(); this.commands.add(controller);
    const signal = AbortSignal.any(context.abortSignal ? [context.abortSignal, controller.signal] : [controller.signal]);
    const timer = options?.timeout === undefined ? undefined : setTimeout(() => controller.abort(new Error("Workspace command timed out.")), options.timeout * 1000);
    try {
      return ok(await this.client.request<ShellExecResult>({ op: "shell", command, cwd: options?.cwd ?? this.cwd,
        env: options?.env, inheritEnv: options?.inheritEnv, spill: options?.spill, stream: true }, signal, options?.onOutput, context));
    } catch (error) {
      return err(new ExecutionError(context.abortSignal?.aborted ? "aborted" : controller.signal.aborted ? "timeout" : "unknown", String(error)));
    } finally { if (timer) clearTimeout(timer); this.commands.delete(controller); }
  }
  async cleanup() { for (const controller of this.commands) controller.abort(); }
}

/** Host settings for agents that select `workspace: "chat"`: the installed controller command and the pinned image.
 * A chat's workspace is suspended after `suspendAfterMinutes` without a request. The default is 15; 0 keeps it running. */
export type ChatWorkspaceHost = { command: string[]; image: WorkspaceImage; suspendAfterMinutes?: number };

export function chatWorkspaceHost(value: unknown): ChatWorkspaceHost {
  const host = value as Partial<ChatWorkspaceHost> | null;
  if (!host || typeof host !== "object" || !Array.isArray(host.command) || !host.command.length
    || host.command.some(part => typeof part !== "string" || !part) || !host.image || typeof host.image !== "object") {
    throw new Error("workspace needs a controller command and an image descriptor.");
  }
  const minutes = host.suspendAfterMinutes;
  if (minutes !== undefined && (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0)) {
    throw new Error("workspace.suspendAfterMinutes must be zero or a positive number.");
  }
  return { command: host.command, image: host.image, ...(minutes === undefined ? {} : { suspendAfterMinutes: minutes }) };
}

// The controller's answers for a guest that is not running, and for a run it has no record of.
const NOT_RUNNING = "Workspace is not running";
const UNKNOWN_RUN = "Bind this workflow to a release";

type Binding = { release: () => Promise<Omit<WorkspaceRelease, "runtimeEntryPoint">>; record: () => Promise<void> };

/** Creates a chat's workspace on its first tool request, so a turn without shell or file work creates none,
 * and suspends it once it has gone unused. The next request restores it. */
class ChatWorkspace {
  /** False while this chat has never had a workspace. */
  created = false;
  private ready?: Promise<void>;
  private suspending?: Promise<void>;
  private busy = 0;
  // When the workspace last served a request; zero while this host does not hold it running.
  private used: number;
  /** `running` is true for a workspace an earlier host process left running. */
  constructor(private readonly client: WorkspaceClient, private readonly listed: (running: boolean) => Promise<void>, running = false) {
    this.used = running ? Date.now() : 0;
  }
  get run() { return this.client.run; }
  // One caller's cancellation must not interrupt a start that other tool calls are waiting for.
  private start(binding: Binding) {
    return this.ready ??= (async () => {
      await this.suspending;
      await this.client.request({ op: "bind", release: await binding.release() });
      // Persist the intent before a guest can start. An interrupted ensure can still leave it running.
      await this.listed(true);
      this.used = Date.now();
      await this.client.request({ op: "ensure" });
      if (!this.created) { await binding.record(); this.created = true; }
    })().catch(error => { this.ready = undefined; throw error; });
  }
  async request<T>(binding: Binding, request: Record<string, unknown>, signal?: AbortSignal, output?: ShellExecOptions["onOutput"], context?: Context): Promise<T> {
    this.busy++;
    try {
      const ready = this.start(binding);
      await ready;
      try { return await this.client.request<T>(request, signal, output, context); }
      catch (error) {
        // The guest stopped after this host last started it. The controller refuses a file request before running
        // it, so that request is asked again. It gives the same answer for a shell command the stop cut off, so a
        // shell command is never repeated.
        if (!String(error).includes(NOT_RUNNING)) throw error;
        if (this.ready === ready) this.ready = undefined;
        await this.start(binding);
        if (request.op === "shell") throw new Error("The workspace had stopped and has been started again. This command was not repeated and may have been cut off.");
        return this.client.request<T>(request, signal, output, context);
      }
    } finally {
      this.busy--;
      if (this.used) this.used = Date.now();
    }
  }
  /** Checkpoint and remove the workspace if nothing has used it since `before`. Files under /workspace are kept;
   * running processes, browser pages and files elsewhere are not. */
  suspendIfIdle(before: number): Promise<void> | undefined {
    if (this.busy || this.suspending || !this.used || this.used > before) return;
    this.used = 0;
    this.ready = undefined;
    return this.suspending = (async () => {
      try { await this.client.request({ op: "suspend" }); }
      catch (error) {
        // A run the controller no longer knows has nothing left to suspend. Anything else is tried again later.
        if (!String(error).includes(UNKNOWN_RUN)) throw error;
      }
      await this.listed(false);
    })().catch(error => { this.used = Date.now(); throw error; }).finally(() => { this.suspending = undefined; });
  }
}

type OpenHarness = Awaited<ReturnType<typeof Harness.open>>;
/** `ledger` is where the host records the workspaces it has running, so a restarted host can still suspend them. */
export type ChatWorkspaceSettings = ChatWorkspaceHost & { ledger?: string };
export type ChatWorkspaces = {
  /** Save the store's workspace identity once, before any conversation resolves an environment. */
  identify(harness: OpenHarness, context: Context): Promise<void>;
  /** Every conversation of one chat, including delegated children, resolves to that chat's workspace. */
  environment(host: ChatWorkspaceSettings, agent: { root: string; fingerprint: string }, harness: () => OpenHarness): NonNullable<HarnessOptions["env"]>;
};

export function createChatWorkspaces(namespace: string): ChatWorkspaces {
  // A random value saved with the store keeps each chat's workspace identity with its Pi state. `created` names
  // the chats that have a workspace, so a restarted host still reads their repository instructions.
  const Identity = defineDoc<{ store: string; created?: Record<string, true> }>({
    kind: `${namespace}.chat-workspaces`, version: 1, scope: "session",
    checkpointWhen: () => false, initial: () => ({ store: "" }),
  });
  async function identify(harness: OpenHarness, context: Context) {
    await harness.commit(async tx => {
      const state = await tx.doc(Identity);
      state.store ||= randomBytes(32).toString("hex");
    }, context);
  }

  // Every agent of this host shares one set of workspaces, one ledger and one idle check.
  const workspaces = new Map<string, ChatWorkspace>();
  const running = new Set<string>();
  let saved = Promise.resolve();
  let loaded: Promise<void> | undefined;
  function load(host: ChatWorkspaceSettings) {
    const listed = (run: string) => (on: boolean) => {
      const update = saved.then(async () => {
        if (on === running.has(run)) return;
        const { ledger } = host;
        if (ledger) {
          const runs = on ? [...running, run] : [...running].filter(item => item !== run);
          await writeFile(`${ledger}.tmp`, JSON.stringify({ runs }), { mode: 0o600 });
          await rename(`${ledger}.tmp`, ledger);
        }
        if (on) running.add(run); else running.delete(run);
      });
      saved = update.catch(() => undefined);
      return update;
    };
    const workspace = (run: string, left = false) => {
      let found = workspaces.get(run);
      if (!found) workspaces.set(run, found = new ChatWorkspace(new WorkspaceClient(host.command, run), listed(run), left));
      return found;
    };
    loaded ??= (async () => {
      const text = host.ledger ? await readFile(host.ledger, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }) : undefined;
      // Workspaces an earlier process left running count as used now, and are suspended once they go unused.
      for (const run of text ? (JSON.parse(text) as { runs: string[] }).runs : []) { running.add(run); workspace(run, true); }
      const idle = (host.suspendAfterMinutes ?? 15) * 60_000;
      if (idle > 0) setInterval(() => {
        for (const item of workspaces.values()) {
          item.suspendIfIdle(Date.now() - idle)?.catch(error => reportError(`Could not suspend chat workspace ${item.run}:`, error));
        }
      }, Math.min(idle / 2, 60_000)).unref();
    })();
    return { loaded, workspace };
  }

  function environment(host: ChatWorkspaceSettings, agent: { root: string; fingerprint: string }, harness: () => OpenHarness): NonNullable<HarnessOptions["env"]> {
    const chats = new Map<ConversationId, ConversationId>();
    const release = async () => ({ definitionsRoot: await realpath(agent.root), runtimeRevision: agent.fingerprint, workspace: host.image });
    const { loaded, workspace } = load(host);
    return async (target, context) => {
      await loaded;
      let chat = chats.get(target.conversationId);
      if (chat === undefined) {
        chat = await harness().commit(async tx => {
          let id = target.conversationId;
          for (let record = await tx.conversation(id); record?.owner; record = await tx.conversation(id)) id = record.owner.conversationId;
          return id;
        }, context);
        chats.set(target.conversationId, chat);
      }
      // identify() saved this before the host resumed any work.
      const { store, created } = (await target.read.snapshot(Identity, context))!;
      const run = createHash("sha256").update(`${store}\0${chat}`).digest("hex");
      const key = String(chat);
      const binding = { release, record: () => harness().commit(async tx => {
        const saved = await tx.doc(Identity);
        // Assign a whole value: the document records assignments, not later changes to an assigned object.
        saved.created = { ...saved.created, [key]: true };
      }, BACKGROUND_CONTEXT) };
      // The conversation's saved working directory is a host path; the guest has its own.
      return new WorkspaceEnvironment({
        run,
        get created() { return created?.[key] === true || workspaces.get(run)?.created === true; },
        request: (request, signal, output, context) => workspace(run).request(binding, request, signal, output, context),
      }, "/workspace");
    };
  }
  return { identify, environment };
}
