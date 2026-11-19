import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness, type HarnessOptions } from "@earendil-works/pi-durable";
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
  /** False until this host has started the workspace; absent when the embedding host starts it before work. */
  readonly started?: boolean;
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

/** Host settings for agents that select `workspace: "chat"`: the installed controller command and the pinned image. */
export type ChatWorkspaceHost = { command: string[]; image: WorkspaceImage };

export function chatWorkspaceHost(value: unknown): ChatWorkspaceHost {
  const host = value as Partial<ChatWorkspaceHost> | null;
  if (!host || typeof host !== "object" || !Array.isArray(host.command) || !host.command.length
    || host.command.some(part => typeof part !== "string" || !part) || !host.image || typeof host.image !== "object") {
    throw new Error("workspace needs a controller command and an image descriptor.");
  }
  return { command: host.command, image: host.image };
}

/** Starts a chat's workspace on its first tool request, so a turn without shell or file work creates none. */
class ChatWorkspace implements WorkspaceTransport {
  started = false;
  private starting?: Promise<void>;
  constructor(private readonly client: WorkspaceClient, private readonly release: () => Promise<Omit<WorkspaceRelease, "runtimeEntryPoint">>) {}
  get run() { return this.client.run; }
  // One caller's cancellation must not interrupt a start that other tool calls are waiting for.
  private start() {
    return this.starting ??= (async () => {
      await this.client.request({ op: "bind", release: await this.release() });
      await this.client.request({ op: "ensure" });
      this.started = true;
    })().catch(error => { this.starting = undefined; throw error; });
  }
  async request<T>(request: Record<string, unknown>, signal?: AbortSignal, output?: ShellExecOptions["onOutput"], context?: Context): Promise<T> {
    await this.start();
    return this.client.request<T>(request, signal, output, context);
  }
}

type OpenHarness = Awaited<ReturnType<typeof Harness.open>>;
export type ChatWorkspaces = {
  /** Save the store's workspace identity once, before any conversation resolves an environment. */
  identify(harness: OpenHarness, context: Context): Promise<void>;
  /** Every conversation of one chat, including delegated children, resolves to that chat's workspace. */
  environment(host: ChatWorkspaceHost, agent: { root: string; fingerprint: string }, harness: () => OpenHarness): NonNullable<HarnessOptions["env"]>;
};

export function createChatWorkspaces(namespace: string): ChatWorkspaces {
  // A random value saved with the store keeps each chat's workspace identity with its Pi state.
  const Identity = defineDoc<{ store: string }>({
    kind: `${namespace}.chat-workspaces`, version: 1, scope: "session",
    checkpointWhen: () => false, initial: () => ({ store: "" }),
  });
  async function identify(harness: OpenHarness, context: Context) {
    await harness.commit(async tx => {
      const state = await tx.doc(Identity);
      state.store ||= randomBytes(32).toString("hex");
    }, context);
  }
  function environment(host: ChatWorkspaceHost, agent: { root: string; fingerprint: string }, harness: () => OpenHarness): NonNullable<HarnessOptions["env"]> {
    const chats = new Map<ConversationId, ConversationId>();
    const workspaces = new Map<string, ChatWorkspace>();
    const release = async () => ({ definitionsRoot: await realpath(agent.root), runtimeRevision: agent.fingerprint, workspace: host.image });
    return async (target, context) => {
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
      const { store } = (await target.read.snapshot(Identity, context))!;
      const run = createHash("sha256").update(`${store}\0${chat}`).digest("hex");
      let workspace = workspaces.get(run);
      if (!workspace) workspaces.set(run, workspace = new ChatWorkspace(new WorkspaceClient(host.command, run), release));
      // The conversation's saved working directory is a host path; the guest has its own.
      return new WorkspaceEnvironment(workspace, "/workspace");
    };
  }
  return { identify, environment };
}
