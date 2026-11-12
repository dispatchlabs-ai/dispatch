// The native evaluation task: one step of one use-case package, end to end.
//   collect  bundle retained runs from their records (no agent is rerun), then grade and publish
//   run      run the package's planned rerun (its target adapter), then grade and publish
//   grade    grade what is already collected, then publish
// The package's engine side (engine.py and the package's module) owns every deterministic step; this task owns the
// grader conversations (the grading loop), retries and recovery. A restarted step reuses stored work and request IDs.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineDoc, defineExtension, defineTask, type TaskId } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { gradeRounds, graderFrom } from "./grading.ts";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "engine");
export type EvalInput = { package: string; bindings: string; action: "collect" | "run" | "grade"; run?: string; limit?: number };
type Step = { key: string; task: number; startedAt: number; finishedAt?: number; outcome?: JsonValue };
export const EvalDoc = defineDoc<{ units: Record<string, { conversation: number; attempt: number; fixes: number }>; tasks: Record<string, number>; steps: Step[] }>({
  kind: "dispatch.eval", version: 1, scope: "session",
  initial: () => ({ units: {}, tasks: {}, steps: [] }),
  checkpointWhen: () => false,
});
const strict = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 800);
const keyOf = (i: EvalInput) => `${i.package}|${i.action}|${i.run ?? ""}`;

/**
 * The command that runs the engine. A release sets DISPATCH_EVAL_PYTHON to its packaged interpreter; from a source
 * checkout the engine runs through `uv` against the engine's lockfile, with its environment kept in `venv`.
 */
export function engineCommand(venv?: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const script = join(ENGINE, "dispatch_eval", "engine.py");
  const python = process.env.DISPATCH_EVAL_PYTHON;
  if (python) return { command: python, args: [script], env: process.env };
  return { command: process.env.DISPATCH_EVAL_UV ?? "uv", args: ["run", "-q", "--frozen", "--project", ENGINE, "python", script],
    env: { ...process.env, ...(venv ? { UV_PROJECT_ENVIRONMENT: venv } : {}) } };
}

/** One engine command for a package; its stdout is one JSON value. */
export function engine(pkg: string, bindingsFile: string, bindings: any, args: string[], signal: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const { command, args: prefix, env } = engineCommand(join(bindings.dataDir, "venv"));
    const child = spawn(command, [...prefix, "--package", pkg, "--bindings", bindingsFile, ...args], { stdio: ["ignore", "pipe", "pipe"], signal, env });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { if (err.length < 20_000) err += d; });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error(`engine ${args[0]} exited ${code}: ${err.trim().split("\n").slice(-4).join(" ").slice(0, 600)}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`engine ${args[0]} printed no JSON`)); }
    });
  });
}

export const EvaluationTask = defineTask<EvalInput, { phase: "work" }, unknown>({
  name: "dispatch.eval.step", version: 1,
  initial: () => ({ phase: "work" }),
  phases: {
    async work(task, runtime, ctx) {
      const input = task.input;
      const finish = (outcome: any) => runtime.commit(async (tx: any) => {
        const s = await tx.doc(EvalDoc);
        const step = s.steps.find((x: Step) => x.task === Number(runtime.taskId));
        if (step) { step.finishedAt = runtime.now(); step.outcome = strict(outcome.result ?? outcome.error ?? null); }
        return { status: "terminal", outcome } as any;
      }, ctx);
      try {
        const manifest = JSON.parse(await readFile(join(input.package, "eval.json"), "utf8"));
        const bindings = JSON.parse(await readFile(input.bindings, "utf8"));
        if (!String(bindings.dataDir ?? "").startsWith("/")) throw new Error("bindings: dataDir must be an absolute path.");
        const py = (args: string[], signal: AbortSignal) => engine(input.package, input.bindings, bindings, args, signal);
        let gathered: unknown = null;
        if (input.action === "collect") gathered = await py(["collect", ...(input.limit ? ["--limit", String(input.limit)] : [])], runtime.signal);
        if (input.action === "run") gathered = await py(["search", "--run", String(input.run)], runtime.signal);
        // A rerun with unfinished cases is not complete: they stay pending and the next step retries them.
        const searchErrors = input.action === "run" ? ((gathered as any)?.outcomes ?? []).filter((o: any[]) => String(o[2]).startsWith("error")) : [];
        const scope = await py(["run-ids", ...(input.run ? ["--run", input.run] : [])], runtime.signal);
        const env = { doc: EvalDoc, prefix: `eval:${manifest.name}`, grader: graderFrom(manifest.grader, `${manifest.name}/eval.json`), py,
          workDir: join(bindings.dataDir, "work"), ...(bindings.concurrency ? { concurrency: Number(bindings.concurrency) } : {}) };
        const ids = scope.all ? undefined : scope.ids;
        // A run with no collected units grades nothing (never "everything in the store").
        const none = !scope.all && !scope.ids.length;
        // The primary judgment first, then the repeats: every unit gets `judgments` judgments of the same outcome.
        const first = none ? { steps: 0, failed: [] as string[] } : await gradeRounds(env, runtime, ctx, ids, 0);
        const more = !none && scope.repeats ? await gradeRounds(env, runtime, ctx, ids, scope.repeats) : { steps: 0, failed: [] as string[] };
        const published = await py(["publish"], runtime.signal);
        const status = await py(["status"], runtime.signal);
        const failed = [...first.failed, ...more.failed];
        const result = { package: manifest.name, action: input.action, gathered, graded: first.steps + more.steps, failed, status, published };
        const problem = [searchErrors.length ? `${searchErrors.length} rerun cases did not finish` : "", failed.length ? `${failed.length} grader steps not stored` : ""].filter(Boolean).join("; ");
        return finish(problem ? { status: "failed", error: { message: problem }, result } : { status: "completed", result });
      } catch (error) {
        runtime.signal.throwIfAborted();
        return finish({ status: "failed", error: { message: errorText(error) } });
      }
    },
  },
  async abort(_task, runtime, ctx) {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
  },
});

export const EvaluationExtension = defineExtension({ name: "dispatch.eval", tasks: [EvaluationTask] });

/** The step for this package/action/run: an unfinished one is resumed (never duplicated); a finished one runs again. */
export async function ensureEvaluation(tx: any, conversationId: unknown, input: EvalInput, now: number) {
  const s = await tx.doc(EvalDoc);
  const key = keyOf(input);
  const live = s.tasks[key] ? await tx.task(s.tasks[key] as TaskId) : undefined;
  if (live && live.state.status !== "terminal") return { task: s.tasks[key] as number, resumed: true };
  const id = await tx.createTask(EvaluationTask, input, { ownership: { kind: "conversation" }, conversationId, background: true }) as unknown as number;
  s.tasks[key] = id;
  s.steps.push({ key, task: id, startedAt: now });
  return { task: id, resumed: false };
}
