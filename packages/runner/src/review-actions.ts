import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type { Models } from "@earendil-works/pi-ai/models";
import type { LoadedAgent } from "./definition.js";
import { connectMcpServers, type McpServers } from "./mcp.js";
import { privateStateDirectory } from "./private-state.js";
import type { ReviewRun } from "./run-evidence.js";
import { githubPublisher, type ReviewPull } from "./review-github.js";
import { proposeReview, proposalRevision, type Decision } from "./review-proposal.js";
import { localReviewBase, repositoryName, reviewSource } from "./review-source.js";

export type CompletedReview = { id: string; agent: string; run: ReviewRun; report: string; text: string; complete: boolean };
export type ReviewCompletedHandler = (review: CompletedReview, options: { signal?: AbortSignal }) => Promise<void>;
export type ReviewPolicy = {
  /** Application module or installed package with a default ReviewCompletedHandler export. */
  onReviewComplete?: string;
  onActionableReview?: { openDraftPR: { repository: string; paths?: string[] }; onPROpened?: { notify: string } };
};
type Config = ReviewPolicy & { root: string; stateRoot: string; cwd?: string; mcpServers?: McpServers };
type Input = { agent: string; run: ReviewRun; report: string; models: Models; model: LoadedAgent["model"] };
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

async function notify(config: Config, connection: string, repository: string, pull: ReviewPull, directory: string, signal?: AbortSignal) {
  if (pull.state !== "open" || !pull.draft) return;
  const id = "dispatch.eval." + hash(repository) + ".pr." + pull.number;
  const receipt = join(directory, hash(connection) + "-pr-" + pull.number + ".json");
  if (await saved(receipt)) return;
  const publisher = await githubPublisher(repository, config.root, signal);
  const live = await publisher.find(pull.branch);
  if (!live || live.number !== pull.number || live.state !== "open" || !live.draft) return;
  const mcp = await connectMcpServers(config.mcpServers ?? {}, { cwd: config.cwd ?? config.root, names: [], privateNames: [connection] });
  try {
    const result = await mcp.reminderCall(connection)("send_alert", { event_id: id, title: "Draft PR ready for review",
      message: `Review proposal #${pull.number} in ${repository}.`, link: pull.url }, signal);
    if (result.isError) throw new Error("The notification service declined the PR alert.");
    const content = result.content.find(c => c.type === "text");
    const value = (result.structuredContent ?? (content?.type === "text" ? JSON.parse(content.text) : null)) as { event_id?: string; status?: string } | null;
    if (!value || value.event_id !== id || !value.status) throw new Error("The notification service did not confirm this event ID.");
    await saveJson(receipt, value);
  } finally { await mcp.close(); }
}

export function configuredReviewActions(config: Config): RunReviewActions | undefined {
  const policy = config.onActionableReview, module = config.onReviewComplete;
  if (!policy && !module) return;
  const repository = policy && repositoryName(policy.openDraftPR.repository);
  const paths = policy?.openDraftPR.paths ?? ["."];
  const destination = policy?.onPROpened?.notify;
  if (policy?.onPROpened && (!destination || !config.mcpServers?.[destination])) throw new Error("Select a configured recipient-bound notification connection.");
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
    const shared = join(config.stateRoot, ".review-actions", hash(repository));
    const directory = join(room, "actions", hash(repository));
    await privateStateDirectory(directory);
    return locked(shared, signal, async () => {
      const file = join(directory, "result.json");
      let result = await saved<Result>(file);
      if (!result) {
        const github = prepareOnly ? undefined : await githubPublisher(repository, appRoot, signal);
        const base = github ? (await github.current()).sha : await localReviewBase(appRoot, repository);
        const source = await reviewSource(github ? "https://github.com/" + repository + ".git" : appRoot, base, paths, signal);
        try {
          const open = github ? await github.recent() : [];
          const planFile = join(directory, "proposal.json");
          const context = hash(JSON.stringify([proposalRevision, paths, open.map(p => [p.number, p.title])]));
          const cache = await saved<{ base: string; context: string; decision: Decision }>(planFile);
          const reusable = cache?.context === context && (cache.base === base ||
            cache.decision.kind === "change" && await source.unchanged(cache.base, cache.decision.proposal.edits.map(edit => edit.path)));
          const decision = reusable ? cache.decision : await proposeReview(source, text, open, input.models, input.model, signal);
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
