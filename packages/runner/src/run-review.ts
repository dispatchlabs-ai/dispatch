import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { AssistantEntry, GenerationTask, Harness, createRegistry, defineExtension, defineTask, defineTool, hook, runEndTask, type Cursor, type HarnessOptions, type HookApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import type { LoadedAgent } from "./definition.js";
import { privateStateDirectory, privateStateFiles } from "./private-state.js";
import { reviewPageSize, runEvidence, type ReviewRun } from "./run-evidence.js";
import { reportError, terminalText } from "./terminal-output.js";

type ReviewHost = { directory: string; agent: string; model: LoadedAgent["model"]; models: Models; settings?: HarnessOptions["settings"] };

function reviewer(database: string, run: ReviewRun, evidence: string) {
  const pages = Math.ceil(evidence.length / reviewPageSize);
  let prior: string | undefined;
  const inspect = defineTool({
    name: "read_run", description: "Read a numbered page of this run's evidence, or the preceding conversation context. Pages start at 1. Each result identifies the total pages in that section.",
    parameters: Type.Object({ page: Type.Integer({ minimum: 1 }), context: Type.Optional(Type.Boolean()) }), replay: "safe",
    outputLimits: { maxBytes: reviewPageSize * 4 + 512, maxLines: reviewPageSize + 2 },
    async execute({ page, context }) {
      const source = context ? prior ??= runEvidence(database, run, "context") : evidence;
      const count = Math.max(1, Math.ceil(source.length / reviewPageSize));
      if (page > count) throw new Error(`This section has ${count} pages.`);
      const body = source.slice((page - 1) * reviewPageSize, page * reviewPageSize);
      return { output: [{ type: "text", text: `${context ? "Earlier context" : "Run evidence"} page ${page}/${count}\n${body || "(empty)"}` }],
        details: { section: context ? "context" : "run", page } };
    },
  });
  async function coverage(reader: Pick<HookApi, "entries">, ctx: Context) {
    // Count committed results across compaction and recovery.
    const read = new Set<number>();
    let cursor: Cursor | undefined, lastUser: unknown;
    do {
      const batch = await reader.entries({ order: "ascending" }, 100, cursor, ctx);
      for (const entry of batch.items) for (const message of entry.model ?? []) {
        if (message.role === "user") lastUser = message.content;
        if (message.role !== "toolResult" || message.toolName !== inspect.name || message.isError) continue;
        const details = message.details as { section?: string; page?: number } | undefined;
        if (details?.section === "run" && details.page !== undefined) read.add(details.page);
      }
      cursor = batch.next;
    } while (cursor);
    const missing = Array.from({ length: pages }, (_, i) => i + 1).filter(page => !read.has(page));
    return { missing, lastUser };
  }
  const extension = defineExtension({ name: "dispatch.run-reviewer", tools: [inspect],
    hooks: [hook(GenerationTask, { async onYield(_answer, api, ctx) {
      const { missing, lastUser } = await coverage(api, ctx);
      const prompt = `Read the remaining run evidence pages ${missing.join(", ")} before submitting your assessment.`;
      if (missing.length && lastUser !== prompt) return { continue: prompt };
    } })] });
  return { extension, pages, coverage };
}

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

/** One independent native conversation per completed run. Only the scoped evidence reader is installed. */
export async function reviewRun(host: ReviewHost, run: ReviewRun, ctx: Context, retryFailed = false) {
  const database = join(host.directory, "session.sqlite");
  const instructions = await readFile(new URL("../prompts/run-review.md", import.meta.url), "utf8");
  const revision = createHash("sha256").update(instructions).digest("hex").slice(0, 16);
  const directory = join(host.directory, "evaluations", `${run.conversation}-${run.answer}`, revision);
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
    // Freeze the evidence once so that document pruning on the source cannot change pages across recovery.
    const snapshot = join(directory, "evidence.ndjson");
    let evidence = await savedText(snapshot);
    if (evidence === undefined) {
      evidence = runEvidence(database, run, "run");
      await saveText(snapshot, evidence);
    }
    const { extension, pages, coverage } = reviewer(database, run, evidence);
    const registry = createRegistry();
    registry.install(extension);
    await privateStateFiles(directory);
    const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
    let harness: Harness | undefined;
    try {
      harness = await Harness.open(storage, { registry, models: host.models, settings: host.settings }, ctx);
      const conversation = await harness.root(ctx, { agent: { instructions, extensions: [extension],
        model: { provider: host.model.provider, modelId: host.model.id }, thinkingLevel: host.model.thinking } });
      const prompt = `Evaluate ${host.agent}, conversation ${run.conversation}, entries ${run.first} through ${run.last}, answer ${run.answer}. The run has ${pages} evidence pages.\nSource SQLite: ${database}`;
      // Stable IDs reattach after interruption. An explicit operator retry may continue a failed review once.
      let requestId = "review";
      let previous = await harness.commit(tx => tx.submissionByRequest(conversation.id, requestId), ctx);
      while (previous?.status === "unanswered" && retryFailed) {
        requestId = `retry:${previous.id}`;
        previous = await harness.commit(tx => tx.submissionByRequest(conversation.id, requestId), ctx);
      }
      const submission = await conversation.submit(requestId === "review" ? { type: "input", content: prompt, requestId }
        : { type: "continue", requestId }, ctx);
      harness.resume();
      const receipt = await submission.wait(ctx);
      if (receipt.type === "write" || receipt.status !== "done") throw new Error(`The evaluator stopped: ${JSON.stringify(receipt)}`);
      const entry = await conversation.commit(tx => tx.entry(AssistantEntry, receipt.answer), ctx);
      const result = entry?.model?.[0];
      if (result?.role !== "assistant") throw new Error("The evaluator returned no assistant message.");
      const answer = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim();
      if (!answer) throw new Error("The evaluator returned an empty assessment.");
      const { missing } = await coverage(conversation, ctx);
      const text = missing.length
        ? `**Incomplete evaluation.** The evaluator did not read evidence pages ${missing.join(", ")} of ${pages}.\n\n${answer}`
        : answer;
      await saveText(report, text + "\n");
      return { text, report };
    } finally {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
      else await storage.close(BACKGROUND_CONTEXT);
    }
  } finally { await release(); }
}

export function evaluationEnabled(value = process.env.DISPATCH_EVAL) {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("DISPATCH_EVAL must be 0 or 1.");
}

/** afterRun waits only for durable admission. The original answer and the next input never wait for model inference. */
export function runReviewExtension(host: ReviewHost, enabled: boolean) {
  const review = defineTask<ReviewRun, { phase: "review" }, string>({
    name: "dispatch.review-run", version: 1, initial: () => ({ phase: "review" }),
    phases: { async review(task, runtime, ctx) {
      try {
        const result = await reviewRun(host, task.input, withAbortSignal(runtime.signal, ctx));
        console.log(terminalText(`Evaluation: ${host.agent} / conversation ${task.input.conversation} / answer ${task.input.answer}\n${result.text}\nSaved: ${result.report}`));
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: result.report } }), ctx);
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
  return defineExtension({ name: "dispatch.run-reviews", tasks: [queue, review], hooks: enabled ? [hook(GenerationTask, {
    afterRun(run, api) { return { tasks: [runEndTask(queue, { conversation: api.conversationId, ...run })] }; },
  })] : [] });
}
