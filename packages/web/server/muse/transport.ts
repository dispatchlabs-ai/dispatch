import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { MuseClient, MuseInteractionRequiredError } from "./client.js";
import { museCommandId, type MuseInvocation, type MusePreparedRun, type MuseRunResult } from "./task.js";

type Bridge = { url: string; headers: Record<string, string> };
type Terminal = { terminal: string; error?: { kind: string } };

/** Native login/env remain native; only execution metadata and committed Pi tools cross this boundary. */
export async function runMuseQuery(input: {
  prepared: MusePreparedRun; invocation: MuseInvocation; bridge: Bridge; signal: AbortSignal;
}): Promise<MuseRunResult> {
  const { prepared, invocation, bridge, signal } = input;
  signal.throwIfAborted();
  const workspace = resolve(process.env.DISPATCH_DATA_DIR ?? ".local/state/dispatch", "muse-workspaces", invocation.sessionId);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, "AGENTS.md"), prepared.systemPrompt, { mode: 0o600 });
  signal.throwIfAborted();
  const client = new MuseClient(process.env.DISPATCH_MUSE_EXECUTABLE ?? "muse", [
    "serve", "--provider", "meta", "--model", prepared.model,
    "--trust-workspace", "--disable-shell", "--disable-write",
  ], nativeMuseEnvironment());
  let submitted = false;
  let turnId = invocation.commandId;
  const messages = new Map<string, string>();
  let complete!: (result: Terminal) => void;
  let fail!: (error: Error) => void;
  const terminal = new Promise<Terminal>((resolve, reject) => { complete = resolve; fail = reject; });
  // A terminal event may arrive before the turn/start response, so subscribe before admission.
  const unsubscribe = client.onNotification((method, params) => {
    if (params.sessionId !== invocation.sessionId) return;
    if (method === "item/completed") {
      const item = params.item as { kind: string; itemId: string; turnId?: string; text?: string };
      if (item.kind === "agentMessage" && item.turnId === turnId && item.text) messages.set(item.itemId, item.text);
    }
    if (method === "turn/completed" && params.turnId === turnId) complete(params as Terminal);
  });
  // Attach rejection handlers immediately; failures during initialization must not leak unhandled promises.
  void terminal.catch(() => {});
  void client.failed.catch(error => fail(error));
  const abort = () => {
    if (submitted) void client.request("turn/cancel", { commandId: museCommandId(), sessionId: invocation.sessionId, turnId }, 5_000).catch(() => {});
    client.interrupt();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await client.request("initialize", {
      clientInfo: { name: "dispatch", version: "1" }, capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: false },
    });
    client.notify("initialized");
    signal.throwIfAborted();
    await client.request(invocation.resume ? "session/resume" : "session/start", {
      commandId: invocation.sessionCommandId, sessionId: invocation.sessionId,
      ...(invocation.resume ? { excludeItems: true } : { workspaceRoot: workspace, modelId: prepared.model, providerId: "meta", approvalMode: "promptUnmatched" }),
      config: { mcpServers: { dispatch: { transport: "streamableHttp", url: bridge.url, headers: bridge.headers, mode: "required" } } },
    });
    signal.throwIfAborted();
    submitted = true;
    const admission = await client.request<{ turnId: string }>("turn/start", {
      commandId: invocation.commandId, sessionId: invocation.sessionId,
      input: prepared.prompt, reasoningEffort: prepared.reasoningEffort,
    });
    turnId = admission.turnId;
    const result = await terminal;
    signal.throwIfAborted();
    if (result.terminal !== "completed") {
      const error = result.error?.kind === "authRequired"
        ? "Muse Code requires login. Run muse on the configured runner and sign in, then retry."
        : "Muse Code could not complete this turn. Check the selected model’s subscription access, native account usage, and runner configuration before retrying.";
      return { sessionId: invocation.sessionId, text: "", success: false, error };
    }
    return { sessionId: invocation.sessionId, text: [...messages.values()].join("\n\n"), success: true };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof MuseInteractionRequiredError) return { sessionId: invocation.sessionId, text: "", success: false,
      error: "Muse Code requested unsupported native approval or input. The run was stopped; inspect saved activity and external effects before retrying." };
    if (submitted) throw error;
    return { sessionId: invocation.sessionId, text: "", success: false,
      error: "Muse Code could not initialize. Install Muse, sign in on the configured runner, and check model access and DISPATCH_MUSE_EXECUTABLE before retrying." };
  } finally {
    signal.removeEventListener("abort", abort);
    unsubscribe();
    await client.close();
  }
}

/** Preserve explicit native authentication without forwarding unrelated service/secret variables. */
function nativeMuseEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SHELL", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "MUSE_HOME", "META_API_KEY"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
