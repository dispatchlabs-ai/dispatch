import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { MuseClient, MuseInteractionRequiredError } from "./client.js";
import { museCommandId, type MuseInvocation, type MusePreparedRun, type MuseRunResult } from "./task.js";

// Increment when the native authorization posture changes; old sessions must start fresh.
export const MUSE_TRANSPORT_POLICY_REVISION = 3;

type Bridge = { url: string; headers: Record<string, string>; toolNames: string[]; authorize(): Promise<void> };
type Terminal = { terminal: string; error?: { kind: string } };

/** Native login/env remain native; only execution metadata and committed Pi tools cross this boundary. */
export async function runMuseQuery(input: {
  prepared: MusePreparedRun; invocation: MuseInvocation; bridge: Bridge; signal: AbortSignal;
}): Promise<MuseRunResult> {
  const { prepared, invocation, bridge, signal } = input;
  signal.throwIfAborted();
  if (prepared.transportPolicyRevision !== MUSE_TRANSPORT_POLICY_REVISION) {
    return { sessionId: invocation.sessionId, text: "", success: false,
      error: "Muse Code authorization policy changed. This run cannot continue. Ask the operator to review any earlier work and external effects before starting a new run." };
  }

  const workspace = resolve(homedir(), ".local", "share", "dispatch", "muse-workspaces", invocation.sessionId);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, "AGENTS.md"), prepared.systemPrompt, { mode: 0o600 });
  signal.throwIfAborted();
  let turnId = invocation.commandId;
  const allowed = new Set(bridge.toolNames.map(name => `mcp__dispatch__${name}`));
  const client = new MuseClient(process.env.DISPATCH_MUSE_EXECUTABLE ?? "muse", [
    "serve", "--provider", "meta", "--model", prepared.model,
    "--disable-sandbox", "--trust-workspace",
  ], workspace, nativeMuseEnvironment(), async (_method, params) => {
    signal.throwIfAborted();
    if (params.sessionId !== invocation.sessionId || typeof params.approvalId !== "string") throw new MuseInteractionRequiredError();
    const subject = params.subject as { kind?: string; toolName?: string; origin?: { kind?: string; url?: string } } | undefined;
    const choices = params.availableChoices as Array<{ choiceId: string; decision: string; scope: string }> | undefined;
    // Dispatch MCP calls retain exact invocation identity. Native capabilities use the
    // owner-bound runner's permissions, not the agent's optional Dispatch tool list.
    const dispatchTool = typeof params.toolName === "string" && params.toolName.startsWith("mcp__dispatch__");
    const approve = params.turnId === turnId && (dispatchTool
      ? !params.subagentOrigin && allowed.has(params.toolName as string) && subject?.kind === "tool"
        && subject.toolName === params.toolName
        && (subject.origin === undefined || (subject.origin.kind === "mcp" && subject.origin.url === bridge.url))
      : subject !== undefined && ["shell", "fileAccess", "network", "unixSocket", "process", "tool"].includes(subject.kind ?? ""));
    if (approve) await bridge.authorize();
    signal.throwIfAborted();
    const choice = choices?.find(choice => choice.scope === "once" && choice.decision === (approve ? "approved" : "denied"))
      ?? (!approve ? choices?.find(choice => choice.scope === "once" && choice.decision === "abort") : undefined);
    const requirement = params.currentRequirementId as { approvalId?: string; sourceIndex?: number } | undefined;
    if (!choice || typeof choice.choiceId !== "string" || requirement?.approvalId !== params.approvalId || typeof requirement.sourceIndex !== "number") throw new MuseInteractionRequiredError();
    await client.request("approval/decide", { commandId: museCommandId(), sessionId: invocation.sessionId,
      approvalId: params.approvalId, choiceId: choice.choiceId, requirementId: requirement });
  });
  let submitted = false;
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
      ...(invocation.resume ? { excludeItems: true } : { workspaceRoot: workspace, workspaceRoots: [workspace], modelId: prepared.model, providerId: "meta", approvalMode: "allowAll" }),
      config: { mcpServers: { dispatch: { transport: "streamableHttp", url: bridge.url, headers: bridge.headers, mode: "required" } } },
    });
    signal.throwIfAborted();
    submitted = true;
    const admission = await client.request<{ turnId: string }>("turn/start", {
      commandId: invocation.commandId, sessionId: invocation.sessionId,
      input: prepared.prompt, reasoningEffort: prepared.reasoningEffort, workspaceRoots: [workspace],
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
    return { sessionId: invocation.sessionId, text: [...messages.values()].at(-1) ?? "", success: true };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof MuseInteractionRequiredError) return { sessionId: invocation.sessionId, text: "", success: false,
      error: "Muse Code requested unsupported native approval or input. The run was stopped. Ask the operator to inspect the native Muse session and external effects before retrying." };
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
