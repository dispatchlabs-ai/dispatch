import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { query, type Query, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudePreparedRun, ClaudeRunResult, ClaudeRuntimeOptions } from "./task.js";

type QueryInput = {
  prepared: ClaudePreparedRun;
  sessionId: string;
  resume: boolean;
  options: ClaudeRuntimeOptions;
  signal: AbortSignal;
  observe(message: SDKMessage): Promise<void>;
  result(result: ClaudeRunResult): Promise<void>;
};
/**
 * The published binary owns authentication and model execution. Only explicitly granted Dispatch tools
 * are installed; filesystem settings, plugins and ambient SDK skills cannot add another tool surface.
 */
export async function runClaudeQuery(input: QueryInput): Promise<ClaudeRunResult | undefined> {
  input.signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", abort, { once: true });
  const exits: Promise<void>[] = [];
  let result: ClaudeRunResult | undefined;
  let stream: Query | undefined;
  try {
    stream = query({
      prompt: typeof input.prepared.prompt === "string" ? input.prepared.prompt : userPrompt(input),
      options: {
        ...input.options,
        abortController: controller,
        cwd: input.prepared.cwd,
        model: input.prepared.model,
        thinking: input.prepared.thinking,
        effort: input.prepared.effort,
        systemPrompt: input.prepared.systemPrompt,
        ...(input.resume ? { resume: input.sessionId } : { sessionId: input.sessionId }),
        persistSession: true,
        tools: [],
        skills: [],
        settingSources: [],
        plugins: [],
        strictMcpConfig: true,
        permissionMode: "default",
        includePartialMessages: false,
        // Notifications contain untrusted quoted paths/commands, not instructions to expand native @files.
        verbatimPrompts: true,
        // Authentication is resolved by the binary from its native user profile. Never inherit the
        // Dispatch service's provider/secret environment wholesale.
        env: input.options.env ?? nativeClaudeEnvironment(),
        spawnClaudeCodeProcess: options => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
            // SDK's forwarded signal fires after its stdin-EOF grace period, not immediately on Stop.
            signal: options.signal,
          });
          // The SDK's custom-spawner path does not consume this pipe. Discard rather than expose
          // potentially credential-bearing diagnostics or let a full stderr pipe deadlock shutdown.
          child.stderr.resume();
          exits.push(new Promise<void>(resolve => { child.once("close", () => resolve()); }));
          return child;
        },
      },
    });
    for await (const message of stream) {
      input.signal.throwIfAborted();
      if (message.type === "result") result = summarizeResult(message);
      else await input.observe(message);
    }
  } catch (error) {
    // The SDK throws after yielding an error result. Preserve that committed failure path without
    // exposing arbitrary subprocess stderr. Other errors leave the execution uncertain.
    if (!result || result.success) throw error;
  } finally {
    // close() itself is synchronous. Awaiting the actual process close is necessary for Pi's
    // cancellation/idle/worker-retirement guarantees; never leave a detached SDK subprocess behind.
    stream?.close();
    await Promise.all(exits);
    input.signal.removeEventListener("abort", abort);
  }
  input.signal.throwIfAborted();
  // Do not advertise a settled checkpoint until external execution has exited. A crash before this
  // commit remains uncertain; restart never automatically resends that prompt.
  if (result) await input.result(result);
  return result;
}
async function* userPrompt(input: QueryInput): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: input.prepared.prompt },
    parent_tool_use_id: null, session_id: input.sessionId, uuid: randomUUID() };
}
function summarizeResult(message: SDKResultMessage): ClaudeRunResult {
  const success = message.subtype === "success" && !message.is_error;
  return {
    sessionId: message.session_id,
    success,
    text: success && message.subtype === "success" ? message.result : "",
    ...(success ? {} : { error: claudeFailure(message) }),
  };
}
/** Minimal process environment; credentials never travel from Dispatch's provider store to the SDK. */
export function nativeClaudeEnvironment(owner: { home?: string; configDir?: string } = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SHELL", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (owner.home !== undefined) { env.HOME = owner.home; env.USERPROFILE = owner.home; }
  if (owner.configDir !== undefined) env.CLAUDE_CONFIG_DIR = owner.configDir;
  return env;
}

/** Report fixed actionable categories, never raw provider text or credential-bearing diagnostics. */
function claudeFailure(message: SDKResultMessage) {
  const text = message.subtype === "success" ? message.result : message.errors.join("\n");
  if (/usage limit|rate.?limit|limit reached|too many requests|429/i.test(text)) return "Claude Code reached its usage or rate limit. Check the native account's limits before retrying.";
  if (/not logged|log.?in|auth|token|credential|401|403/i.test(text)) return "Claude Code authentication or account access failed. Check native auth status and sign in again on the configured runner.";
  if (/model.*(not|unavailable|unsupported)|not.*model|404/i.test(text)) return "The selected model is unavailable to this Claude Code account. Select an accessible SDK model.";
  if (/connect|network|timeout|timed out|fetch|ENOTFOUND|ECONN/i.test(text)) return "Claude Code could not reach its provider. Check the runner's network and retry after inspecting any effects.";
  return `Claude Code ended without a successful answer (${message.subtype}). Inspect the native session on the runner; no raw provider diagnostics are disclosed.`;
}
