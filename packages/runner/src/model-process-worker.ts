import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { serveProcess } from "./process-scope.js";
import type { ModelProcessConfig } from "./model-process.js";

// ProcessScope owns this group, including the executable, if the host disconnects or dies.
let child: ChildProcess | undefined;
let ended: Promise<void> | undefined;
serveProcess(async (operation: string, config: ModelProcessConfig, signal: AbortSignal) => {
  if (operation !== "start" || child) throw new Error("A model process accepts one start.");
  const exited = new AbortController();
  let failure = "Model process exited before becoming ready.";
  child = spawn(config.command, config.args, { stdio: "ignore" });
  ended = new Promise<void>(resolve => {
    child!.once("error", (error: NodeJS.ErrnoException) => {
      failure = error.code === "ENOENT" ? `Executable ${config.command} is unavailable on this host.` : `Could not start ${config.command}.`;
      exited.abort(); resolve();
    });
    child!.once("exit", code => { failure = `Model process exited (${code ?? "signal"}). Check its installation and availability.`; exited.abort(); resolve(); });
  });
  const combined = AbortSignal.any([signal, exited.signal]);
  try {
    while (true) {
      combined.throwIfAborted();
      try {
        const response = await fetch(config.readyUrl, { signal: combined });
        await response.body?.cancel();
        if (response.ok) break;
      } catch { combined.throwIfAborted(); }
      await delay(200, undefined, { signal: combined });
    }
  } catch (error) { if (exited.signal.aborted) throw new Error(failure); throw error; }
  void ended.then(() => process.exit(1));
  return { ready: true };
}, async () => { child?.kill("SIGTERM"); await ended; });
