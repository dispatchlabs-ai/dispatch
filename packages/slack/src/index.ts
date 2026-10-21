import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { AssistantEntry, LiveDoc, defineDoc, defineExtension, defineTask, type LiveState } from "@earendil-works/pi-durable";
import { context, type ChatService, type Runner, type ReplySink } from "@dispatch/runner";
import { fallbackText, replyBlocks, replyChunk, streamText } from "./text.js";

export type SlackConfig = {
  teamId: string; channels: Record<string, string>; directMessagesAgent?: string;
  allowedUsers?: string[]; botTokenEnv?: string; appTokenEnv?: string; credentialsEnv?: string;
  displayName?: string;
};
type SlackInput = { text: string; key: string; channel: string; thread: string; user: string; replyText?: string };
type Delivery = { phase: "answer" } | {
  phase: "deliver"; text: string; offset: number; retryAt: number; stream: string | null;
};

function retryDelay(error: unknown) {
  const seconds = (error as { retryAfter?: number })?.retryAfter;
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : 30_000;
}

function slackError(error: unknown) {
  return (error as { data?: { error?: string } })?.data?.error;
}

export type Report = { agent: string; channel: string; thread?: string; text: string; key: string; origin: import("@earendil-works/pi-durable").JsonObject; title?: string };
export const threadKey = (team: string, channel: string, thread: string) => `slack:${team}:${channel}:${thread}`;

export function slack(options: { connection?: string; config?: SlackConfig; credentials?: { botToken: string; appToken: string } } = {}) {
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

export async function prepareSlack(root: string, runner: Runner, options: {
  connection?: string; config?: SlackConfig; credentials?: { botToken: string; appToken: string };
} = {}) {
  const { namespace } = runner;
  const factory = options.config ? undefined : parse(await readFile(join(root, "factory.yaml"), "utf8"));
  const config = options.config ?? (options.connection ? factory?.slack?.connections?.[options.connection] : factory?.slack) as SlackConfig | undefined;
  if (!config?.teamId || !config.channels || typeof config.channels !== "object" || Array.isArray(config.channels)
    || Object.values(config.channels).some(agent => typeof agent !== "string")) {
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
const SlackInbox = defineDoc<{ tasks: Record<string, number> }>({
  kind: `${namespace}.slack-inbox`, version: 1, scope: "session", initial: () => ({ tasks: {} }),
});

  const client = new WebClient(botToken, {
    retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
    maxRequestConcurrency: Infinity, timeout: 15_000,
  });
  const identity = await client.auth.test();
  if (identity.team_id !== config.teamId || !identity.user_id) throw new Error("Slack token does not belong to the configured workspace.");
  const socket = new SocketModeClient({ appToken });
  const bot = identity.user_id;
  const turn = defineTask<SlackInput, Delivery, null>({
    name: `${namespace}.slack-turn`, version: 1,
    initial: input => input.replyText === undefined ? { phase: "answer" } : {
      phase: "deliver", text: input.replyText, offset: 0, retryAt: 0, stream: null,
    },
    phases: {
      async answer(task, runtime, ctx) {
        const conversation = await runtime.conversation(runtime.conversationId, ctx);
        if (!conversation) throw new Error("Slack conversation disappeared.");
        const submission = await conversation.submit({
          type: "input", content: `Slack message from <@${task.input.user}>:\n${task.input.text}`, requestId: task.input.key,
          whenBusy: "followUp", entry: { kind: `${namespace}.message`, data: {
            source: "slack", user: task.input.user,
            slack: { channel: task.input.channel, thread: task.input.thread, user: task.input.user },
          } },
        }, ctx);
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
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            runtime.report(new Error(`Slack streaming unavailable; final reply remains queued: ${slackError(error) ?? "request failed"}`));
          }
        }
        const watch = stream && !recoveredStream
          ? await runtime.watchDoc(LiveDoc, runtime.conversationId, ctx) : undefined;
        let pending = Promise.resolve();
        let sent = "";
        let retryAt = 0;
        let streaming = true;
        const append = async (live: Readonly<LiveState> | null) => {
          if (!stream || !streaming || runtime.signal.aborted || !live?.run?.inputs.includes(submission.id)) return;
          const raw = live.generation?.message?.content.flatMap(p => p.type === "text" ? [p.text] : []).join("\n") ?? "";
          const text = streamText(raw);
          if (!text.startsWith(sent) || text === sent || runtime.now() < retryAt) return;
          // The native watcher coalesces updates while this request runs.
          const delta = replyChunk(text, sent.length, 12_000);
          try {
            await client.chat.appendStream({
              channel: task.input.channel, ts: stream, chunks: [{ type: "markdown_text", text: delta }],
            });
            sent += delta;
          } catch (error) {
            if (runtime.signal.aborted) return;
            retryAt = runtime.now() + retryDelay(error);
            if (!["ratelimited", undefined].includes(slackError(error))) streaming = false;
          }
        };
        if (watch) {
          pending = append(watch.value);
          await pending;
          watch.start(value => { pending = append(value); return pending; });
        }
        let receipt;
        try { receipt = await submission.wait(ctx); }
        finally {
          if (watch) await watch.stop();
          await pending;
        }
        let text = "The reply stopped before it completed. Please try again.";
        if (receipt.status === "done" && receipt.type === "input") {
          const entry = await runtime.entry(AssistantEntry, receipt.answer, ctx);
          const message = entry?.model?.[0];
          if (message?.role === "assistant") text = message.content.flatMap(p => p.type === "text" ? [p.text] : []).join("\n") || "(No text response.)";
        }
        await runtime.commit(() => ({
          status: "running", checkpoint: { phase: "deliver", text, offset: 0, retryAt: 0, stream: stream ?? null },
        }), ctx);
      },
      async deliver(task, runtime, ctx) {
        const checkpoint = task.state.checkpoint;
        await runtime.sleep(checkpoint.retryAt, ctx);
        // Slack can truncate oversized messages. Persist progress between chunks.
        const text = replyChunk(checkpoint.text, checkpoint.offset);
        const hash = createHash("sha256").update(`${task.input.key}:${checkpoint.offset}`).digest("hex");
        try {
          if (checkpoint.stream && checkpoint.offset === 0) {
            try {
              await client.chat.stopStream({
                channel: task.input.channel, ts: checkpoint.stream,
                chunks: [{ type: "task_update", id: "answer", title: "Done", status: "complete" }],
              });
            } catch (error) {
              if (slackError(error) !== "message_not_in_streaming_state") throw error;
            }
            // Replace partials with the committed answer, also after a restart
            // or model retry. Repeating this update does not duplicate text.
            await client.chat.update({
              channel: task.input.channel, ts: checkpoint.stream, text: fallbackText(text),
              blocks: replyBlocks(text),
              metadata: { event_type: `${namespace}_agent_reply`, event_payload: { delivery: hash } },
              parse: "none", link_names: false,
            });
          } else {
            await client.chat.postMessage({
              channel: task.input.channel, thread_ts: task.input.thread, text: fallbackText(text),
              blocks: replyBlocks(text),
              metadata: { event_type: `${namespace}_agent_reply`, event_payload: { delivery: hash } },
              unfurl_links: false, unfurl_media: false, mrkdwn: false, parse: "none",
            });
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
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const extension = defineExtension({ name: `${namespace}.slack`, tasks: [turn] });
  const queueReply: ReplySink = async (tx, conversationId, destination, text, key) => {
    await tx.createTask(turn, { ...destination, text, replyText: text, key }, {
      conversationId, ownership: { kind: "conversation" }, background: true,
    });
  };
  const bindThread = async (service: ChatService, report: Omit<Report, "text" | "key"> & { thread: string; verify?: boolean }) => {
    if (config.channels[report.channel] !== report.agent) throw new Error("The report agent must match the configured channel route.");
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
  return {
    bindThread,
    async publish(service: ChatService, report: Report) {
      if (config.channels[report.channel] !== report.agent) throw new Error("The report agent must match the configured channel route.");
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
    connected: () => socket.websocket?.isActive() ?? false,
    async start(service: ChatService) {
      for (const agent of [...Object.values(config.channels), ...(config.directMessagesAgent ? [config.directMessagesAgent] : [])]) service.host(agent);
      socket.on("slack_event", async ({ body, ack }) => {
        try {
          const event = body.event;
          if (body.team_id !== config.teamId || !event || !["message", "app_mention"].includes(event.type)
            || event.subtype || event.bot_id || !event.user || event.user === bot || !event.text
            || (config.allowedUsers && !config.allowedUsers.includes(event.user))) { await ack(); return; }
          const direct = event.channel_type === "im";
          const agent = direct ? config.directMessagesAgent : config.channels[event.channel];
          if (!agent) { await ack(); return; }
          const host = service.host(agent);
          const thread = event.thread_ts ?? event.ts;
          const key = threadKey(body.team_id, event.channel, thread);
          let existing = await service.find(agent, key);
          // A report may be visible before its post response and binding commit.
          // Reconcile that root from our own metadata before admitting a reply.
          if (!existing && event.thread_ts) {
            const root = await client.conversations.replies({ channel: event.channel, ts: thread, limit: 1, include_all_metadata: true });
            const message = root.messages?.find(message => message.ts === thread && message.user === bot);
            const metadata = message?.metadata;
            const payload = metadata?.event_payload as Record<string, unknown> | undefined;
            if (metadata?.event_type === `${namespace}_agent_report` && payload?.agent === agent && typeof payload.origin === "string") {
              const origin: unknown = JSON.parse(payload.origin);
              if (!origin || typeof origin !== "object" || Array.isArray(origin)) throw new Error("Invalid report origin.");
              existing = await service.create(agent, "slack", key,
                typeof payload.title === "string" ? payload.title : "Report discussion", origin as Report["origin"]);
            }
          }
          const mentioned = event.type === "app_mention" || event.text.includes(`<@${bot}>`);
          if (!direct && !mentioned && !existing) { await ack(); return; }
          const text = event.text.replaceAll(`<@${bot}>`, "").trim();
          if (!text) { await ack(); return; }
          const chat = await service.create(agent, "slack", key, text);
          const { conversation } = await service.resolve(chat.id);
          // Dedup both Slack redelivery and app_mention/message copies.
          const eventKey = `slack:${body.team_id}:${event.channel}:${event.ts}`;
          await conversation.commit(async tx => {
            const inbox = await tx.doc(SlackInbox);
            if (inbox.tasks[eventKey]) return;
            inbox.tasks[eventKey] = await tx.createTask(turn, {
              key: eventKey, text, channel: event.channel, thread, user: event.user,
            }, { ownership: { kind: "conversation" }, background: true });
          }, context);
          // Acknowledge only after native durable admission, before inference.
          await ack();
          host.harness.resume();
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
