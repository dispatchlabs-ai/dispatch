#!/usr/bin/env node
// dispatch-eval: the one entry point of the evaluation package.
import { execFileSync, spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { engineCommand } from "./task.ts";

const usage = `dispatch-eval run --config HOST.json --package DIR --bindings FILE (--collect [--limit N] | --run RUN | --grade) [--session KEY]
dispatch-eval engine --package DIR --bindings FILE COMMAND [OPTIONS]
dispatch-eval convert --data-dir DIR [--bundle-root DIR] [--clock-kind KIND] [--runtime DISPATCH_REVISION,PI_DURABLE_VERSION]
dispatch-eval records --db STORE.sqlite (--document-kind KIND [--limit N] [--ids 1,2] | --conversation ID) [--copy]

run       One step of one use-case package in a native session: collect retained runs or run a planned rerun, grade,
          then publish the report. Rerunning the same step resumes it. HOST.json is the on-demand host configuration
          (stateRoot, cwd, namespace, gateway or modelProviders); it must bind the grader named in the package's eval.json.
engine    One engine command without a native session: plan-run, compare, status, agreement, publish, report, runs.
convert   Upgrade a schema-1 store in place; the original file is kept beside it.
records   Read evidence from a native Pi Durable store, read-only. --copy reads a private temporary copy that is
          removed before the command returns.`;

const HERE = dirname(fileURLToPath(import.meta.url));
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));

/** The build this command belongs to: a release manifest when there is one, otherwise the source checkout. */
async function buildIdentity(releaseManifest: string | undefined, piDurable: string) {
  if (releaseManifest) {
    const release = await read(releaseManifest);
    // A use-case package inside the release (the company's definitions, or this package's example) is release content.
    return { release: release.name, definitions: { revision: release.revision }, roots: [release.definitionsRoot, join(HERE, "..")],
      dispatch: { revision: release.dispatch.revision, version: release.dispatch.version }, pi_durable: piDurable };
  }
  let revision: string | null = null;
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", HERE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    revision = git("rev-parse", "HEAD") + (git("status", "--porcelain") ? "-dirty" : "");
  } catch { /* not a checkout: the revision stays unknown, which reports treat as a development build */ }
  const version = (await read(join(HERE, "..", "package.json"))).version;
  return { release: "source checkout", definitions: { revision: null }, dispatch: { revision, version }, pi_durable: piDurable };
}

/** What every engine process is told: the build, and how to start the record reader. */
async function engineEnvironment(releaseManifest: string | undefined) {
  const { piDurableVersion } = await import("@dispatch/runner");
  process.env.DISPATCH_EVAL_BUILD = JSON.stringify(await buildIdentity(releaseManifest, piDurableVersion));
  process.env.DISPATCH_EVAL_RECORDS = JSON.stringify([process.execPath, fileURLToPath(import.meta.url), "records"]);
}

async function runStep(args: string[], releaseManifest: string | undefined) {
  const { values: opt } = parseArgs({ args, options: { config: { type: "string" }, package: { type: "string" }, bindings: { type: "string" },
    collect: { type: "boolean" }, grade: { type: "boolean" }, run: { type: "string" }, limit: { type: "string" }, session: { type: "string" } } });
  if (!opt.config || !opt.package || !opt.bindings || [opt.collect, opt.grade, !!opt.run].filter(Boolean).length !== 1) throw new Error(usage);
  const config = await read(opt.config);
  for (const field of ["stateRoot", "cwd"]) if (typeof config[field] !== "string" || !isAbsolute(config[field])) throw new Error(`${field} must be an absolute path.`);
  const pkg = await realpath(opt.package), bindingsFile = await realpath(opt.bindings);
  const usecase = await read(join(pkg, "eval.json"));
  const session = opt.session ?? process.env.DISPATCH_EVAL_SESSION ?? `eval-${usecase.name}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(session)) throw new Error("Invalid session key.");
  await engineEnvironment(releaseManifest);

  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { fauxAssistantMessage, fauxProvider } = await import("@earendil-works/pi-ai");
  const { run, createRunner, context, sessionAgent } = await import("@dispatch/runner");
  const { connectHostModels } = await import("@dispatch/runner/host-models");
  const { serviceSettings } = await import("@dispatch/runner/settings");
  const evaluation = await import("./task.ts");

  // The owner agent is this package's own definition, so the company's definitions need none. Its provider is
  // bound here to a fixed reply: the session hosts evaluation steps and makes no model call of its own.
  const definitions = join(HERE, "..", "definitions"), owner = "dispatch-eval";
  const stateRoot = join(config.stateRoot, session);
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  const fixed = fauxProvider({ provider: owner, models: [{ id: "owner", reasoning: false, input: ["text"] }] });
  const reply = () => fauxAssistantMessage("This session hosts evaluation steps and does not chat. Start a step with dispatch-eval run.");
  const stream: typeof fixed.provider.stream = (model, transcript, options) => { fixed.appendResponses([reply]); return fixed.provider.stream(model, transcript, options); };
  models.setProvider({ ...fixed.provider, stream, streamSimple: stream as typeof fixed.provider.streamSimple });
  await models.refresh({ providers: [owner] });
  const connection = await connectHostModels(config, models);
  let app: Awaited<ReturnType<typeof run>> | undefined;
  try {
    if (!models.getProvider(usecase.grader?.provider)) throw new Error(`HOST.json binds no provider named ${usecase.grader?.provider}, the grader in ${usecase.name}/eval.json.`);
    await sessionAgent(definitions, stateRoot, owner);
    process.env.DISPATCH_SESSION_STATE_ROOT = stateRoot;
    process.chdir(config.cwd);
    app = await run({ root: definitions, stateRoot, cwd: config.cwd, runner: createRunner({ namespace: config.namespace }), models, names: [owner],
      schedules: false, settings: serviceSettings(config), resume: false, updateDefinitions: "when-idle" });
    const host = app.service.host(owner);
    const chat = await app.service.create(owner, "cli", `terminal:${session}`, "Evaluation");
    const input = { package: pkg, bindings: bindingsFile, action: opt.collect ? "collect" as const : opt.run ? "run" as const : "grade" as const,
      ...(opt.run ? { run: opt.run } : {}), ...(opt.limit ? { limit: Number(opt.limit) } : {}) };
    const step = await host.harness.commit(tx => evaluation.ensureEvaluation(tx, chat.conversationId, input, Date.now()), context);
    const build = JSON.parse(process.env.DISPATCH_EVAL_BUILD!);
    const log = (event: string, extra: object) => console.log(JSON.stringify({ event, at: new Date().toISOString(), session,
      release: build.release, definitions: build.definitions.revision, dispatch: build.dispatch.revision, usecase: usecase.name, ...extra }));
    log("eval_started", { ...step, input });
    await app.service.start();
    const settled: any = await host.harness.waitForTask(step.task as never, context);
    const outcome = settled.outcome ?? settled.state?.outcome;
    log("eval_finished", { task: step.task, outcome });
    if (outcome?.status !== "completed") process.exitCode = 1;
  } finally {
    await app?.close();
    await connection.close();
  }
}

/** Pass one engine command through; the engine prints one JSON value. */
async function engine(args: string[], releaseManifest: string | undefined) {
  await engineEnvironment(releaseManifest);
  const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  // From a source checkout the engine's environment lives with the use case's data, never inside this package.
  const bindings = option("--bindings"), data = option("--data-dir");
  const venv = bindings ? join((await read(bindings)).dataDir, "venv") : data ? join(data, "venv") : undefined;
  const { command, args: prefix, env } = engineCommand(venv);
  const child = spawn(command, [...prefix, ...args], { stdio: "inherit", env });
  process.exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
}

async function records(args: string[]) {
  const { values } = parseArgs({ args, options: { db: { type: "string" }, "document-kind": { type: "string" }, limit: { type: "string" },
    ids: { type: "string" }, conversation: { type: "string" }, copy: { type: "boolean" } } });
  if (!values.db || (!values["document-kind"] === !values.conversation)) throw new Error(usage);
  const { readRecords, withInspectionCopy } = await import("./records.ts");
  const select = (database: string) => readRecords({ database, documentKind: values["document-kind"],
    ...(values.conversation ? { conversation: Number(values.conversation) } : {}),
    ...(values.ids ? { ids: values.ids.split(",").map(Number) } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}) });
  const result = values.copy ? await withInspectionCopy(values.db, select) : select(values.db);
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(result), error => error ? reject(error) : resolve()));
}

try {
  let args = process.argv.slice(2), releaseManifest = process.env.DISPATCH_EVAL_RELEASE;
  if (args[0] === "--release-manifest") { releaseManifest = args[1]; args = args.slice(2); }
  const [command, ...rest] = args;
  if (command === "run") await runStep(rest, releaseManifest);
  else if (command === "engine") await engine(rest, releaseManifest);
  else if (command === "convert") await engine(["convert", ...rest], releaseManifest);
  else if (command === "records") await records(rest);
  else if (command === "--help" || command === "help") console.log(usage);
  else throw new Error(usage);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
// Native owners and provider clients may hold the event loop open after their work is closed.
process.exit();
