import { resolve } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import type { StorageFactory } from "./runtime.js";
import type { Extension } from "@earendil-works/pi-durable";
import { createRunner, type Runner } from "./index.js";
import type { ChatService, ChatInitializer } from "./chat.js";
import type { ReplySink } from "./replies.js";
import { reportError } from "./terminal-output.js";

export type PreparedAdapter = {
  extension: Extension;
  queueReply: ReplySink;
  start(service: ChatService): Promise<void>;
  close(): Promise<void>;
};
export type Adapter = { prepare(options: { root: string; runner: Runner }): Promise<PreparedAdapter> };
export type RunOptions = {
  storage?: StorageFactory;
  root?: string;
  stateRoot?: string;
  /** Explicit local working directory for native tools and repository instructions. */
  cwd?: string;
  runner?: Runner;
  models?: Models;
  names?: string[];
  demo?: boolean;
  updateDefinitions?: boolean;
  /** Skip automatic recovery/schedules when inspecting saved conversations. */
  resume?: boolean;
  initialize?: ChatInitializer;
  adapters?: Adapter[];
  /** Attach domain workflows to the same host before adapters begin receiving. */
  open?: (options: { extensions: Extension[]; replySink?: ReplySink }) => Promise<ChatService>;
  beforeStart?: (service: ChatService) => Promise<void>;
};

/** Start a headless service. The caller owns process signals and calls close(). */
export async function run(options: RunOptions = {}) {
  const root = resolve(options.root ?? process.cwd());
  const runner = options.runner ?? createRunner();
  const adapters: PreparedAdapter[] = [];
  let service: ChatService | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const results = await Promise.allSettled(adapters.map(adapter => adapter.close()));
    try { await service?.close(); }
    finally {
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
  })();
  try {
    for (const adapter of options.adapters ?? []) adapters.push(await adapter.prepare({ root, runner }));
    const extensions = adapters.map(adapter => adapter.extension);
    // A transport destination is opaque to the runner. Adapters select their
    // destinations; applications using multiple transports provide their sink.
    const replySink = adapters.length === 1 ? adapters[0].queueReply : undefined;
    if (options.open) service = await options.open({ extensions, replySink });
    else {
      if (!options.models) throw new Error("Supply a Pi Models catalog or an open callback.");
      service = await runner.ChatService.open({
        root, stateRoot: resolve(options.stateRoot ?? resolve(root, ".state")),
        models: options.models, demo: options.demo ?? false, names: options.names,
        updateDefinitions: options.updateDefinitions, initialize: options.initialize,
        resume: options.resume,
        cwd: options.cwd, storage: options.storage,
        extensions, replySink,
      });
    }
    await options.beforeStart?.(service);
    for (const adapter of adapters) await adapter.start(service);
    if (options.resume !== false) for (const host of service.hosts.values()) host.harness.resume();
    return { runner, service, adapters, close };
  } catch (error) {
    await close().catch(closeError => reportError("Runner cleanup failed:", closeError));
    throw error;
  }
}
