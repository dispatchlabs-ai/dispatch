// The native grading loop. Each model step (a frozen requirement extraction or one judgment) runs in its own
// tool-less conversation owned by the calling task and configured with the use case's grader. The use case's engine
// side plans the steps and validates and stores every answer. A restarted task reuses the same conversations and
// request IDs instead of asking again. The caller supplies the document that holds in-flight steps and the
// request-ID prefix, so each consumer keeps its own records.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AssistantEntry, configure } from "@earendil-works/pi-durable";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Grader = { model: { provider: string; modelId: string }; thinkingLevel: Thinking };
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A grader from `{provider, id, thinking}`, as in a use-case manifest's `grader`. */
export function graderFrom(g: any, where: string): Grader {
  if (typeof g?.provider !== "string" || typeof g?.id !== "string" || !THINKING.includes(g?.thinking))
    throw new Error(`${where} requires a grader with provider, id and thinking.`);
  return { model: { provider: g.provider, modelId: g.id }, thinkingLevel: g.thinking };
}
export const graderLabel = (g: Grader) => `${g.model.provider}/${g.model.modelId}/${g.thinkingLevel}`;
const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

type Unit = { conversation: number; attempt: number; fixes: number };
type Item = { key: string; step: "extract" | "judge"; instructions: string; prompt: string };
export type GradeEnv = {
  /** A session document whose `units` map records in-flight steps (each use case keeps its own). */
  doc: any;
  /** Request-ID prefix of the grader submissions. */
  prefix: string;
  grader: Grader;
  /** Runs one command of the use case's engine side; stdout is one JSON value. */
  py: (args: string[], signal: AbortSignal) => Promise<any>;
  workDir: string;
  /** Simultaneous steps; unset means every planned step at once. */
  concurrency?: number;
};

async function answerOf(runtime: any, answer: any, ctx: any) {
  let entry: any;
  await runtime.commit(async (tx: any) => { entry = await tx.entry(AssistantEntry, answer); }, ctx);
  const message = entry?.model?.[0];
  if (message?.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") throw new Error(`grader ended ${message?.stopReason ?? "without an answer"}`);
  return message.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
}

/**
 * Ask the grader for one item. A validation error goes back to the same conversation for correction once; any other
 * failure is recorded and the item is planned again (a fresh conversation and request ID) until it succeeds — later in
 * this round while the rounds still make progress, otherwise in the next run. Nothing is abandoned.
 */
async function modelStep(env: GradeEnv, item: Item, runtime: any, ctx: any): Promise<boolean> {
  const read = async () => ((await runtime.snapshot(env.doc, ctx)) ?? { units: {} }) as { units: Record<string, Unit> };
  const setUnit = (unit: Unit | null) => runtime.commit(async (tx: any) => {
    const s = await tx.doc(env.doc);
    if (unit) s.units[item.key] = unit; else delete s.units[item.key];
  }, ctx);
  let unit = (await read()).units[item.key];
  if (!unit?.conversation) {
    const attempt = unit?.attempt ?? 1;
    const instructions = await readFile(item.instructions, "utf8");
    await runtime.commit(async (tx: any) => {
      const s = await tx.doc(env.doc);
      if (s.units[item.key]?.conversation) return;
      const c = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
      await configure(tx, c.id, { ...env.grader, extensions: [], tools: [], instructions });
      s.units[item.key] = { conversation: Number(c.id), attempt, fixes: 0 };
    }, ctx);
    unit = (await read()).units[item.key];
  }
  let error = "";
  try {
    const handle = await runtime.conversation(unit.conversation as never, ctx);
    if (!handle) throw new Error("grader conversation missing");
    const base = `${env.prefix}:${item.key}:a${unit.attempt}`;
    let settled: any = await (await handle.submit({ type: "input", content: await readFile(item.prompt, "utf8"), requestId: base }, ctx)).wait(ctx);
    for (let fix = 0; ; fix++) {
      if (settled.status !== "done" || settled.type !== "input") throw new Error(`grader ${settled.status}${settled.reason ? ` (${settled.reason})` : ""}`);
      const text = await answerOf(runtime, settled.answer, ctx);
      const answer = join(env.workDir, `${item.key}.a${unit.attempt}.f${fix}.answer.md`);
      await writeFile(answer, text, { mode: 0o600 });
      try {
        await env.py(["ingest", "--grader", graderLabel(env.grader), "--key", item.key, "--answer", answer, "--conversation", String(unit.conversation)], runtime.signal);
        await setUnit(null);
        return true;
      } catch (e) {
        runtime.signal.throwIfAborted();
        if (fix >= 1 || /stale work item/.test(errorText(e))) throw e;
        settled = await (await handle.submit({ type: "input", requestId: `${base}:fix`,
          content: `Your answer could not be stored: ${errorText(e)}\nReturn the complete corrected JSON object only, in a \`\`\`json fence.` }, ctx)).wait(ctx);
      }
    }
  } catch (e) {
    runtime.signal.throwIfAborted();
    error = errorText(e);
  }
  if (/stale work item/.test(error)) { await setUnit(null); return false; }
  await env.py(["fail", "--key", item.key, "--error", error], runtime.signal).catch(() => undefined);
  await setUnit({ conversation: 0, attempt: unit.attempt + 1, fixes: 0 });
  return false;
}

/** Plan, run the planned model steps, and plan again until a whole round stores nothing. */
export async function gradeRounds(env: GradeEnv, runtime: any, ctx: any, ids: string[] | undefined, repeats: number, extractOnly = false) {
  const label = graderLabel(env.grader);
  await mkdir(env.workDir, { recursive: true, mode: 0o700 });
  let steps = 0;
  let failed: string[] = [];
  // Extraction unlocks judgment, and failed items get a fresh attempt; remaining failures are retried by the next run.
  for (;;) {
    const items: Item[] = await env.py(["plan", "--grader", label, "--repeats", String(repeats), ...(ids?.length ? ["--ids", ids.join(",")] : []),
      ...(extractOnly ? ["--extract-only"] : [])], runtime.signal);
    if (!items.length) { failed = []; break; }
    let next = 0, stored = 0;
    const roundFailed: string[] = [];
    await Promise.all(Array.from({ length: Math.min(env.concurrency ?? items.length, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (await modelStep(env, item, runtime, ctx)) stored++; else roundFailed.push(item.key);
      }
    }));
    runtime.signal.throwIfAborted();
    steps += stored;
    failed = roundFailed;
    if (!stored) break;
  }
  return { steps, failed };
}
