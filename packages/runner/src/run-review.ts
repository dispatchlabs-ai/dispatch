import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { GenerationTask, defineExtension, defineTask, hook, runEndTask, type HarnessOptions } from "@earendil-works/pi-durable";
import { ReviewPending } from "./review-group.js";
import type { LoadedAgent } from "./definition.js";
import { privateStateDirectory } from "./private-state.js";
import { assessEvidence, withReviewSession } from "./review-evidence-sections.js";
import { runEvidence, type ReviewRun } from "./run-evidence.js";
import { reportError, terminalText } from "./terminal-output.js";

import type { RunReviewActions } from "./review-actions.js";

type ReviewHost = { directory: string; agent: string; model: LoadedAgent["model"]; models: Models; settings?: HarnessOptions["settings"]; actions?: RunReviewActions };

async function savedText(path: string) {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}

async function saveText(path: string, text: string) {
  await writeFile(path + ".tmp", text, { mode: 0o600 });
  await rename(path + ".tmp", path);
}

/** Reuse the original run boundary and retained evidence across evaluator revisions. */
async function frozenEvidence(directory: string, revision: string, name: string, generate: () => string) {
  const path = join(directory, revision, name);
  let evidence = await savedText(path);
  if (evidence !== undefined) return evidence;
  for (const room of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (room.name === revision || !room.isDirectory() || !/^[a-f0-9]{16}$/.test(room.name)) continue;
    evidence = await savedText(join(directory, room.name, name));
    if (evidence !== undefined) break;
  }
  evidence ??= generate();
  await saveText(path, evidence);
  return evidence;
}

/** A private native session per completed run and evaluator revision. */
export async function reviewRun(host: ReviewHost, run: ReviewRun, ctx: Context, retryFailed = false) {
  const database = join(host.directory, "session.sqlite");
  const instructions = await readFile(new URL("../prompts/run-review.md", import.meta.url), "utf8");
  const revision = createHash("sha256").update(instructions).digest("hex").slice(0, 16);
  const root = join(host.directory, "evaluations", `${run.conversation}-${run.answer}`);
  const directory = join(root, revision);
  await privateStateDirectory(directory);
  const report = join(directory, "review.md");
  let release: () => Promise<void>;
  for (;;) {
    ctx.abortSignal?.throwIfAborted();
    const cached = await savedText(report);
    if (cached !== undefined) return { text: cached, report };
    try { release = await lockfile.lock(directory, { lockfilePath: join(directory, ".owner.lock") }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      await delay(500, undefined, { signal: ctx.abortSignal });
    }
  }
  try {
    const cached = await savedText(report);
    if (cached !== undefined) return { text: cached, report };
    const evidence = await frozenEvidence(root, revision, "evidence.ndjson", () => runEvidence(database, run, "run"));
    const model = host.models.getModel(host.model.provider, host.model.id);
    if (!model) throw new Error("The review model is unavailable.");
    const text = await withReviewSession(directory, { models: host.models, settings: host.settings }, ctx, harness => assessEvidence({
      harness, agent: { instructions, model: { provider: host.model.provider, modelId: host.model.id }, thinkingLevel: host.model.thinking },
      instructions, assignment: `Evaluate ${host.agent}, conversation ${run.conversation}, entries ${run.first} through ${run.last}, answer ${run.answer}.`,
      evidence, earlierEvidence: () => frozenEvidence(root, revision, "context.ndjson", () => runEvidence(database, run, "context")),
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, retryFailed, ctx,
    }));
    await saveText(report, text + "\n");
    return { text, report };
  } finally { await release(); }
}

export function evaluationEnabled(value = process.env.DISPATCH_EVAL) {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("DISPATCH_EVAL must be 0 or 1.");
}

/** afterRun waits only for durable admission. The original answer and the next input never wait for model inference. */
export function runReviewExtension(host: ReviewHost, enabled: boolean) {
  const actions = defineTask<{ run: ReviewRun; report: string }, { phase: "deliver" }, string | null>({
    name: "dispatch.run-review-actions", version: 1, initial: () => ({ phase: "deliver" }),
    phases: { async deliver(task, runtime, ctx) {
      let detail;
      try { detail = await host.actions?.({ ...host, ...task.input }, runtime.signal); }
      catch (error) {
        if (error instanceof ReviewPending) return runtime.sleepUntil(runtime.now() + 60_000, task.state.checkpoint, ctx);
        throw error;
      }
      if (detail) console.log(terminalText(detail));
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: detail ?? null } }), ctx);
    } },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const review = defineTask<ReviewRun, { phase: "review" }, string>({
    name: "dispatch.review-run", version: 1, initial: () => ({ phase: "review" }),
    phases: { async review(task, runtime, ctx) {
      try {
        const result = await reviewRun(host, task.input, withAbortSignal(runtime.signal, ctx));
        console.log(terminalText(`Evaluation: ${host.agent} / conversation ${task.input.conversation} / answer ${task.input.answer}\n${result.text}\nSaved: ${result.report}`));
        await runtime.commit(async tx => {
          if (host.actions) await tx.createTask(actions, { run: task.input, report: result.report }, { ownership: { kind: "conversation" }, background: true });
          return { status: "terminal", outcome: { status: "completed", result: result.report } };
        }, ctx);
      } catch (error) {
        runtime.signal.throwIfAborted();
        reportError(`Could not evaluate ${host.agent} / answer ${task.input.answer}:`, error);
        throw error;
      }
    } },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const queue = defineTask<ReviewRun, { phase: "queue" }, null>({
    name: "dispatch.queue-run-review", version: 1, initial: () => ({ phase: "queue" }),
    phases: { async queue(task, runtime, ctx) {
      await runtime.commit(async tx => {
        await tx.createTask(review, task.input, { ownership: { kind: "conversation" }, background: true });
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx);
    } },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  return defineExtension({ name: "dispatch.run-reviews", tasks: [queue, review, actions], hooks: enabled ? [hook(GenerationTask, {
    afterRun(run, api) { return { tasks: [runEndTask(queue, { conversation: api.conversationId, ...run })] }; },
  })] : [] });
}
