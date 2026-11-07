import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { awaitWithContext, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { AssistantEntry, ConversationBusy, InboxDoc, LiveDoc, ToolResultEntry, ToolTask, defineDoc, defineExtension, defineTask, type ConversationId, type Cursor, type EntryId, type LiveState, type SubmissionDraft, type TaskId, type TaskRuntime, type ToolTaskInput, type ToolTaskResult, type Tx } from "@earendil-works/pi-durable";
import { context, publicCommentary, publicAnswer, type ChatService, type Runner, type ReplySink } from "@dispatch/runner";
import { fallbackText, progressText, replyBlocks, replyChunk, streamText } from "./text.js";
import { slackArtifacts } from "./files.js";
import { createStatusDelivery } from "./status.js";
import { activityLabel, currentToolActivity, type SlackActivity, type SlackToolDescription } from "./progress.js";
export type { SlackActivity, SlackToolCall, SlackToolDescription } from "./progress.js";
export { SlackThreadProcesses } from "./threads.js";
export { runSlackHost, type SlackHostOptions } from "./host.js";

export type SlackConfig = {
  teamId: string; channels: Record<string, string>; directMessagesAgent?: string;
  allowedUsers?: string[]; botTokenEnv?: string; appTokenEnv?: string; credentialsEnv?: string;
  displayName?: string;
  /** Ignore messages addressed to a peer bot unless this bot is also mentioned. */
  peerBotUserIds?: string[];
  /** With "started", require mentions inside threads started for another bot. */
  threadReplies?: "all" | "started";
};
type SlackInput = { text: string; key: string; channel: string; thread: string; user: string; replyText?: string; after?: number; continuation?: string };
export type SlackThreadInput = SlackInput & {
  team: string; timestamp: string;
  agent: string; direct: boolean; mentioned: boolean; threaded: boolean;
  parentUser: string | null;
};
type Incoming = SlackThreadInput & { previous: number | null };
type Delivery = { indicator?: number } & ({ phase: "answer"; commentary?: boolean; admitted?: boolean } | {
  phase: "deliver"; text: string; offset: number; retryAt: number; stream: string | null; after?: number; streamTail?: string;
});

function retryDelay(error: unknown) {
  const seconds = (error as { retryAfter?: number })?.retryAfter;
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : 30_000;
}

function slackError(error: unknown) {
  return (error as { data?: { error?: string } })?.data?.error;
}

export type Report = { agent: string; channel: string; thread?: string; text: string; key: string; origin: import("@earendil-works/pi-durable").JsonObject; title?: string };
export const threadKey = (team: string, channel: string, thread: string) => `slack:${team}:${channel}:${thread}`;

export type SlackActionToken = {
  teamId: string; channelId: string; threadTs: string; userId: string; eventTs: string; token: string;
};
export type SlackOptions = {
  connection?: string; config?: SlackConfig; credentials?: { botToken: string; appToken: string };
  /** Host-only credential handoff. Never put the token in native input or model context. */
  onActionToken?: (value: SlackActionToken) => void | Promise<void>;
  /** Trusted host routing: admission completes when the thread's native store accepts it. */
  threads?: { receive(input: SlackThreadInput): Promise<void>; stop(input: SlackThreadInput): Promise<void> };
  /** Wake an owned coordinator's observation so in-run steering is not held behind a long poll. */
  onInput?: (conversationId: number) => void;
  onStream?: (event: { key: string; ts: string; done?: boolean }) => void | Promise<void>;
  /** Host evidence gate for partial model text. Status and final-answer delivery remain independent. */
  allowProgressText?: (conversationId: number, inputIds: readonly number[]) => boolean | Promise<boolean>;
  /** Revalidate a trusted continuation's request identity at atomic native admission. */
  allowContinuation?: (tx: Tx, conversationId: ConversationId, request: string) => Promise<boolean>;
  /** Select public activity wording from native tool intent. Raw arguments are never displayed by default. */
  describeTool?: SlackToolDescription;
};

export function slack(options: SlackOptions = {}) {
  let prepared: Awaited<ReturnType<typeof prepareSlack>> | undefined;
  let service: ChatService | undefined;
  return {
    async prepare({ root, runner }: { root: string; runner: Runner }) {
      prepared = await prepareSlack(root, runner, options);
      const connection = prepared;
      return { ...connection, async start(value: ChatService) { service = value; await connection.start(value); } };
    },
    async bindThread(value: ChatService, report: Omit<Report, "text" | "key"> & { thread: string; verify?: boolean }) {
      if (!prepared) throw new Error("Prepare the Slack adapter before binding reports.");
      return prepared.bindThread(value, report);
    },
    async publish(report: Report) {
      if (!prepared || !service) throw new Error("Start the Slack adapter before publishing reports.");
      return prepared.publish(service, report);
    },
  };
}

export async function prepareSlack(root: string, runner: Runner, options: SlackOptions = {}) {
  const { namespace } = runner;
  const factory = options.config ? undefined : parse(await readFile(join(root, "factory.yaml"), "utf8"));
  const config = options.config ?? (options.connection ? factory?.slack?.connections?.[options.connection] : factory?.slack) as SlackConfig | undefined;
  if (!config?.teamId || !config.channels || typeof config.channels !== "object" || Array.isArray(config.channels)
    || Object.values(config.channels).some(agent => typeof agent !== "string")
    || (config.threadReplies !== undefined && !["all", "started"].includes(config.threadReplies))
    || (config.peerBotUserIds !== undefined && (!Array.isArray(config.peerBotUserIds)
      || config.peerBotUserIds.some(id => typeof id !== "string" || !/^[UW][A-Z0-9]+$/.test(id))))) {
    throw new Error("Configure the Slack connection's teamId and channels in factory.yaml.");
  }
  let credentials = options.credentials;
  const encoded = process.env[config.credentialsEnv ?? "SLACK_CREDENTIALS_JSON"];
  if (!credentials && encoded) {
    try { credentials = JSON.parse(encoded); }
    catch { throw new Error("Slack credentials must be JSON containing botToken and appToken."); }
  }
  const botToken = process.env[config.botTokenEnv ?? "SLACK_BOT_TOKEN"] ?? credentials?.botToken;
  const appToken = process.env[config.appTokenEnv ?? "SLACK_APP_TOKEN"] ?? credentials?.appToken;
  if (!botToken || !appToken) throw new Error("Slack requires its bot and app tokens in the configured environment.");
  const SlackInbox = defineDoc<{ tasks: Record<string, number>; threads: Record<string, number> }>({
    kind: `${namespace}.slack-inbox`, version: 2, scope: "session", initial: () => ({ tasks: {}, threads: {} }),
    checkpointWhen: () => false,
    migrate: value => ({ tasks: value.tasks as Record<string, number>, threads: {} }),
  });
  const ThreadReplies = defineDoc<{ byKey: Record<string, boolean> }>({
    kind: `${namespace}.slack-thread-replies`, version: 1, scope: "session", initial: () => ({ byKey: {} }),
    checkpointWhen: () => false,
  });
  const ResponseOwner = defineDoc<{ run?: number; key?: string; runs?: Record<string, string> }>({
    kind: `${namespace}.slack-response-owner`, version: 1, scope: "conversation",
    history: "latest", fork: "initial",
    initial: () => ({}), checkpointWhen: () => false,
  });
  const channelAgent = (channel: string) => config.channels[channel] ?? config.channels["*"];

  const client = new WebClient(botToken, {
    retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
    maxRequestConcurrency: Infinity, timeout: 15_000,
  });
  const identity = await client.auth.test();
  if (identity.team_id !== config.teamId || !identity.user_id) throw new Error("Slack token does not belong to the configured workspace.");
  const statusDelivery = createStatusDelivery(namespace, client);
  const Commentary = defineDoc<{ turns: Record<string, { entry: number; lastTask: number | null; text: string }> }>({
    kind: `${namespace}.slack-commentary`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ turns: {} }), checkpointWhen: () => false,
  });
  const MessageOwners = defineDoc<Record<string, number>>({
    kind: `${namespace}.slack-message-owners`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({}), checkpointWhen: () => false,
  });
  const statuses = new Map<string, {
    pending: Promise<void>; active?: boolean; run?: number; previous?: SlackActivity;
    published?: string; renewAt: number; retryAt: number;
  }>();
  // Serialize only Slack's shared thread indicator, never native execution.
  // Read current state inside the queue: an older turn must not clear a newer one.
  const refreshStatus = async (input: SlackInput, runtime: Pick<TaskRuntime<unknown, unknown, null, object>,
    "signal" | "snapshot" | "conversationId" | "now" | "report" | "getTask" | "entry">, ctx: Context, force = false) => {
    const key = threadKey(config.teamId, input.channel, input.thread);
    let state = statuses.get(key);
    if (!state) {
      state = { pending: Promise.resolve(), renewAt: 0, retryAt: 0 };
      statuses.set(key, state);
    }
    const status = state;
    let idle = false;
    const pending = status.pending.then(async () => {
      if (runtime.signal.aborted) return;
      try {
        const live = await runtime.snapshot(LiveDoc, runtime.conversationId, ctx);
        const active = !!live?.run;
        // Keep the indicator through final delivery; its task clears it once.
        if (!active && !force) return;
        idle = !active;
        const run = live?.run?.inputs[0];
        if (run !== status.run) { status.run = run; status.previous = undefined; }
        const tool = active ? await currentToolActivity(live!, runtime, ctx, options.describeTool) : undefined;
        if (tool) status.previous = { ...tool.activity, subject: tool.activity.subject ?? status.previous?.subject };
        const label = active ? activityLabel(live!, tool?.running ? tool.activity : undefined, status.previous) : "";
        if (runtime.now() < status.retryAt) return;
        if (!force && active === status.active && label === status.published && runtime.now() < status.renewAt) return;
        await client.assistant.threads.setStatus({
          channel_id: input.channel, thread_ts: input.thread,
          status: active ? `is ${label[0]!.toLowerCase()}${label.slice(1)}…` : "",
          ...(active ? { loading_messages: [label] } : {}),
        });
        status.active = active;
        status.published = label;
        status.renewAt = runtime.now() + 45_000;
        status.retryAt = 0;
      } catch (error) {
        if (runtime.signal.aborted) return;
        status.retryAt = runtime.now() + retryDelay(error);
        runtime.report(new Error(`Slack working indicator unavailable: ${slackError(error) ?? "request failed"}; execution and delivery continue.`));
      }
    });
    status.pending = pending;
    await pending;
    if (status.pending === pending && idle && !status.retryAt) statuses.delete(key);
    return status.retryAt;
  };
  // Status I/O has its own native lifetime: a slow indicator must not hold the
  // content queue, and recovery must still clear it after delivery settles.
  const indicator = defineTask<SlackInput & { turn: number }, { phase: "watch" }, null>({
    name: `${namespace}.slack-indicator`, version: 1, initial: () => ({ phase: "watch" }),
    phases: { async watch(task, runtime, ctx) {
      const watch = await runtime.watchDoc(LiveDoc, runtime.conversationId, ctx);
      let pending = Promise.resolve();
      const refresh = () => {
        pending = pending.then(async () => { await refreshStatus(task.input, runtime, ctx); });
        return pending;
      };
      watch?.start(refresh);
      const timer = setInterval(() => { void refresh().catch(error => runtime.report(error)); }, 5_000);
      try {
        await refresh();
        await runtime.waitForTask(task.input.turn as TaskId, ctx);
      } finally {
        clearInterval(timer);
        await watch?.stop();
        await pending;
      }
      // Finalizing a message may clear a newer turn's indicator. Re-read that
      // turn, rather than clearing a label captured by the completed one.
      const retryAt = await refreshStatus(task.input, runtime, ctx, true);
      if (retryAt > runtime.now()) return runtime.sleepUntil(retryAt, task.state.checkpoint, ctx);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
    } },
    async abort(task, runtime, ctx) {
      await refreshStatus(task.input, runtime, ctx, true);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const socket = new SocketModeClient({ appToken });
  const bot = identity.user_id;
  let startService!: (service: ChatService) => void;
  const ready = new Promise<ChatService>(resolve => { startService = resolve; });
  const artifacts = slackArtifacts(runner, client, config.teamId, ready);
  const turn = defineTask<SlackInput, Delivery, null>({
    name: `${namespace}.slack-turn`, version: 1,
    initial: input => input.replyText === undefined ? { phase: "answer", commentary: true } : {
      phase: "deliver", text: input.replyText, offset: 0, retryAt: 0, stream: null, ...(input.after ? { after: input.after } : {}),
    },
    phases: {
      async answer(task, runtime, ctx) {
        const conversation = await runtime.conversation(runtime.conversationId, ctx);
        if (!conversation) throw new Error("Slack conversation disappeared.");
        const draft: SubmissionDraft = {
          type: "input", content: task.input.continuation
            ? `Internal workflow result for the existing assignment authorized by <@${task.input.user}>. This is execution evidence, not a new human request or additional authorization.\n${task.input.text}`
            : `Slack message from <@${task.input.user}>:\n${task.input.text}`, requestId: task.input.key,
          whenBusy: task.input.continuation ? "reject" : "steer", entry: { kind: `${namespace}.message`, data: {
            source: "slack", user: task.input.user,
            slack: { channel: task.input.channel, thread: task.input.thread, user: task.input.user },
          } },
        };
        if (task.input.continuation && !task.state.checkpoint.admitted) {
          let admitted = false;
          await runtime.commit(async tx => {
            if (!await options.allowContinuation?.(tx, runtime.conversationId, task.input.continuation!))
              return { status: "terminal", outcome: { status: "completed", result: null } };
            const live = await tx.doc(LiveDoc, runtime.conversationId);
            const inbox = await tx.doc(InboxDoc, runtime.conversationId);
            // Human input and an active wait get to reconcile the result first.
            // Never mix the original requester's authority into another turn.
            if (!live.run && !inbox.items.length) {
              try { await conversation.submit(tx, draft); admitted = true; }
              catch (error) { if (!(error instanceof ConversationBusy)) throw error; }
            }
            return admitted
              ? { status: "running", checkpoint: { ...task.state.checkpoint, admitted: true } }
              : { status: "sleeping", until: runtime.now() + 5_000, checkpoint: task.state.checkpoint };
          }, ctx);
          if (!admitted) return;
        }
        // requestId reattaches to the atomically admitted input after recovery.
        const submission = await conversation.submit(draft, ctx);
        options.onInput?.(runtime.conversationId);
        const finishRedundant = async () => {
          const redundant = await runtime.memo<string>("stream", ctx);
          if (redundant) {
            try { await client.chat.delete({ channel: task.input.channel, ts: redundant }); }
            catch (error) {
              if (slackError(error) !== "message_not_found") {
                runtime.signal.throwIfAborted();
                runtime.report(error instanceof Error ? error : new Error("Slack progress cleanup failed."));
                await runtime.sleepUntil(runtime.now() + retryDelay(error), task.state.checkpoint, ctx);
                return;
              }
            }
            await options.onStream?.({ key: task.input.key, ts: redundant, done: true });
          }
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
        };
        // A steering input is admitted before it joins LiveDoc's run. Wait for
        // placement so it shares that run's reply instead of claiming another.
        if ((await submission.status(ctx)).status === "queued") {
          await runtime.sleepUntil(runtime.now() + 1_000, task.state.checkpoint, ctx);
          return;
        }
        // Steering inputs belong to the same answer, not duplicate Slack replies.
        let ownsReply = false;
        await runtime.commit(async tx => {
          const live = await tx.doc(LiveDoc, runtime.conversationId);
          const owner = await tx.doc(ResponseOwner, runtime.conversationId);
          // Generation task IDs change at each tool boundary; the first admitted
          // input remains the answer's identity throughout in-run steering.
          const run = live.run?.inputs.includes(submission.id) ? live.run.inputs[0] : submission.id;
          owner.runs ??= {};
          if (owner.run && owner.key) owner.runs[owner.run] ??= owner.key;
          if (owner.runs[run] && owner.runs[run] !== task.input.key) return;
          owner.runs[run] = task.input.key; ownsReply = true;
        }, ctx);
        if (!ownsReply) {
          await finishRedundant();
          return;
        }
        if (!task.state.checkpoint.indicator) {
          await runtime.commit(async tx => ({ status: "running", checkpoint: {
            ...task.state.checkpoint,
            indicator: await tx.createTask(indicator, { ...task.input, turn: task.id },
              { ownership: { kind: "conversation" }, background: true }),
          } }), ctx);
        }
        // Inference starts independently of Slack's stream-creation request.
        // A saved timestamp lets recovery finalize the same visible message.
        const recoveredStream = await runtime.memo<string>("stream", ctx);
        let stream = recoveredStream;
        if (!stream) {
          try {
            const opened = await client.chat.startStream({
              channel: task.input.channel, thread_ts: task.input.thread,
              recipient_team_id: config.teamId, recipient_user_id: task.input.user,
              chunks: [{ type: "task_update", id: "answer", title: "Message received", status: "in_progress" }],
            });
            if (!opened.ts) throw new Error("Slack did not return a stream timestamp.");
            stream = await runtime.memo("stream", opened.ts, ctx);
            await options.onStream?.({ key: task.input.key, ts: stream });
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            runtime.report(new Error(`Slack streaming unavailable; final reply remains queued: ${slackError(error) ?? "request failed"}`));
          }
        }
        const watch = await runtime.watchDoc(LiveDoc, runtime.conversationId, ctx);
        let pending = Promise.resolve();
        let sent = "";
        let displayed = "";
        let retryAt = 0;
        let updatedAt = 0;
        let ordinary = !!recoveredStream;
        let closed = false;
        let missing = false;
        let previousActivity: SlackActivity | undefined;
        // Slack ends streams after ten minutes, regardless of appends. Tool work
        // uses an ordinary editable message; a slow first generation switches too.
        const openedAt = stream ? Number.parseFloat(stream) * 1000 : runtime.now();
        const publishCommentary = async () => {
          const receipt = await submission.status(ctx);
          if (receipt.type !== "input" || !receipt.entry) return;
          const saved = (await runtime.snapshot(Commentary, runtime.conversationId, ctx))?.turns[task.input.key];
          // Pre-upgrade turns already showed their earlier prose in the working
          // message. Begin at the current entry instead of flooding the thread.
          if (!saved && !task.state.checkpoint.commentary) {
            const latest = await runtime.entries({ order: "descending" }, 1, undefined, ctx);
            await runtime.commit(async tx => {
              (await tx.doc(Commentary, runtime.conversationId)).turns[task.input.key] ??=
                { entry: latest.items[0]?.id ?? receipt.entry!, lastTask: null, text: "" };
            }, ctx);
            return;
          }
          let cursor: Cursor | undefined;
          do {
            const page = await runtime.entries({ minEntryId: ((saved?.entry ?? receipt.entry) + 1) as EntryId,
              ...(receipt.status === "done" ? { maxEntryId: receipt.answer } : {}), order: "ascending" }, 100, cursor, ctx);
            await runtime.commit(async tx => {
              const { turns } = await tx.doc(Commentary, runtime.conversationId);
              const owners = await tx.doc(MessageOwners, runtime.conversationId);
              turns[task.input.key] ??= { entry: receipt.entry!, lastTask: null, text: "" };
              const state = turns[task.input.key]!;
              for (const entry of page.items) {
                if (entry.id <= state.entry) continue;
                state.entry = entry.id;
                if (!AssistantEntry.is(entry)) continue;
                const message = entry.model?.[0];
                const text = message?.role === "assistant" ? publicCommentary(message) : "";
                if (!text || text === state.text) continue;
                const key = `commentary:${entry.id}`;
                if (!owners[key]) owners[key] = await tx.createTask(turn, { ...task.input, key,
                    text, replyText: text, ...(state.lastTask ? { after: state.lastTask } : {}) },
                  { conversationId: runtime.conversationId, ownership: { kind: "conversation" }, background: true });
                state.lastTask = owners[key]!;
                state.text = text;
              }
            }, ctx);
            cursor = page.next;
          } while (cursor);
        };
        const append = async (live: Readonly<LiveState> | null) => {
          if (runtime.signal.aborted) return;
          const active = !!live?.run?.inputs.includes(submission.id);
          const allowed = !options.allowProgressText || await options.allowProgressText(runtime.conversationId, live?.run?.inputs ?? []);
          if (allowed) await publishCommentary();
          if (!active || !stream || missing) return;
          const raw = active && allowed ? live?.generation?.message?.content.flatMap(p => p.type === "text" ? [p.text] : []).join("\n") ?? "" : "";
          const progress = progressText(raw);
          const text = streamText(raw);
          ordinary ||= (active && !!live?.tools?.length) || runtime.now() >= openedAt + 8 * 60_000
            || (!!text && !text.startsWith(sent));
          if (runtime.now() < retryAt) return;
          try {
            if (ordinary) {
              if (!closed) {
                try {
                  await client.chat.stopStream({ channel: task.input.channel, ts: stream,
                    chunks: [{ type: "task_update", id: "answer", title: "Response started", status: "complete" }] });
                } catch (error) {
                  if (slackError(error) !== "message_not_in_streaming_state") throw error;
                }
                closed = true;
              }
              const tool = await currentToolActivity(live!, runtime, ctx, options.describeTool);
              if (tool) previousActivity = { ...tool.activity, subject: tool.activity.subject ?? previousActivity?.subject };
              const status = activityLabel(live!, tool?.running ? tool.activity : undefined, previousActivity);
              const seconds = Math.max(0, Math.floor((runtime.now() - openedAt) / 10_000) * 10);
              const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
              const label = `${status} · ${elapsed} elapsed`;
              const body = progress ? replyChunk(progress, 0) : "";
              const signature = `${label}\n${body}`;
              if (signature === displayed || runtime.now() < updatedAt + 2_000) return;
              await client.chat.update({ channel: task.input.channel, ts: stream,
                text: fallbackText(signature),
                blocks: [{ type: "context", elements: [{ type: "plain_text", text: label }] },
                  ...(body ? replyBlocks(body, progress) : [])],
                parse: "none", link_names: false,
              });
              displayed = signature;
              updatedAt = runtime.now();
            } else if (text && text !== sent && runtime.now() >= updatedAt + 2_000) {
              // The native watcher coalesces updates while this request runs.
              const delta = replyChunk(text, sent.length, 12_000, false);
              await client.chat.appendStream({
                channel: task.input.channel, ts: stream, chunks: [{ type: "markdown_text", text: delta }],
              });
              sent += delta;
              updatedAt = runtime.now();
            }
          } catch (error) {
            if (runtime.signal.aborted) return;
            retryAt = runtime.now() + retryDelay(error);
            ordinary = true;
            missing = slackError(error) === "message_not_found";
            runtime.report(new Error(`Slack progress update pending: ${slackError(error) ?? "request failed"}; final reply remains queued.`));
          }
        };
        const refresh = () => {
          pending = pending.then(async () => {
            if (!runtime.signal.aborted) await append(await runtime.snapshot(LiveDoc, runtime.conversationId, ctx) ?? null);
          });
          return pending;
        };
        await refresh();
        watch?.start(refresh);
        // Flush throttled partials while the model is silent. This observes the
        // saved run; it never starts or retries work.
        const timer = setInterval(() => { void refresh().catch(error => runtime.report(error)); }, 5_000);
        let receipt;
        try { receipt = await submission.wait(ctx); }
        finally {
          clearInterval(timer);
          await watch?.stop();
          await pending;
        }
        if (receipt.status === "done" && receipt.type === "input") {
          let ownsAnswer = false;
          await runtime.commit(async tx => {
            const owners = await tx.doc(MessageOwners, runtime.conversationId);
            const key = `answer:${receipt.answer}`;
            owners[key] ??= task.id;
            ownsAnswer = owners[key] === task.id;
          }, ctx);
          if (!ownsAnswer) { await finishRedundant(); return; }
        }
        let text = "The reply stopped before it completed. Please try again.";
        if (!options.allowProgressText || await options.allowProgressText(runtime.conversationId, [submission.id])) await publishCommentary();
        const commentary = (await runtime.snapshot(Commentary, runtime.conversationId, ctx))?.turns[task.input.key];
        if (receipt.status === "done" && receipt.type === "input") {
          const entry = await runtime.entry(AssistantEntry, receipt.answer, ctx);
          const message = entry?.model?.[0];
          if (message?.role === "assistant" && !["error", "aborted"].includes(message.stopReason)) text = publicAnswer(message);
          if (message?.role === "assistant" && message.stopReason === "toolUse"
            && publicCommentary(message).trim() && commentary?.lastTask) {
            const calls = new Set(message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []));
            const terminated = new Set<string>();
            let cursor: Cursor | undefined;
            do {
              const page = await runtime.entries({ minEntryId: (receipt.answer + 1) as EntryId, order: "ascending" }, 100, cursor, ctx);
              for (const result of page.items) {
                if (!ToolResultEntry.is(result) || !result.byTaskId) continue;
                const output = result.model?.[0];
                if (output?.role !== "toolResult" || output.isError || !calls.has(output.toolCallId)) continue;
                const tool = await runtime.getTask(result.byTaskId as TaskId<ToolTaskResult>, ctx);
                const input = tool?.input as ToolTaskInput | undefined;
                if (tool?.kind !== ToolTask.definition.name || !input || input.kind === "nested"
                  || input.assistant !== receipt.answer || input.callId !== output.toolCallId
                  || tool.state.status !== "terminal" || tool.state.outcome.status !== "completed") continue;
                const outcome = tool.state.outcome.result;
                if (outcome.kind !== "nested" && outcome.entryId === result.id && outcome.control?.terminate)
                  terminated.add(output.toolCallId);
              }
              cursor = page.next;
            } while (cursor && terminated.size < calls.size);
            // Native termination is intentional only when every call requested
            // it successfully. Preserve the ordered acknowledgement as the reply.
            if (calls.size && terminated.size === calls.size) {
              const delivered = await runtime.waitForTask(commentary.lastTask as TaskId, ctx);
              if (delivered.state.outcome.status === "completed") { await finishRedundant(); return; }
            }
          }
        }
        if (!text.trim()) {
          text = "The assistant ended without a final answer; completion has not been verified.";
        }
        // Keep the progress transcript, and put the final answer after it.
        if (commentary?.lastTask && stream) {
          try {
            try { await client.chat.stopStream({ channel: task.input.channel, ts: stream }); }
            catch (error) { if (slackError(error) !== "message_not_in_streaming_state") throw error; }
            await client.chat.update({ channel: task.input.channel, ts: stream, text: "Work finished. Final reply below.",
              blocks: replyBlocks("Work finished. Final reply below.") });
          } catch (error) { runtime.signal.throwIfAborted(); runtime.report(error); }
          await options.onStream?.({ key: task.input.key, ts: stream, done: true });
          stream = undefined;
        }
        const firstChunk = fallbackText(replyChunk(text, 0));
        // Only this uninterrupted stream has a known, successfully sent prefix.
        // Finish its first message while closing, before the canonical update.
        const streamTail = stream && !commentary?.lastTask && !ordinary && !closed && !missing && firstChunk.startsWith(sent)
          ? firstChunk.slice(sent.length) : "";
        await runtime.commit((_tx, current) => ({
          status: "running", checkpoint: { phase: "deliver", text, offset: 0, retryAt: 0, indicator: current.state.checkpoint.indicator!, stream: stream ?? null,
            ...(streamTail ? { streamTail } : {}),
            ...(commentary?.lastTask ? { after: commentary.lastTask } : {}) },
        }), ctx);
      },
      async deliver(task, runtime, ctx) {
        let checkpoint = task.state.checkpoint;
        if (checkpoint.after) await runtime.waitForTask(checkpoint.after as TaskId, ctx);
        if (checkpoint.retryAt > runtime.now()) {
          return runtime.sleepUntil(checkpoint.retryAt, checkpoint, ctx);
        }
        // Standalone replies and pre-upgrade delivery checkpoints also need a
        // recoverable indicator refresh after their content reaches Slack.
        if (!checkpoint.indicator) {
          await runtime.commit(async tx => {
            checkpoint = { ...checkpoint, indicator: await tx.createTask(indicator, { ...task.input, turn: task.id },
              { ownership: { kind: "conversation" }, background: true }) };
            return { status: "running", checkpoint };
          }, ctx);
        }
        // Slack can truncate oversized messages. Persist progress between chunks.
        const text = replyChunk(checkpoint.text, checkpoint.offset);
        const hash = createHash("sha256").update(`${task.input.key}:${checkpoint.offset}`).digest("hex");
        try {
          if (checkpoint.stream && checkpoint.offset === 0) {
            const stream = checkpoint.stream;
            const streamTail = checkpoint.streamTail;
            if (streamTail) {
              // A failed stop can have reached Slack. Consume the optional tail
              // before sending; recovery always has the full canonical update.
              const { streamTail: _tail, ...remaining } = checkpoint;
              checkpoint = remaining;
              await runtime.commit(() => ({ status: "running", checkpoint }), ctx);
            }
            try {
              await client.chat.stopStream({
                channel: task.input.channel, ts: stream,
                chunks: [
                  ...(streamTail ? [{ type: "markdown_text" as const, text: streamTail }] : []),
                  { type: "task_update", id: "answer", title: "Done", status: "complete" },
                ],
              });
            } catch (error) {
              if (slackError(error) !== "message_not_in_streaming_state") throw error;
            }
            // Replace partials with the committed answer, also after a restart
            // or model retry. Repeating this update does not duplicate text.
            await client.chat.update({
              channel: task.input.channel, ts: stream, text: fallbackText(text),
              blocks: replyBlocks(text, checkpoint.text, checkpoint.offset),
              metadata: { event_type: `${namespace}_agent_reply`, event_payload: { delivery: hash } },
              parse: "none", link_names: false,
            });
          } else {
            await client.chat.postMessage({
              channel: task.input.channel, thread_ts: task.input.thread, text: fallbackText(text),
              blocks: replyBlocks(text, checkpoint.text, checkpoint.offset),
              metadata: { event_type: `${namespace}_agent_reply`, event_payload: { delivery: hash } },
              unfurl_links: false, unfurl_media: false, mrkdwn: false, parse: "none",
            });
          }
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          if (checkpoint.stream && checkpoint.offset === 0 && slackError(error) === "message_not_found") {
            // A deleted stream cannot be repaired by retrying its timestamp.
            await runtime.commit(() => ({
              status: "running", checkpoint: { ...checkpoint, stream: null, retryAt: 0 },
            }), ctx);
            return;
          }
          runtime.report(new Error(`Slack delivery pending for ${task.input.key}: ${error instanceof Error ? error.message : "request failed"}`));
          await runtime.commit(() => ({
            status: "running", checkpoint: { ...checkpoint, retryAt: runtime.now() + retryDelay(error) },
          }), ctx);
          return;
        }
        const offset = checkpoint.offset + text.length;
        if (offset >= checkpoint.text.length && checkpoint.stream)
          await options.onStream?.({ key: task.input.key, ts: checkpoint.stream, done: true });
        await runtime.commit(() => offset >= checkpoint.text.length
          ? { status: "terminal", outcome: { status: "completed", result: null } }
          : { status: "running", checkpoint: { ...checkpoint, offset, retryAt: 0 } }, ctx);
      },
    },
    async abort(task, runtime, ctx) {
      const stream = await runtime.memo<string>("stream", ctx);
      if (stream) {
        await stopStreams(task.input, [stream]);
        await options.onStream?.({ key: task.input.key, ts: stream, done: true });
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const incoming = defineTask<Incoming, { phase: "admit"; retryAt: number }, null>({
    name: `${namespace}.slack-incoming`, version: 1,
    initial: () => ({ phase: "admit", retryAt: 0 }),
    phases: {
      async admit(task, runtime, ctx) {
        // Recovery can start before the host attaches its ChatService.
        const service = await awaitWithContext(ready, withAbortSignal(runtime.signal, ctx));
        const input = task.input;
        // Only an exact authenticated command is control, never quoted/retrieved prose.
        if (/^(?:\/?stop|cancel)[.!]?$/i.test(input.text.trim())) {
          if (options.threads) await options.threads.stop(input);
          else {
            const chat = await service.find(input.agent, threadKey(config.teamId, input.channel, input.thread));
            if (chat) await service.stop(chat.id);
            await stopStreams(input, []);
          }
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
          return;
        }
        if (input.previous !== null) await runtime.waitForTask(input.previous as TaskId<null>, ctx);
        const checkpoint = task.state.checkpoint;
        if (checkpoint.retryAt > runtime.now()) {
          return runtime.sleepUntil(checkpoint.retryAt, checkpoint, ctx);
        }
        if (options.threads) {
          try { await options.threads.receive(input); }
          catch (error) {
            if (runtime.signal.aborted) throw error;
            runtime.report(error);
            await runtime.commit(() => ({ status: "running",
              checkpoint: { phase: "admit", retryAt: runtime.now() + 1_000 } }), ctx);
            return;
          }
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
          return;
        }
        const host = service.host(input.agent);
        const key = threadKey(config.teamId, input.channel, input.thread);
        let existing = await service.find(input.agent, key);
        let ownThread = config.threadReplies === "started"
          ? (await host.harness.snapshot(ThreadReplies, ctx))?.byKey[key] : undefined;
        if (!input.threaded) ownThread = true;
        // Only our reports can create an unmentioned discussion in an unknown
        // thread. A preceding mention has now finished binding its conversation.
        if (!input.direct && !input.mentioned && !existing && input.parentUser !== null && input.parentUser !== bot) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
          return;
        }
        if (input.threaded && (!existing || (config.threadReplies === "started" && ownThread === undefined))) {
          let root;
          try {
            root = await client.conversations.replies({ channel: input.channel, ts: input.thread, limit: 1, include_all_metadata: true });
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            const code = slackError(error);
            const message = `Slack thread lookup failed for ${input.key}: ${code ?? "request failed"}`;
            runtime.report(new Error(message));
            await runtime.commit(() => code === "thread_not_found" || code === "message_not_found"
              ? { status: "terminal", outcome: { status: "failed", error: { message } } }
              : { status: "running", checkpoint: { phase: "admit", retryAt: runtime.now() + retryDelay(error) } }, ctx);
            return;
          }
          const first = root.messages?.find(message => message.ts === input.thread);
          ownThread = first?.user === bot || first?.text?.includes(`<@${bot}>`) === true;
          const metadata = first?.user === bot ? first.metadata : undefined;
          const payload = metadata?.event_payload as Record<string, unknown> | undefined;
          if (metadata?.event_type === `${namespace}_agent_report` && payload?.agent === input.agent && typeof payload.origin === "string") {
            const origin: unknown = JSON.parse(payload.origin);
            if (!origin || typeof origin !== "object" || Array.isArray(origin)) throw new Error("Invalid report origin.");
            existing = await service.create(input.agent, "slack", key,
              typeof payload.title === "string" ? payload.title : "Report discussion", origin as Report["origin"]);
          }
        }
        if (!input.direct && !input.mentioned && (!existing || (config.threadReplies === "started" && !ownThread))) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
          return;
        }
        const chat = existing ?? await service.create(input.agent, "slack", key, input.text, {
          slack: { teamId: config.teamId, channelId: input.channel, threadTs: input.thread },
        });
        const { conversation } = await service.resolve(chat.id);
        // Transfer admission to the turn and finish this task in one commit.
        await runtime.commit(async tx => {
          if (config.threadReplies === "started") (await tx.doc(ThreadReplies)).byKey[key] = ownThread ?? false;
          (await tx.doc(SlackInbox)).tasks[input.key] = await tx.createTask(turn, {
            key: input.key, text: input.text, channel: input.channel, thread: input.thread, user: input.user,
          }, { conversationId: conversation.id, ownership: { kind: "conversation" }, background: true });
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, ctx);
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const extension = defineExtension({ name: `${namespace}.slack`, tasks: [turn, indicator, incoming, artifacts.task, statusDelivery.task] });
  const queueReply: ReplySink = async (tx, conversationId, destination, text, key) => {
    await tx.createTask(turn, { ...destination, text, replyText: text, key }, {
      conversationId, ownership: { kind: "conversation" }, background: true,
    });
  };
  // The host supplies the original request identity; admission rechecks it
  // after any active turn or queued human input has finished.
  const queueContinuation = async (...[tx, conversationId, destination, text, key, request]: [...Parameters<ReplySink>, string]) => {
    await tx.createTask(turn, { ...destination, text, key, continuation: request }, {
      conversationId, ownership: { kind: "conversation" }, background: true,
    });
  };
  const bindThread = async (service: ChatService, report: Omit<Report, "text" | "key"> & { thread: string; verify?: boolean }) => {
    if (channelAgent(report.channel) !== report.agent) throw new Error("The report agent must match the configured channel route.");
    const existing = await service.find(report.agent, threadKey(config.teamId, report.channel, report.thread));
    if (report.verify && !existing) {
      while (true) {
        try {
          const result = await client.conversations.replies({ channel: report.channel, ts: report.thread, limit: 1 });
          if (!result.messages?.some(message => message.ts === report.thread && message.user === bot)) return null;
          break;
        } catch (error) {
          if (slackError(error) === "thread_not_found") return null;
          if (slackError(error) !== "ratelimited" && !(error as { retryAfter?: number })?.retryAfter) throw error;
          await delay(retryDelay(error));
        }
      }
    }
    return service.create(report.agent, "slack", threadKey(config.teamId, report.channel, report.thread), report.title ?? "Report discussion", report.origin);
  };
  async function stopStreams(input: Pick<SlackInput, "channel" | "thread">, streams: string[]) {
    await Promise.all(streams.map(async ts => {
      try { await client.chat.stopStream({ channel: input.channel, ts }); }
      catch (error) { if (!["message_not_in_streaming_state", "message_not_found"].includes(slackError(error) ?? "")) throw error; }
      try { await client.chat.update({ channel: input.channel, ts, text: "Stopped.", blocks: replyBlocks("Stopped.") }); }
      catch (error) { if (slackError(error) !== "message_not_found") throw error; }
    }));
    await client.assistant.threads.setStatus({ channel_id: input.channel, thread_ts: input.thread, status: "" });
  }
  async function receive(service: ChatService, input: SlackThreadInput) {
    if (input.team !== config!.teamId || channelAgent(input.channel) !== input.agent && config!.directMessagesAgent !== input.agent
      || config!.allowedUsers && !config!.allowedUsers.includes(input.user)) throw new Error("Unconfigured Slack thread input.");
    const host = service.host(input.agent);
    const key = threadKey(config!.teamId, input.channel, input.thread);
    const existing = await service.find(input.agent, key);
    await host.conversation.commit(async tx => {
      const inbox = await tx.doc(SlackInbox);
      const previous = inbox.threads[key] ?? null;
      if (!input.direct && !input.mentioned && !existing && previous === null && input.parentUser !== null && input.parentUser !== bot) return;
      if (inbox.tasks[input.key]) return;
      const id = await tx.createTask(incoming, { ...input, previous }, { ownership: { kind: "conversation" }, background: true });
      inbox.tasks[input.key] = id;
      inbox.threads[key] = id;
    }, context);
    host.harness.resume();
  }
  return {
    bindThread,
    stopStreams,
    receive: async (input: SlackThreadInput) => receive(await ready, input),
    async publish(service: ChatService, report: Report) {
      if (channelAgent(report.channel) !== report.agent) throw new Error("The report agent must match the configured channel route.");
      const hash = createHash("sha256").update(report.key).digest("hex");
      const message = {
        channel: report.channel, ...(report.thread ? { thread_ts: report.thread } : {}),
        client_msg_id: `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`,
        text: report.text, mrkdwn: true, parse: "none" as const, unfurl_links: false, unfurl_media: false,
        metadata: { event_type: `${namespace}_agent_report`, event_payload: { delivery: hash, agent: report.agent, origin: JSON.stringify(report.origin), title: report.title ?? "Report discussion" } },
      };
      const result = await client.chat.postMessage(message);
      if (!result.ts) throw new Error("Slack did not return a report receipt.");
      await bindThread(service, { ...report, thread: report.thread ?? result.ts });
      return result.ts;
    },
    extension,
    queueReply,
    queueContinuation,
    queueStatus: statusDelivery.queue,
    queueArtifact: artifacts.queue,
    connected: () => socket.websocket?.isActive() ?? false,
    async start(service: ChatService, listen = true) {
      for (const agent of [...Object.values(config.channels), ...(config.directMessagesAgent ? [config.directMessagesAgent] : [])]) service.host(agent);
      startService(service);
      if (!listen) return;
      socket.on("slack_event", async ({ body, ack }) => {
        try {
          const event = body.event;
          if (body.team_id !== config.teamId || !event || !["message", "app_mention"].includes(event.type)
            || (event.subtype !== undefined && event.subtype !== "thread_broadcast")
            || event.bot_id || !event.user || event.user === bot || !event.text
            || (config.allowedUsers && !config.allowedUsers.includes(event.user))) { await ack(); return; }
          const direct = event.channel_type === "im";
          const mentioned = event.type === "app_mention" || event.text.includes(`<@${bot}>`);
          if (!direct && !mentioned && !event.thread_ts) { await ack(); return; }
          if (!direct && !mentioned && config.peerBotUserIds?.some(id => event.text.includes(`<@${id}>`))) {
            await ack(); return;
          }
          const agent = direct ? config.directMessagesAgent : channelAgent(event.channel);
          if (!agent) { await ack(); return; }
          const thread = event.thread_ts ?? event.ts;
          const parentUser = event.parent_user_id ?? event.root?.user ?? null;
          const text = event.text.replaceAll(`<@${bot}>`, "").trim();
          if (!text) { await ack(); return; }
          // Dedup both Slack redelivery and app_mention/message copies.
          const eventKey = `slack:${body.team_id}:${event.channel}:${event.ts}`;
          // Mention/message copies can carry different credential metadata.
          // Hand off even on redelivery, without admitting a duplicate input.
          const actionToken = body.action_token ?? event.action_token;
          if (typeof actionToken === "string" && actionToken && options.onActionToken) {
            try {
              await options.onActionToken({ teamId: config.teamId, channelId: event.channel,
                threadTs: thread, userId: event.user, eventTs: event.ts, token: actionToken });
            } catch {
              throw new Error("Slack action-token handoff failed; the event remains unacknowledged.");
            }
          }
          await receive(service, {
            key: eventKey, text, channel: event.channel, thread, user: event.user, team: body.team_id, timestamp: event.ts,
            agent, direct, mentioned, threaded: Boolean(event.thread_ts), parentUser,
          });
          // Acknowledgement waits only for local storage, never a Slack API call.
          await ack();
        } catch (error) {
          console.error("Slack event was not acknowledged:", error instanceof Error ? error.message : String(error));
        }
      });
      socket.on("error", error => console.error("Slack connection:", error.message));
      await socket.start();
      console.log(`Slack connected: ${identity.team} / ${identity.user}; ${Object.keys(config.channels).length} channel route(s).`);
    },
    async close() { await socket.disconnect(); },
  };
}
