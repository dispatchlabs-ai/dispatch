import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import type { LoadedAgent } from "./definition.js";
import { connectMcpServers, type McpServers } from "./mcp.js";
import { bindDestination, type MonitorDestination } from "./monitors.js";
import { privateStateDirectory } from "./private-state.js";
import type { ReviewRun } from "./run-evidence.js";
import { familyReports, reviewFamily, ReviewPending } from "./review-group.js";
import { githubPublisher, proposalBranch, type OpenPull, type ReviewPull } from "./review-github.js";
import { proposeReview, proposalRevision, type Decision } from "./review-proposal.js";
import { localReviewBase, repositoryName, reviewSource } from "./review-source.js";

export type CompletedReview = { id: string; agent: string; run: ReviewRun; report: string; text: string; complete: boolean };
export type ReviewCompletedHandler = (review: CompletedReview, options: { signal?: AbortSignal }) => Promise<void>;
export type ReviewPolicy = {
  /** Application module or installed package with a default ReviewCompletedHandler export. */
  onReviewComplete?: string;
  onActionableReview?: { paused?: boolean; openDraftPR: { repository: string; paths?: string[] }; onPROpened?: { notify: string } };
};
type Config = ReviewPolicy & { root: string; stateRoot: string; cwd?: string; mcpServers?: McpServers };
type Input = { /** The store that holds the run: the agent's own, or one chat's. */ directory: string; agent: string; run: ReviewRun; report: string; models: Models; settings?: HarnessOptions["settings"]; model: LoadedAgent["model"] };
export type RunReviewActions = (input: Input, signal?: AbortSignal, prepareOnly?: boolean) => Promise<string | undefined>;
type Result = { kind: "skip"; reason: string } | { kind: "pr"; pull: ReviewPull };
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

async function saved<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function save(file: string, text: string) {
  const temp = file + "." + randomUUID();
  await writeFile(temp, text, { mode: 0o600 }); await rename(temp, file);
}
const saveJson = (file: string, value: unknown) => save(file, JSON.stringify(value, null, 2) + "\n");
async function locked<T>(directory: string, signal: AbortSignal | undefined, fn: () => Promise<T>) {
  await privateStateDirectory(directory);
  for (;;) {
    signal?.throwIfAborted();
    let release: () => Promise<void>;
    try { release = await lockfile.lock(directory, { lockfilePath: join(directory, ".action.lock") }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      await delay(400, undefined, { signal }); continue;
    }
    try { return await fn(); } finally { await release(); }
  }
}

async function notify(config: Config, module: string, repository: string, pull: ReviewPull, directory: string, signal?: AbortSignal) {
  if (pull.state !== "open" || !pull.draft) return;
  const id = "dispatch.eval." + hash(repository) + ".pr." + pull.number;
  const specifier = module.startsWith(".") ? pathToFileURL(resolve(config.root, module)).href : module;
  const destination = (await import(specifier)).default as MonitorDestination;
  if (!destination || typeof destination.send !== "function") throw new Error("The PR notification module must export a destination.");
  // Preserve receipts from a previously configured recipient-bound connection.
  const receipt = join(directory, hash(destination.connection ?? module) + "-pr-" + pull.number + ".json");
  if (await saved(receipt)) return;
  const publisher = await githubPublisher(repository, config.root, signal);
  const live = await publisher.find(pull.branch);
  if (!live || live.number !== pull.number || live.state !== "open" || !live.draft) return;
  const mcp = destination.connection ? await connectMcpServers(config.mcpServers ?? {}, {
    cwd: config.cwd ?? config.root, names: [], privateNames: [destination.connection],
  }) : undefined;
  try {
    const sink = bindDestination(destination, name => mcp!.reminderCall(name));
    const status = await sink.send({ id, notice: { title: "Draft PR ready for review",
      message: `Review proposal #${pull.number} in ${repository}.`, link: pull.url } }, signal, async () => { signal?.throwIfAborted(); });
    if (!status) throw new Error("The notification destination did not confirm delivery.");
    await saveJson(receipt, { event_id: id, status });
  } finally { await mcp?.close(); }
}

export function configuredReviewActions(config: Config): RunReviewActions | undefined {
  const policy = config.onActionableReview, module = config.onReviewComplete;
  if (!policy && !module) return;
  const repository = policy && repositoryName(policy.openDraftPR.repository);
  const paths = policy?.openDraftPR.paths ?? ["."];
  const destination = policy?.onPROpened?.notify;
  if (policy?.onPROpened && !destination?.trim()) throw new Error("Select a recipient-bound notification module.");
  const appRoot = resolve(config.root);
  return async (input, signal, prepareOnly = false) => {
    const text = await readFile(input.report, "utf8");
    const room = dirname(input.report);
    const event: CompletedReview = { id: hash(JSON.stringify([input.agent, input.run.conversation, input.run.answer, room.split(/[\\/]/).at(-1)])),
      agent: input.agent, run: input.run, report: input.report, text, complete: !text.startsWith("**Incomplete evaluation.**") };
    if (module && !prepareOnly) {
      const handlerDir = join(room, "actions", hash(module));
      await locked(handlerDir, signal, async () => {
        const done = join(handlerDir, "completed.json");
        if (await saved(done)) return;
        const specifier = module.startsWith(".") ? pathToFileURL(resolve(appRoot, module)).href : module;
        const handler: ReviewCompletedHandler = (await import(specifier)).default;
        if (typeof handler !== "function") throw new Error("The review completion module needs a default handler.");
        await handler(event, { signal });
        await saveJson(done, { id: event.id });
      });
    }
    if (!repository || !event.complete) return;
    const family = reviewFamily(join(input.directory, "session.sqlite"), input.run);
    if (family.owned) return "Private review saved for the owning top-level run.";
    if (policy?.paused && !prepareOnly) throw new ReviewPending("Draft publication is paused in the host configuration.");
    if (family.pending) throw new ReviewPending("Waiting for owned runs and their private reviews.");
    const shared = join(config.stateRoot, ".review-actions", hash(repository));
    const receipts = join(room, "actions", hash(repository), ...(family.members.length ? ["group"] : []));
    const directory = prepareOnly ? join(receipts, "preview") : receipts;
    await privateStateDirectory(directory);
    // Local preparation has no GitHub side effects and remains available during a publication hold.
    return locked(prepareOnly ? directory : shared, signal, async () => {
      const file = join(receipts, "result.json");
      let result = await saved<Result>(file);
      const github = !result && !prepareOnly ? await githubPublisher(repository, appRoot, signal) : undefined;
      const intent = join(directory, "publishing.json");
      if (github) {
        const attempt = await saved<{ branch: string }>(intent);
        const pull = attempt && await github.find(attempt.branch);
        if (pull) { result = { kind: "pr", pull }; await saveJson(file, result); }
      }
      if (!result) {
        const reports = await familyReports(input.report, text, family.members);
        const base = github ? (await github.current()).sha : await localReviewBase(appRoot, repository);
        const source = await reviewSource(github ? "https://github.com/" + repository + ".git" : appRoot, base, paths, signal);
        try {
          const open = github ? await github.recent() : [];
          const planFile = join(directory, "proposal.json");
          const fingerprint = (pulls: OpenPull[]) => hash(JSON.stringify([
            proposalRevision, paths, prepareOnly, reports.map(hash), pulls.map(p => [p.number, p.title, p.head]),
          ]));
          const context = fingerprint(open);
          const cache = await saved<{ base: string; context: string; decision: Decision }>(planFile);
          const diffs = () => source.pullDiffs(open).catch(async error => {
            if (github && fingerprint(await github.recent()) !== context)
              throw new ReviewPending("An open PR changed while fetching. Refreshing the comparison.");
            throw error;
          });
          const decision = cache?.context === context && cache.base === base ? cache.decision :
            await proposeReview(source, reports, await diffs(), input.models, input.model, directory, input.settings, signal);
          if (github && (fingerprint(await github.recent()) !== context || (await github.current()).sha !== base))
            throw new ReviewPending("The base or an open PR changed. Refreshing the proposal comparison.");
          if (decision.kind === "skip") result = { kind: "skip", reason: decision.reason };
          else if (decision.kind === "existing") {
            const pull = open.find(p => p.number === decision.number);
            if (!pull) throw new Error("The proposal referenced an unavailable pull request.");
            result = { kind: "pr", pull };
          } else {
            const { proposal } = decision;
            const { patch, files } = await source.stage(proposal);
            const diff = join(directory, "proposal.patch");
            await save(diff, patch);
            await saveJson(planFile, { base, context, decision });
            if (!github) return "Prepared: " + diff;
            const body = proposal.reason + "\n\nChecked each edit against the committed source and ran `git diff --check`. A future agent run can verify the behavior.";
            // A crash after GitHub accepts the PR must recover it before planning against a new set of diffs.
            await saveJson(intent, { branch: proposalBranch(proposal.edits) });
            const pull = await github.publish(base, files, proposal, body);
            result = { kind: "pr", pull };
          }
          if (decision.kind !== "change") await saveJson(planFile, { base, context, decision });
          if (!prepareOnly) await saveJson(file, result);
        } finally { await source.close(); }
      }
      if (result.kind === "skip") return "No PR: " + result.reason;
      if (destination && !prepareOnly) await notify(config, destination, repository, result.pull, shared, signal);
      return "PR: " + result.pull.url;
    });
  };
}
