import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { awaitWithContext, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { ConversationBusy, InboxDoc, LiveDoc, defineDoc, defineExtension, defineTask, type ConversationId, type JsonObject, type LiveState, type TaskId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { context, prepareContent, type AttachmentFile, type ChatService, type Runner, type ReplySink } from "@dispatch/runner";
import { fallbackText, replyBlocks, replyChunk } from "./text.js";
import { slackArtifacts } from "./files.js";
import { createStatusDelivery } from "./status.js";
import { createResponseDelivery, findDelivery } from "./responses.js";
import { createHistorySync } from "./history.js";
import { activityLabel, currentToolActivity, type SlackActivity, type SlackToolDescription } from "./progress.js";
import type { SlackWebApi } from "./api.js";
export type { SlackActivity, SlackToolCall, SlackToolDescription } from "./progress.js";
export { createSlackWebApi, type SlackApiCall, type SlackApiMethod, type SlackWebApi } from "./api.js";
export { SlackThreadProcesses, type SlackThreadExecution, type SlackThreadExecutor, type ThreadLaunch } from "./threads.js";
export { runSlackHost, type SlackHostOptions } from "./host.js";

/** Trusted configuration, not a grant. The host enforces actual tool authority. */
export type SlackChannelProfile = {
  id: string; agent: string; instructions?: string; context?: JsonObject; capabilities?: string[];
};
export type SlackConfig = {
  teamId: string; channels: Record<string, string | SlackChannelProfile>; directMessagesAgent?: string;
  allowedUsers?: string[]; botTokenEnv?: string; appTokenEnv?: string; credentialsEnv?: string;
  displayName?: string;
  /** Ignore messages addressed to a peer bot unless this bot is also mentioned. */
  peerBotUserIds?: string[];
  /** With "started", require mentions inside threads started for another bot. */
  threadReplies?: "all" | "started";
};
type SlackInput = { files?: AttachmentFile[]; text: string; key: string; channel: string; thread: string; user: string; replyText?: string; after?: number; continuation?: string };
export type SlackThreadInput = SlackInput & {
  team: string; timestamp: string;
  agent: string; direct: boolean; mentioned: boolean; threaded: boolean;
  parentUser: string | null;
  /** Snapshot selected by trusted channel configuration at initial admission. */
  profile?: SlackChannelProfile;
};
/** Project an admitted thread's identity onto a worker's configured routes. */
export function slackThreadConfig(config: SlackConfig, thread: SlackThreadInput): SlackConfig {
  return { ...config, channels: { ...config.channels,
    ...(config.channels[thread.channel] || config.channels["*"]
      ? { [thread.channel]: thread.profile ?? thread.agent } : {}),
  }, ...(thread.channel.startsWith("D") && config.directMessagesAgent ? { directMessagesAgent: thread.agent } : {}) };
}
function validChannelRoute(route: unknown): route is string | SlackChannelProfile {
  if (typeof route === "string") return true;
  if (!route || typeof route !== "object" || Array.isArray(route)) return false;
  const value = route as SlackChannelProfile;
  return typeof value.id === "string" && !!value.id && typeof value.agent === "string" && !!value.agent
    && (value.instructions === undefined || typeof value.instructions === "string")
    && (value.context === undefined || !!value.context && typeof value.context === "object" && !Array.isArray(value.context))
    && (value.capabilities === undefined || Array.isArray(value.capabilities) && value.capabilities.every(name => typeof name === "string"));
}
type Incoming = SlackThreadInput & { previous: number | null };
type Delivery = { indicator?: number } & ({ phase: "answer"; admitted?: boolean; first?: number; cursor?: number; lastResponse?: number } | {
  phase: "deliver"; text: string; offset: number; retryAt: number; stream: string | null; after?: number;
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
  /** Trusted Web API relay for a thread worker; it cannot connect Socket Mode. */
  webApi?: SlackWebApi;
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
    || Object.values(config.channels).some(route => !validChannelRoute(route))
    || (config.threadReplies !== undefined && !["all", "started"].includes(config.threadReplies))
    || (config.peerBotUserIds !== undefined && (!Array.isArray(config.peerBotUserIds)
      || config.peerBotUserIds.some(id => typeof id !== "string" || !/^[UW][A-Z0-9]+$/.test(id))))) {
    throw new Error("Configure the Slack connection's teamId and channels in factory.yaml.");
  }
  let appToken: string | undefined;
  let configuredApi = options.webApi;
  if (!configuredApi) {
    let credentials = options.credentials;
    const encoded = process.env[config.credentialsEnv ?? "SLACK_CREDENTIALS_JSON"];
    if (!credentials && encoded) {
      try { credentials = JSON.parse(encoded); }
      catch { throw new Error("Slack credentials must be JSON containing botToken and appToken."); }
    }
    const botToken = process.env[config.botTokenEnv ?? "SLACK_BOT_TOKEN"] ?? credentials?.botToken;
    appToken = process.env[config.appTokenEnv ?? "SLACK_APP_TOKEN"] ?? credentials?.appToken;
    if (!botToken || !appToken) throw new Error("Slack requires its bot and app tokens in the configured environment.");
    configuredApi = new WebClient(botToken, {
      retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
      maxRequestConcurrency: Infinity, timeout: 15_000,
    });
  }
  const client = configuredApi;
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
  const channelRoute = (channel: string) => config.channels[channel] ?? config.channels["*"];
  const channelAgent = (channel: string) => {
    const route = channelRoute(channel);
    return typeof route === "string" ? route : route?.agent;
  };

  const identity = await client.auth.test();
  if (identity.team_id !== config.teamId || !identity.user_id) throw new Error("Slack token does not belong to the configured workspace.");
  const statusDelivery = createStatusDelivery(namespace, client);
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
  const socket = appToken ? new SocketModeClient({ appToken }) : undefined;
  const bot = identity.user_id;
  let startService!: (service: ChatService) => void;
  const ready = new Promise<ChatService>(resolve => { startService = resolve; });
  const artifacts = slackArtifacts(runner, client, config.teamId, ready);
  const responses = createResponseDelivery(namespace, client, { team: config.teamId, onStream: options.onStream,
    allowProgressText: options.allowProgressText });
  const allowedUser = (user: string) => !config.allowedUsers || config.allowedUsers.includes(user);
  const history = createHistorySync(runner, responses, { team: config.teamId, allowedUser,
    accepts: (channel, agent) => (channel.startsWith("D") ? config.directMessagesAgent : channelAgent(channel)) === agent,
    allowProgressText: options.allowProgressText });
  const turn = defineTask<SlackInput, Delivery, null>({
    name: `${namespace}.slack-turn`, version: 2,
    // Existing active v1 deliveries retain their old release; never reinterpret a
    // run-wide stream as a per-response checkpoint. Upgrade only at native idle.
    initial: input => input.replyText === undefined ? { phase: "answer" } : {
      phase: "deliver", text: input.replyText, offset: 0, retryAt: 0, stream: null, ...(input.after ? { after: input.after } : {}),
    },
    phases: {
      async answer(task, runtime, ctx) {
        const conversation = await runtime.conversation(runtime.conversationId, ctx);
        if (!conversation) throw new Error("Slack conversation disappeared.");
        const service = await ready;
        const chat = Object.values((await runtime.snapshot(runner.Chats, ctx))?.byId ?? {}).find(chat => chat.conversationId === runtime.conversationId);
        if (!chat) throw new Error("The channel conversation is not registered with its host.");
        const draft = await service.prepareInput(chat.id, task.input.continuation
            ? `Internal workflow result for the existing assignment authorized by <@${task.input.user}>. This is execution evidence, not a new human request or additional authorization.\n${task.input.text}`
            : `Slack message from <@${task.input.user}>:\n${task.input.text}`, task.input.key, {
          source: "slack", files: task.input.files, continuation: !!task.input.continuation,
          metadata: { user: task.input.user, text: task.input.text, slack: { channel: task.input.channel, thread: task.input.thread, user: task.input.user } },
        });
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
        // A steering input is admitted before it joins LiveDoc's run. Wait for
        // placement so it shares that run's reply instead of claiming another.
        if ((await submission.status(ctx)).status === "queued") {
          await runtime.sleepUntil(runtime.now() + 1_000, task.state.checkpoint, ctx);
          return;
        }
        // Steering inputs share one run observer, not one mutable public reply.
        let ownsReply = false;
        await runtime.commit(async tx => {
          const live = await tx.doc(LiveDoc, runtime.conversationId);
          const owner = await tx.doc(ResponseOwner, runtime.conversationId);
          // Generation task IDs change at each tool boundary; the first admitted
          // input remains the observer's identity throughout in-run steering.
          const run = live.run?.inputs.includes(submission.id) ? live.run.inputs[0] : submission.id;
          owner.runs ??= {};
          if (owner.run && owner.key) owner.runs[owner.run] ??= owner.key;
          if (owner.runs[run] && owner.runs[run] !== task.input.key) return;
          owner.runs[run] = task.input.key; ownsReply = true;
        }, ctx);
        if (!ownsReply) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
          return;
        }
        if (!task.state.checkpoint.indicator) {
          await runtime.commit(async tx => ({ status: "running", checkpoint: {
            ...task.state.checkpoint,
            indicator: await tx.createTask(indicator, { ...task.input, turn: task.id },
              { ownership: { kind: "conversation" }, background: true }),
          } }), ctx);
        }
        let checkpoint = task.state.checkpoint;
        const initial = await submission.status(ctx);
        if (initial.type !== "input" || !initial.entry) throw new Error("Placed Slack input has no native entry.");
        if (!checkpoint.first) {
          checkpoint = { ...checkpoint, first: initial.entry, cursor: initial.entry };
          await runtime.commit(() => ({ status: "running", checkpoint }), ctx);
        }
        // Enumerate committed responses as well as watching partials. A fast
        // provider can cross several tool/onYield boundaries between callbacks.
        while (true) {
          runtime.signal.throwIfAborted();
          const receipt = await submission.status(ctx);
          const live = await runtime.snapshot(LiveDoc, runtime.conversationId, ctx);
          const active = live?.run?.inputs.includes(submission.id);
          const allowed = !options.allowProgressText || await options.allowProgressText(runtime.conversationId, [submission.id]);
          let more: boolean;
          do {
            await runtime.commit(async tx => {
              const queued = await responses.queueHistory(tx, runtime.conversationId, task.input, allowedUser, service.host(chat.agent).conversation.id,
                active && allowed && live?.generation?.message ? { first: checkpoint.first!, generation: live.run!.taskId } : undefined);
              more = queued.more;
              if (queued.last) checkpoint = { ...checkpoint, lastResponse: Math.max(checkpoint.lastResponse ?? 0, queued.last) };
              return { status: "running", checkpoint };
            }, ctx);
          } while (more!);
          if (receipt.status === "done" || receipt.status === "unanswered") {
            if (checkpoint.lastResponse) await runtime.waitForTask(checkpoint.lastResponse as TaskId, ctx);
            // A tool-only successful termination is valid, not an empty-answer error.
            if (receipt.status === "unanswered" && receipt.reason !== "aborted") {
              await runtime.commit(() => ({ status: "running", checkpoint: { phase: "deliver",
                text: `The reply did not complete: ${receipt.reason}. Inspect the native receipt before retrying.`,
                offset: 0, retryAt: 0, stream: null, indicator: checkpoint.indicator,
                ...(checkpoint.lastResponse ? { after: checkpoint.lastResponse } : {}) } }), ctx);
            } else await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
            return;
          }
          await delay(200, undefined, { signal: runtime.signal });
        }
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
          if (!await findDelivery(client, namespace, task.input, hash)) {
            const posted = await client.chat.postMessage({
              channel: task.input.channel, thread_ts: task.input.thread, text: fallbackText(text),
              blocks: replyBlocks(text, checkpoint.text, checkpoint.offset),
              metadata: { event_type: `${namespace}_agent_reply`, event_payload: { delivery: hash } },
              unfurl_links: false, unfurl_media: false, mrkdwn: false, parse: "none",
            });
            if (!posted.ts) throw new Error("Slack did not return a reply timestamp.");
          }
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          runtime.report(new Error(`Slack delivery pending for ${task.input.key}: ${error instanceof Error ? error.message : "request failed"}`));
          await runtime.commit(() => ({
            status: "running", checkpoint: { ...checkpoint, retryAt: runtime.now() + retryDelay(error) },
          }), ctx);
          return;
        }
        const offset = checkpoint.offset + text.length;
        await runtime.commit(() => offset >= checkpoint.text.length
          ? { status: "terminal", outcome: { status: "completed", result: null } }
          : { status: "running", checkpoint: { ...checkpoint, offset, retryAt: 0 } }, ctx);
      },
    },
    async abort(_task, runtime, ctx) {
      // Response tasks close only their own unfinished stream. Completed responses
      // have no active stream receipt and are never rewritten/deleted by Stop.
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const incoming = defineTask<Incoming, { phase: "admit"; retryAt: number; cancelled?: boolean }, null>({
    name: `${namespace}.slack-incoming`, version: 1,
    initial: () => ({ phase: "admit", retryAt: 0 }),
    phases: {
      async admit(task, runtime, ctx) {
        // Recovery can start before the host attaches its ChatService.
        const service = await awaitWithContext(ready, withAbortSignal(runtime.signal, ctx));
        const input = task.input;
        // Only an exact authenticated command is control, never quoted/retrieved prose.
        if (/^(?:\/?stop|cancel)[.!]?$/i.test(input.text.trim())) {
          let checkpoint = task.state.checkpoint;
          try {
            if (!checkpoint.cancelled) {
              if (options.threads) await options.threads.stop(input);
              else {
                const chat = await service.find(input.agent, threadKey(config.teamId, input.channel, input.thread));
                if (chat) await service.stop(chat.id);
              }
              checkpoint = { ...checkpoint, cancelled: true };
              await runtime.commit(() => ({ status: "running", checkpoint }), ctx);
            }
            if (!options.threads) await stopStreams(input, []);
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
          } catch (error) {
            runtime.signal.throwIfAborted(); runtime.report(error);
            await runtime.sleepUntil(runtime.now() + retryDelay(error), checkpoint, ctx);
          }
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
          slack: { teamId: config.teamId, channelId: input.channel, threadTs: input.thread,
            ...(input.profile ? { profile: input.profile } : {}) },
        });
        const { conversation } = await service.resolve(chat.id);
        // Transfer admission to the turn and finish this task in one commit.
        await runtime.commit(async tx => {
          if (config.threadReplies === "started") (await tx.doc(ThreadReplies)).byKey[key] = ownThread ?? false;
          (await tx.doc(SlackInbox)).tasks[input.key] = await tx.createTask(turn, {
            key: input.key, text: input.text, ...(input.files ? {files: input.files} : {}), channel: input.channel, thread: input.thread, user: input.user,
          }, { conversationId: conversation.id, ownership: { kind: "conversation" }, background: true });
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, ctx);
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });

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
  const StopAcks = defineDoc<Record<string, number>>({
    kind: `${namespace}.slack-stop-acks`, version: 1, scope: "session",
    initial: () => ({}), checkpointWhen: () => false,
  });
  const stopAck = defineTask<{ channel: string; thread: string; key: string; streams: string[] },
    { phase: "acknowledge"; retryAt: number }, null>({
    name: `${namespace}.slack-stop-ack`, version: 1,
    initial: () => ({ phase: "acknowledge", retryAt: 0 }),
    phases: { async acknowledge(task, runtime, ctx) {
      if (task.state.checkpoint.retryAt > runtime.now())
        return runtime.sleepUntil(task.state.checkpoint.retryAt, task.state.checkpoint, ctx);
      try {
        await Promise.all(task.input.streams.map(async ts => {
          try { await client.chat.stopStream({ channel: task.input.channel, ts }); }
          catch (error) { if (!["message_not_in_streaming_state", "message_not_found"].includes(slackError(error) ?? "")) throw error; }
        }));
        if (task.input.key) {
          const hash = createHash("sha256").update(`stop:${task.input.channel}:${task.input.thread}:${task.input.key}`).digest("hex");
          if (!await findDelivery(client, namespace, task.input, hash)) await client.chat.postMessage({
            channel: task.input.channel, thread_ts: task.input.thread, text: "Stopped.", blocks: replyBlocks("Stopped."),
            metadata: { event_type: `${namespace}_agent_reply`, event_payload: { delivery: hash } },
            parse: "none", unfurl_links: false, unfurl_media: false,
          });
        }
        await client.assistant.threads.setStatus({ channel_id: task.input.channel, thread_ts: task.input.thread, status: "" });
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
      } catch (error) {
        runtime.signal.throwIfAborted(); runtime.report(error);
        await runtime.sleepUntil(runtime.now() + retryDelay(error), task.state.checkpoint, ctx);
      }
    } },
    async abort(_task, runtime, ctx) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  async function stopStreams(input: Pick<SlackInput, "channel" | "thread"> & { key?: string; agent?: string }, streams: string[]) {
    // Cancellation belongs to the caller/native supervisor. Only the presentation
    // task retries Slack I/O, never the cancelled conversation or its new inputs.
    const service = await ready;
    const agent = input.agent ?? channelAgent(input.channel) ?? config!.directMessagesAgent;
    if (!agent) throw new Error("No configured agent owns this Stop acknowledgement.");
    const host = service.host(agent);
    const key = input.key ?? `streams:${streams.join(",")}`;
    await host.conversation.commit(async tx => {
      const acks = await tx.doc(StopAcks);
      const id = `${input.channel}:${input.thread}:${key}`;
      acks[id] ??= await tx.createTask(stopAck, { channel: input.channel, thread: input.thread, key, streams },
        { ownership: { kind: "conversation" }, background: true });
    }, context);
    host.harness.resume();
  }
  const extension = defineExtension({ name: `${namespace}.slack`, tasks: [turn, responses.task, indicator, incoming, stopAck, artifacts.task, statusDelivery.task] });
  async function receive(service: ChatService, input: SlackThreadInput) {
    if (input.files?.length) prepareContent(input.text, input.files);
    if (input.team !== config!.teamId || channelAgent(input.channel) !== input.agent && config!.directMessagesAgent !== input.agent
      || config!.allowedUsers && !config!.allowedUsers.includes(input.user)) throw new Error("Unconfigured Slack thread input.");
    const route = input.direct ? undefined : channelRoute(input.channel);
    // Callers cannot replace trusted context or capability selection in a message.
    input = { ...input, profile: typeof route === "object" ? structuredClone(route) : undefined };
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
    transport: "slack",
    extension,
    queueReply,
    queueContinuation,
    queueStatus: statusDelivery.queue,
    queueArtifact: artifacts.queue,
    connected: () => socket?.websocket?.isActive() ?? false,
    async start(service: ChatService, listen = true) {
      if (listen && !socket) throw new Error("A Slack Web API relay must use start(service, false).");
      for (const route of [...Object.values(config.channels), ...(config.directMessagesAgent ? [config.directMessagesAgent] : [])])
        service.host(typeof route === "string" ? route : route.agent);
      startService(service);
      await history.start(service);
      if (!listen || !socket) return;
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
    async close() { await socket?.disconnect(); await history.close(); },
  };
}

export { slack as createAdapter };
