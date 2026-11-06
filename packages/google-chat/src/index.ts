import { setTimeout as delay } from "node:timers/promises";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import {
  AssistantEntry, ConversationBusy, InboxDoc, LiveDoc, defineDoc, defineExtension, defineTask,
  type ConversationId, type Cursor, type EntryId, type SubmissionDraft, type TaskId, type Tx,
} from "@earendil-works/pi-durable";
import { context, publicAnswer, publicCommentary, ThreadProcesses,
  type ChatService, type ReplyDestination, type ReplySink, type StatusSink, type Runner, type ThreadExecutor } from "@dispatch/runner";
import { GoogleApiError, GoogleChatApi, messageChunk, messageId, type GoogleCredentials } from "./api.js";
import { googleThreadKey, interaction, type GoogleChatConfig, type GoogleChatInput } from "./events.js";
export { GoogleChatApi, GoogleApiError, messageChunk, messageId } from "./api.js";
export { googleThreadKey, interaction } from "./events.js";
export type { GoogleCredentials, GoogleChatConfig, GoogleChatInput };

export class GoogleChatThreadProcesses extends ThreadProcesses<GoogleChatInput> {
  constructor(directory: string, launch: ThreadProcesses<GoogleChatInput>["launch"],
    stopped: ThreadProcesses<GoogleChatInput>["stopped"], execute?: ThreadExecutor<GoogleChatInput>) {
    super(directory, launch, stopped, googleThreadKey, (previous, input) => ({ ...input, agent: previous.agent }), execute);
  }
}
export type GoogleChatOptions = {
  config: GoogleChatConfig; credentials: GoogleCredentials;
  threads?: Pick<GoogleChatThreadProcesses, "receive" | "stop">;
  onInput?: (conversationId: number) => void;
  onStream?: (event: { key: string; ts: string; done?: boolean }) => void | Promise<void>;
  allowProgressText?: (conversationId: number, inputs: readonly number[]) => boolean | Promise<boolean>;
  allowContinuation?: (tx: Tx, conversationId: ConversationId, request: string) => Promise<boolean>;
};
type Turn = ReplyDestination & { key: string; text: string; replyText?: string; after?: number; continuation?: string };
type TurnState = { phase: "answer"; admitted?: boolean } | { phase: "deliver"; text: string; offset: number; retryAt: number; after?: number };
const complete = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const retryDelay = (error: unknown) => error instanceof GoogleApiError ? error.retryAfter : 30_000;

export function googleChat(options: GoogleChatOptions) {
  return { prepare: ({ runner }: { root: string; runner: Runner }) => prepareGoogleChat(runner, options) };
}

/** Pub/Sub admits events durably; native Pi tasks own execution and delivery. */
export async function prepareGoogleChat(runner: Runner, options: GoogleChatOptions) {
  const { namespace } = runner;
  const { config } = options;
  if (config.projectId !== options.credentials.project_id ||
      !config.subscription.startsWith(`projects/${config.projectId}/subscriptions/`) ||
      !Object.keys(config.spaces).length || Object.entries(config.spaces).some(([space, agent]) =>
        !/^spaces\/[A-Za-z0-9_-]+$/.test(space) || !agent)) throw new Error("Invalid Google Chat routing configuration.");
  const client = new GoogleChatApi(options.credentials);
  const destinationAllowed = (value: ReplyDestination) => {
    if (!config.spaces[value.channel] || !value.thread.startsWith(`${value.channel}/threads/`) ||
        !/^[A-Za-z0-9_-]+$/.test(value.thread.slice(`${value.channel}/threads/`.length)) ||
        !/^users\/\d+$/.test(value.user) || config.allowedUsers && !config.allowedUsers.includes(value.user))
      throw new Error("Unconfigured Google Chat destination.");
  };
  const Inbox = defineDoc<{ tasks: Record<string, number>; threads: Record<string, number>; stopped: Record<string, string> }>({
    kind: `${namespace}.google-chat-inbox`, version: 1, scope: "session",
    initial: () => ({ tasks: {}, threads: {}, stopped: {} }), checkpointWhen: () => false,
  });
  const Output = defineDoc<{
    runs: Record<string, string>; answers: Record<string, string>; deliveries: Record<string, number>;
    commentary: Record<string, { entry: number; after?: number }>;
  }>({ kind: `${namespace}.google-chat-output`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ runs: {}, answers: {}, deliveries: {}, commentary: {} }), checkpointWhen: () => false });
  const Statuses = defineDoc<{ slots: Record<string, { text: string; revision: number; task: number; finished: boolean; open: boolean }> }>({
    kind: `${namespace}.google-chat-status`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ slots: {} }), checkpointWhen: () => false,
  });
  let startService!: (service: ChatService) => void;
  const ready = new Promise<ChatService>(resolve => { startService = resolve; });
  const statusTask = defineTask<ReplyDestination & { key: string; revision: number; previous?: number },
    { phase: "deliver"; retryAt: number }, null>({
    name: `${namespace}.google-chat-status`, version: 1, initial: () => ({ phase: "deliver", retryAt: 0 }),
    phases: { async deliver(task, runtime, ctx) {
      if (task.state.checkpoint.retryAt > runtime.now()) return runtime.sleepUntil(task.state.checkpoint.retryAt, task.state.checkpoint, ctx);
      if (task.input.previous) await runtime.waitForTask(task.input.previous as TaskId, ctx);
      const slot = (await runtime.snapshot(Statuses, runtime.conversationId, ctx))!.slots[task.input.key]!;
      if (slot.revision !== task.input.revision) { await runtime.commit(() => complete, ctx); return; }
      try {
        const key = `${task.input.thread}:status:${task.input.key}`;
        const name = `${task.input.channel}/messages/${messageId(key)}`;
        if (!slot.finished) await options.onStream?.({ key, ts: name });
        await runtime.commit(async tx => { (await tx.doc(Statuses, runtime.conversationId)).slots[task.input.key]!.open = true; }, ctx);
        await client.message(task.input.channel, task.input.thread, messageChunk(slot.text, 0, task.input.thread), key, true, runtime.signal);
        if (slot.finished) await options.onStream?.({ key, ts: name, done: true });
      } catch (error) {
        runtime.signal.throwIfAborted(); runtime.report(error);
        await runtime.sleepUntil(runtime.now() + retryDelay(error), task.state.checkpoint, ctx); return;
      }
      await runtime.commit(async tx => {
        if (slot.finished) (await tx.doc(Statuses, runtime.conversationId)).slots[task.input.key]!.open = false;
        return complete;
      }, ctx);
    } },
    async abort(_task, runtime, ctx) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
  });
  async function setStatus(tx: Tx, conversationId: ConversationId, destination: ReplyDestination, text: string, key: string, finished = false) {
    destinationAllowed(destination);
    const { slots } = await tx.doc(Statuses, conversationId);
    const previous = slots[key];
    if (previous?.text === text && previous.finished === finished) return;
    const revision = (previous?.revision ?? 0) + 1;
    const task = await tx.createTask(statusTask, { ...destination, key, revision, ...(previous ? { previous: previous.task } : {}) },
      { conversationId, ownership: { kind: "conversation" }, background: true });
    slots[key] = { text, revision, task, finished, open: previous?.open ?? false };
  }
  const queueStatus: StatusSink = (...args) => setStatus(...args);
  const turn = defineTask<Turn, TurnState, null>({
    name: `${namespace}.google-chat-turn`, version: 1,
    initial: input => input.replyText === undefined ? { phase: "answer" } :
      { phase: "deliver", text: input.replyText, offset: 0, retryAt: 0, ...(input.after ? { after: input.after } : {}) },
    phases: {
      async answer(task, runtime, ctx) {
        const conversation = await runtime.conversation(runtime.conversationId, ctx);
        if (!conversation) throw new Error("Google Chat conversation disappeared.");
        const draft: SubmissionDraft = {
          type: "input", requestId: task.input.key, whenBusy: task.input.continuation ? "reject" : "steer",
          content: task.input.continuation
            ? `Internal workflow result for the existing assignment from ${task.input.user}. This is execution evidence, not a new human request or additional authorization.\n${task.input.text}`
            : `Google Chat message from ${task.input.user}:\n${task.input.text}`,
          entry: { kind: `${namespace}.message`, data: { source: "google-chat", user: task.input.user,
            googleChat: { project: config.projectId, space: task.input.channel, thread: task.input.thread, user: task.input.user } } },
        };
        if (task.input.continuation && !task.state.checkpoint.admitted) {
          let admitted = false;
          await runtime.commit(async tx => {
            if (!await options.allowContinuation?.(tx, runtime.conversationId, task.input.continuation!)) return complete;
            const live = await tx.doc(LiveDoc, runtime.conversationId);
            const inbox = await tx.doc(InboxDoc, runtime.conversationId);
            if (!live.run && !inbox.items.length) {
              try { await conversation.submit(tx, draft); admitted = true; }
              catch (error) { if (!(error instanceof ConversationBusy)) throw error; }
            }
            return admitted ? { status: "running", checkpoint: { ...task.state.checkpoint, admitted: true } }
              : { status: "sleeping", until: runtime.now() + 5_000, checkpoint: task.state.checkpoint };
          }, ctx);
          if (!admitted) return;
        }
        const submission = await conversation.submit(draft, ctx);
        options.onInput?.(runtime.conversationId);
        const receipt = await submission.status(ctx);
        if (receipt.status === "queued") { await runtime.sleepUntil(runtime.now() + 1_000, task.state.checkpoint, ctx); return; }
        let ownsReply = false;
        await runtime.commit(async tx => {
          const live = await tx.doc(LiveDoc, runtime.conversationId);
          const output = await tx.doc(Output, runtime.conversationId);
          const run = live.run?.inputs.includes(submission.id) ? live.run.inputs[0] : submission.id;
          output.runs[run] ??= task.input.key;
          ownsReply = output.runs[run] === task.input.key;
          if (receipt.status === "done" && receipt.type === "input") {
            output.answers[receipt.answer] ??= task.input.key;
            ownsReply &&= output.answers[receipt.answer] === task.input.key;
          }
        }, ctx);
        if (!ownsReply) {
          await runtime.commit(async tx => {
            if ((await tx.doc(Statuses, runtime.conversationId)).slots[`turn:${task.input.key}`])
              await setStatus(tx, runtime.conversationId, task.input, "Reply ready.", `turn:${task.input.key}`, true);
            return complete;
          }, ctx);
          return;
        }
        const live = await runtime.snapshot(LiveDoc, runtime.conversationId, ctx);
        const allowed = !options.allowProgressText || await options.allowProgressText(runtime.conversationId, live?.run?.inputs ?? [submission.id]);
        if (allowed && receipt.type === "input" && receipt.entry) {
          const saved = (await runtime.snapshot(Output, runtime.conversationId, ctx))?.commentary[task.input.key];
          let cursor: Cursor | undefined;
          do {
            const page = await runtime.entries({ minEntryId: ((saved?.entry ?? receipt.entry) + 1) as EntryId,
              ...(receipt.status === "done" ? { maxEntryId: receipt.answer } : {}), order: "ascending" }, 100, cursor, ctx);
            await runtime.commit(async tx => {
              const output = await tx.doc(Output, runtime.conversationId);
              const state = output.commentary[task.input.key] ??= { entry: receipt.entry! };
              for (const entry of page.items) {
                if (entry.id <= state.entry) continue;
                state.entry = entry.id;
                if (!AssistantEntry.is(entry)) continue;
                const message = entry.model?.[0];
                const text = message?.role === "assistant" ? publicCommentary(message) : "";
                if (!text) continue;
                state.after = await enqueue(tx, runtime.conversationId, { ...task.input, text, replyText: text,
                  key: `commentary:${entry.id}`, ...(state.after ? { after: state.after } : {}) });
              }
            }, ctx);
            cursor = page.next;
          } while (cursor);
        }
        if (receipt.status === "placed") {
          await runtime.commit(async tx => { await queueStatus(tx, runtime.conversationId, task.input, "Working…", `turn:${task.input.key}`); }, ctx);
          await runtime.sleepUntil(runtime.now() + 1_000, task.state.checkpoint, ctx); return;
        }
        let text = "The reply stopped before it completed. Please try again.";
        if (receipt.status === "done" && receipt.type === "input") {
          const entry = await runtime.entry(AssistantEntry, receipt.answer, ctx);
          const message = entry?.model?.[0];
          if (message?.role === "assistant" && !["error", "aborted"].includes(message.stopReason)) text = publicAnswer(message);
        }
        if (!text.trim()) text = "The assistant ended without a final answer; completion has not been verified.";
        await runtime.commit(async tx => {
          await setStatus(tx, runtime.conversationId, task.input, "Reply ready.", `turn:${task.input.key}`, true);
          const after = (await tx.doc(Output, runtime.conversationId)).commentary[task.input.key]?.after;
          return { status: "running", checkpoint: { phase: "deliver", text, offset: 0, retryAt: 0, ...(after ? { after } : {}) } };
        }, ctx);
      },
      async deliver(task, runtime, ctx) {
        const state = task.state.checkpoint;
        if (state.after) await runtime.waitForTask(state.after as TaskId, ctx);
        if (state.retryAt > runtime.now()) return runtime.sleepUntil(state.retryAt, state, ctx);
        const text = messageChunk(state.text, state.offset, task.input.thread);
        if (text) {
          try { await client.message(task.input.channel, task.input.thread, text, `${task.input.thread}:${task.input.key}:${state.offset}`, false, runtime.signal); }
          catch (error) { runtime.signal.throwIfAborted(); runtime.report(error); await runtime.sleepUntil(runtime.now() + retryDelay(error), state, ctx); return; }
        }
        const offset = state.offset + text.length;
        await runtime.commit(() => offset >= state.text.length ? complete :
          { status: "running", checkpoint: { ...state, offset } }, ctx);
      },
    },
    async abort(_task, runtime, ctx) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
  });
  async function enqueue(tx: Tx, conversationId: ConversationId, input: Turn) {
    destinationAllowed(input);
    const output = await tx.doc(Output, conversationId);
    return output.deliveries[input.key] ??= await tx.createTask(turn, input,
      { conversationId, ownership: { kind: "conversation" }, background: true });
  }
  const incoming = defineTask<GoogleChatInput & { previous: number | null }, { phase: "admit"; stopped?: boolean }, null>({
    name: `${namespace}.google-chat-incoming`, version: 1, initial: () => ({ phase: "admit" }),
    phases: { async admit(task, runtime, ctx) {
      const service = await awaitWithContext(ready, withAbortSignal(runtime.signal, ctx));
      const input = task.input;
      const key = googleThreadKey(input);
      if (/^(?:\/?stop|cancel)[.!]?$/i.test(input.text.trim())) {
        await runtime.commit(async tx => { const inbox = await tx.doc(Inbox); inbox.stopped[key] = [inbox.stopped[key] ?? "", input.timestamp].sort().at(-1)!; }, ctx);
        let checkpoint = task.state.checkpoint;
        try {
          if (!checkpoint.stopped && input.timestamp >= ((await runtime.snapshot(Inbox, ctx))?.stopped[key] ?? "")) {
            if (options.threads) await options.threads.stop(input);
            else {
              const chat = await service.find(input.agent, key);
              if (chat) {
                await service.stop(chat.id);
                const statuses = await service.host(input.agent).conversation.commit(async tx =>
                  (await tx.doc(Statuses, chat.conversationId as ConversationId)).slots, ctx);
                for (const [statusKey, slot] of Object.entries(statuses)) if (slot.open) {
                  await client.stopMessage(`${input.space}/messages/${messageId(`${input.thread}:status:${statusKey}`)}`, input.thread);
                  await service.host(input.agent).conversation.commit(async tx => {
                    (await tx.doc(Statuses, chat.conversationId as ConversationId)).slots[statusKey]!.open = false;
                  }, ctx);
                }
              }
            }
          }
          checkpoint = { ...checkpoint, stopped: true };
          await runtime.commit(() => ({ status: "running", checkpoint }), ctx);
          await client.message(input.space, input.thread, "Stopped.", `${input.key}:stopped`, false, runtime.signal);
        } catch (error) {
          runtime.signal.throwIfAborted(); runtime.report(error);
          await runtime.sleepUntil(runtime.now() + retryDelay(error), checkpoint, ctx); return;
        }
      } else {
        if (input.previous !== null) await runtime.waitForTask(input.previous as TaskId, ctx);
        if (input.timestamp <= ((await runtime.snapshot(Inbox, ctx))?.stopped[key] ?? "")) { await runtime.commit(() => complete, ctx); return; }
        if (options.threads) {
          try { await options.threads.receive(input); }
          catch (error) { runtime.signal.throwIfAborted(); runtime.report(error); await runtime.sleepUntil(runtime.now() + 1_000, task.state.checkpoint, ctx); return; }
        } else {
          const chat = await service.find(input.agent, key) ?? await service.create(input.agent, "google-chat", key, input.text,
            { googleChat: { project: input.project, space: input.space, thread: input.thread, admittedAt: input.timestamp } });
          await runtime.commit(async tx => { await enqueue(tx, chat.conversationId as ConversationId,
            { key: input.key, text: input.text, channel: input.space, thread: input.thread, user: input.user }); }, ctx);
        }
      }
      await runtime.commit(() => complete, ctx);
    } },
    async abort(_task, runtime, ctx) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
  });
  async function receive(input: GoogleChatInput) {
    destinationAllowed({ channel: input.space, thread: input.thread, user: input.user });
    if (input.transport !== "google-chat" || input.project !== config.projectId || config.spaces[input.space] !== input.agent)
      throw new Error("Unconfigured Google Chat input.");
    const service = await ready;
    const host = service.host(input.agent);
    await host.conversation.commit(async tx => {
      const inbox = await tx.doc(Inbox);
      if (inbox.tasks[input.key]) return;
      const key = googleThreadKey(input);
      const id = await tx.createTask(incoming, { ...input, previous: inbox.threads[key] ?? null },
        { ownership: { kind: "conversation" }, background: true });
      inbox.tasks[input.key] = id; inbox.threads[key] = id;
    }, context);
    host.harness.resume();
  }
  const controller = new AbortController();
  let polling: Promise<void> | undefined;
  let connected = false;
  async function pull() {
    const batch = await client.pull(config.subscription, controller.signal);
    // Inference runs independently. Only durable admission precedes acknowledgement.
    for (const item of batch.receivedMessages ?? []) {
      let input: GoogleChatInput | null = null;
      try { input = interaction(JSON.parse(Buffer.from(item.message.data, "base64").toString("utf8")), config); }
      catch { console.error(`Discarding malformed Google Chat event ${item.message.messageId}.`); }
      try {
        if (input) await receive(input);
        await client.acknowledge(config.subscription, [item.ackId], controller.signal);
      } catch (error) {
        controller.signal.throwIfAborted();
        // Leave this message unacknowledged for redelivery; other threads continue.
        console.error(`Google Chat event ${item.message.messageId} remains pending: ${error instanceof Error ? error.message : "admission failed"}`);
      }
    }
    connected = true;
  }
  return {
    extension: defineExtension({ name: `${namespace}.google-chat`, tasks: [incoming, turn, statusTask] }),
    receive, queueStatus,
    queueReply: (async (tx, id, destination, text, key) => { await enqueue(tx, id, { ...destination, text, replyText: text, key }); }) as ReplySink,
    async queueContinuation(...[tx, id, destination, text, key, request]: [...Parameters<ReplySink>, string]) {
      await enqueue(tx, id, { ...destination, text, key, continuation: request });
    },
    async stopStreams(input: GoogleChatInput, messages: string[]) { await Promise.all(messages.map(name => client.stopMessage(name, input.thread))); },
    connected: () => connected,
    async start(service: ChatService, listen = true) {
      for (const agent of Object.values(config.spaces)) service.host(agent);
      startService(service);
      if (!listen) return;
      await client.verify(config.subscription);
      await pull();
      polling = (async () => {
        while (!controller.signal.aborted) {
          try { await pull(); }
          catch (error) {
            connected = false;
            if (controller.signal.aborted) return;
            console.error(error instanceof Error ? error.message : "Google Chat intake failed.");
            await delay(retryDelay(error), undefined, { signal: controller.signal }).catch(() => {});
          }
        }
      })();
    },
    async close() { controller.abort(); await polling; connected = false; },
  };
}
