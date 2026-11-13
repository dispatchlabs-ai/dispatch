import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantEntry, LiveDoc, defineDoc, defineTask, type ConversationId, type EntryRecord, type EntryId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SlackWebApi } from "./api.js";
import { fallbackText, markdownText, replyBlocks, replyChunk, streamText, userBlocks } from "./text.js";

type Destination = { channel: string; thread: string; user: string };
type ResponseInput = Destination & { key: string; generation?: number; entry?: number; first: number; after?: number;
  text?: string; origin?: number; attribution?: string };
type ResponseFields = { stream: string | null; opening?: boolean; ordinary?: boolean;
  latest: string; text?: string; entry?: number; offset: number; retryAt: number };
type ResponseState = ({phase: "watch"} | {phase: "deliver"}) & ResponseFields;
type Options = {
  team: string;
  onStream?: (event: { key: string; ts: string; done?: boolean }) => void | Promise<void>;
  allowProgressText?: (id: number, inputs: readonly number[]) => boolean | Promise<boolean>;
};

/** Text blocks are public provider output; never include thinking or tool payloads. */
export const responseText = (message: AssistantMessage) => message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
export const completedResponse = (message: AssistantMessage) => !["error", "aborted", "pending", "deferred"].includes(message.stopReason);
export const deliveryHash = (key: string) => createHash("sha256").update(key).digest("hex");
export const slackCode = (error: unknown) => (error as { data?: { error?: string } })?.data?.error;
export const deliveryDelay = (error: unknown) => ((error as { retryAfter?: number })?.retryAfter ?? 30) * 1000;

/** Reconcile an uncertain post/start against its public response/chunk marker. */
export async function findDelivery(client: SlackWebApi, namespace: string, destination: Pick<Destination, "channel" | "thread">, hash: string) {
  let cursor: string | undefined;
  do {
    const page = await client.conversations.replies({ channel: destination.channel, ts: destination.thread,
      cursor, limit: 100, include_all_metadata: true });
    const found = page.messages?.find(message =>
      (message.metadata?.event_type === `${namespace}_agent_reply` && (message.metadata.event_payload as {delivery?: string})?.delivery === hash) ||
      message.blocks?.some(block => "block_id" in block && block.block_id === `response-${hash}`));
    if (found?.ts) return found.ts;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

/** One native task per public generation, not per run or selected final answer.
 * The generation's successful AssistantEntry joins its stream to committed history.
 * Native retry attempts may correct only that still-unfinished response. */
export function createResponseDelivery(namespace: string, client: SlackWebApi, options: Options) {
  const Queue = defineDoc<{ last: number | null; owners: Record<string, number> }>({
    kind: `${namespace}.slack-public-responses`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ last: null, owners: {} }), checkpointWhen: () => false,
  });
  const History = defineDoc<{ cursor: number; destination?: Destination }>({
    kind: `${namespace}.slack-history`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ cursor: 0 }), checkpointWhen: () => false,
  });
  const response = defineTask<ResponseInput, ResponseState, null>({
    name: `${namespace}.slack-public-response`, version: 1,
    initial: input => ({ phase: input.text === undefined ? "watch" : "deliver", stream: null, latest: "",
      ...(input.text === undefined ? {} : { text: input.text }), offset: 0, retryAt: 0 }),
    phases: {
      async watch(task, runtime, ctx) {
        if (task.input.after) await runtime.waitForTask(task.input.after as TaskId, ctx);
        let state: ResponseState = task.state.checkpoint;
        const save = async (next: ResponseState) => {
          state = next;
          await runtime.commit(() => ({ status: "running", checkpoint: state }), ctx);
        };
        if (state.retryAt > runtime.now()) return runtime.sleepUntil(state.retryAt, state, ctx);
        const hash = deliveryHash(`${runtime.conversationId}:${task.input.key}:0`);
        try {
          // startStream has no supported idempotency key. Record its intent first.
          // If the response was lost, find its block marker; never blindly start a second stream.
          if (state.opening) {
            const ts = await findDelivery(client, namespace, task.input, hash);
            if (!ts) {
              runtime.report(new Error("Slack stream creation is uncertain; waiting for its response marker. No duplicate stream was started."));
              return runtime.sleepUntil(runtime.now() + 30_000, state, ctx);
            }
            await save({ ...state, stream: ts, opening: false, ordinary: true });
          }
          if (state.stream) await options.onStream?.({ key: task.input.key, ts: state.stream });
          let updatedAt = 0;
          while (true) {
            runtime.signal.throwIfAborted();
            let entry: EntryRecord | undefined = task.input.entry ? await runtime.entry(AssistantEntry, task.input.entry as EntryId, ctx) : undefined;
            if (!entry && task.input.generation) {
              let cursor;
              do {
                const page = await runtime.entries({ minEntryId: (task.input.first + 1) as EntryId, order: "ascending" }, 100, cursor, ctx);
                entry = page.items.find(candidate => AssistantEntry.is(candidate) && candidate.byTaskId === task.input.generation &&
                  candidate.model?.[0]?.role === "assistant" && completedResponse(candidate.model[0]));
                cursor = page.next;
              } while (!entry && cursor);
            }
            if (entry?.model?.[0]?.role === "assistant") {
              await save({ ...state, phase: "deliver", text: responseText(entry.model[0]), entry: entry.id, retryAt: 0 });
              return;
            }
            const generation = task.input.generation ? await runtime.getTask(task.input.generation as TaskId, ctx) : undefined;
            if (generation?.state.status === "terminal" && generation.state.outcome.status === "completed") {
              // The generation can commit between the census and this task read.
              // Join its terminal entry rather than finalize an older partial.
              const entryId = (generation.state.outcome.result as {entryId?: number} | null)?.entryId;
              const completed = entryId ? await runtime.entry(AssistantEntry, entryId as EntryId, ctx) : undefined;
              const message = completed?.model?.[0];
              if (message?.role === "assistant" && completedResponse(message)) {
                await save({ ...state, phase: "deliver", text: responseText(message), entry: completed!.id, retryAt: 0 });
                return;
              }
            }
            if (!generation || generation.state.status === "terminal") {
              // A failed attempt is not a completed answer. Preserve anything already
              // made public, but do not invent an empty final response.
              if (state.latest) await save({ ...state, phase: "deliver", text: state.latest, retryAt: 0 });
              else await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
              return;
            }
            const live = await runtime.snapshot(LiveDoc, runtime.conversationId, ctx);
            const active = live?.run?.taskId === task.input.generation;
            const allowed = active && (!options.allowProgressText || await options.allowProgressText(runtime.conversationId, live!.run!.inputs));
            const raw = allowed && live?.generation?.message ? responseText(live.generation.message as AssistantMessage) : "";
            if (raw && runtime.now() >= updatedAt + 1_000) {
              // Stream the first Slack-sized part. The complete committed response
              // is split durably below; there is no whole-response length cutoff.
              const text = streamText(replyChunk(raw, 0));
              if (!state.stream) {
                await save({ ...state, opening: true, latest: raw });
                const opened = await client.chat.startStream({ channel: task.input.channel, thread_ts: task.input.thread,
                  recipient_team_id: options.team, recipient_user_id: task.input.user,
                  chunks: [{ type: "blocks", blocks: [{ type: "context", block_id: `response-${hash}`,
                    elements: [{ type: "plain_text", text: "Agent response" }] }] }, { type: "markdown_text", text }] });
                if (!opened.ts) throw new Error("Slack did not return a response timestamp.");
                await save({ ...state, stream: opened.ts, opening: false });
                await options.onStream?.({ key: task.input.key, ts: opened.ts });
              } else if (raw !== state.latest) {
                const previous = streamText(replyChunk(state.latest, 0));
                const ordinary = state.ordinary || !text.startsWith(previous) || runtime.now() >= Number.parseFloat(state.stream) * 1000 + 8 * 60_000;
                // After a restart or uncertain append, correct only this unfinished
                // response rather than replaying an unacknowledged text delta.
                await save({ ...state, ordinary: true });
                if (ordinary) {
                  try { await client.chat.stopStream({ channel: task.input.channel, ts: state.stream }); }
                  catch (error) { if (slackCode(error) !== "message_not_in_streaming_state") throw error; }
                  await client.chat.update({ channel: task.input.channel, ts: state.stream, text,
                    blocks: replyBlocks(replyChunk(raw, 0)), parse: "none", link_names: false });
                } else if (text.length > previous.length) {
                  await client.chat.appendStream({ channel: task.input.channel, ts: state.stream,
                    chunks: [{ type: "markdown_text", text: text.slice(previous.length) }] });
                }
                await save({ ...state, latest: raw, ordinary: !!ordinary });
              }
              updatedAt = runtime.now();
            }
            await delay(200, undefined, { signal: runtime.signal });
          }
        } catch (error) {
          runtime.signal.throwIfAborted();
          // These API errors definitely reject start; transport/internal failures do not.
          if (state.opening && ["ratelimited", "invalid_auth", "missing_scope", "invalid_arguments", "channel_not_found"].includes(slackCode(error) ?? ""))
            state = { ...state, opening: false };
          if (slackCode(error) === "message_not_found") state = { ...state, stream: null, ordinary: false };
          runtime.report(new Error(`Slack public response pending: ${slackCode(error) ?? "transport uncertain"}.`));
          await save({ ...state, ordinary: true, retryAt: runtime.now() + deliveryDelay(error) });
        }
      },
      async deliver(task, runtime, ctx) {
        if (task.input.after) await runtime.waitForTask(task.input.after as TaskId, ctx);
        let state: ResponseState = task.state.checkpoint;
        if (state.retryAt > runtime.now()) return runtime.sleepUntil(state.retryAt, state, ctx);
        const source = state.text ?? "";
        if (!source.trim()) {
          if (state.stream) {
            try { await client.chat.stopStream({ channel: task.input.channel, ts: state.stream }); }
            catch (error) { if (!["message_not_in_streaming_state", "message_not_found"].includes(slackCode(error) ?? "")) throw error; }
            await options.onStream?.({ key: task.input.key, ts: state.stream, done: true });
          }
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
          return;
        }
        // Reserve the quote prefix within Slack's 12,000-character Markdown budget.
        const text = replyChunk(source, state.offset, task.input.attribution ? Math.floor((12_000 - 2) / 5) : undefined);
        const hash = deliveryHash(`${task.input.origin ?? runtime.conversationId}:${task.input.key}:${state.offset}`);
        try {
          const payload = { channel: task.input.channel,
            text: fallbackText(task.input.attribution ? `${task.input.attribution}\n\n${text}` : text),
            blocks: task.input.attribution ? userBlocks(text, source, state.offset, task.input.attribution) : replyBlocks(text, source, state.offset),
            metadata: { event_type: `${namespace}_agent_reply`, event_payload: { delivery: hash } }, parse: "none" as const, link_names: false };
          if (task.input.text === undefined && !state.stream && state.offset === 0) {
            if (state.opening) {
              const ts = await findDelivery(client, namespace, task.input, hash);
              if (!ts) {
                runtime.report(new Error("Slack response creation is uncertain; waiting for its marker without reposting."));
                return runtime.sleepUntil(runtime.now() + 30_000, state, ctx);
              }
              state = { ...state, stream: ts, opening: false };
            } else {
              state = { ...state, opening: true };
              await runtime.commit(() => ({ status: "running", checkpoint: state }), ctx);
              const opened = await client.chat.startStream({ channel: task.input.channel, thread_ts: task.input.thread,
                recipient_team_id: options.team, recipient_user_id: task.input.user,
                chunks: [{ type: "blocks", blocks: [{ type: "context", block_id: `response-${hash}`,
                  elements: [{ type: "plain_text", text: "Agent response" }] }] },
                  { type: "markdown_text", text: markdownText(text) }] });
              if (!opened.ts) throw new Error("Slack did not return a response timestamp.");
              state = { ...state, stream: opened.ts, opening: false };
            }
            await runtime.commit(() => ({ status: "running", checkpoint: state }), ctx);
            await options.onStream?.({ key: task.input.key, ts: state.stream! });
          }
          if (state.stream && state.offset === 0) {
            try { await client.chat.stopStream({ channel: task.input.channel, ts: state.stream }); }
            catch (error) { if (slackCode(error) !== "message_not_in_streaming_state") throw error; }
            // The only canonical edit: finalize this response, never a later generation.
            await client.chat.update({ ...payload, ts: state.stream });
            await options.onStream?.({ key: task.input.key, ts: state.stream, done: true });
          } else if (!await findDelivery(client, namespace, task.input, hash)) {
            const posted = await client.chat.postMessage({ ...payload, thread_ts: task.input.thread,
              unfurl_links: false, unfurl_media: false, mrkdwn: false });
            if (!posted.ts) throw new Error("Slack did not return a response timestamp.");
          }
        } catch (error) {
          runtime.signal.throwIfAborted();
          if (state.opening && ["ratelimited", "invalid_auth", "missing_scope", "invalid_arguments", "channel_not_found"].includes(slackCode(error) ?? ""))
            state = { ...state, opening: false };
          if (state.stream && slackCode(error) === "message_not_found") state = { ...state, stream: null };
          runtime.report(new Error(`Slack public response delivery pending: ${slackCode(error) ?? "transport uncertain"}.`));
          await runtime.commit(() => ({ status: "running", checkpoint: { ...state, retryAt: runtime.now() + deliveryDelay(error) } }), ctx);
          return;
        }
        const offset = state.offset + text.length;
        await runtime.commit(() => offset >= source.length
          ? { status: "terminal", outcome: { status: "completed", result: null } }
          : { status: "running", checkpoint: { ...state, stream: null, offset, retryAt: 0 } }, ctx);
      },
    },
    async abort(task, runtime, ctx) {
      const state = task.state.checkpoint;
      const hash = deliveryHash(`${runtime.conversationId}:${task.input.key}:0`);
      const ts = state.stream ?? (state.opening ? await findDelivery(client, namespace, task.input, hash) : undefined);
      if (ts) {
        try { await client.chat.stopStream({ channel: task.input.channel, ts }); }
        catch (error) { if (!["message_not_in_streaming_state", "message_not_found"].includes(slackCode(error) ?? "")) throw error; }
        await options.onStream?.({ key: task.input.key, ts, done: true });
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  async function queue(tx: Tx, conversation: ConversationId, input: Omit<ResponseInput, "key">, owner = conversation) {
    const state = await tx.doc(Queue, conversation);
    const key = input.text !== undefined ? `input:${input.entry}` : input.generation ? `response:${input.generation}` : `entry:${input.entry}`;
    if (state.owners[key]) return state.owners[key];
    const task = await tx.createTask(response, { ...input, key, ...(input.text === undefined ? {} : { origin: conversation }),
      ...(state.last ? { after: state.last } : {}) },
      { conversationId: owner, ownership: { kind: "conversation" }, background: true });
    state.owners[key] = task;
    state.last = task;
    return task;
  }
  /** One ordered census for every client. The cursor and outbox admission commit
   * together; a restart catches up without changing already delivered responses. */
  async function queueHistory(tx: Tx, conversation: ConversationId, target: Pick<Destination, "channel" | "thread">,
    allowedUser: (user: string) => boolean, owner: ConversationId, stream?: { generation: number; first: number }) {
    const state = await tx.doc(History, conversation);
    // Read the page before creating tasks: native transactions reject table reads
    // after table writes. Each following page gets its own commit.
    const page = await tx.scanEntries({ conversationId: conversation, minEntryId: (state.cursor + 1) as EntryId, order: "ascending" }, 100);
    const queued = await tx.doc(Queue, conversation);
    for (const entry of page.items) {
      state.cursor = entry.id;
      const data = entry.data as { source?: string; actor?: string; text?: string;
        attachments?: { name: string }[]; slack?: Destination } | undefined;
      // Only Slack admission supplies this metadata. A common client's source
      // label is not enough to bind or impersonate a Slack participant.
      if (entry.kind === `${namespace}.message` && data?.source === "slack" && data.slack?.channel === target.channel
        && data.slack.thread === target.thread && allowedUser(data.slack.user)) state.destination = data.slack;
      const destination = state.destination;
      if (!destination || !allowedUser(destination.user)) continue;
      const message = entry.model?.[0];
      if (AssistantEntry.is(entry) && message?.role === "assistant" && completedResponse(message) && responseText(message).trim()) {
        await queue(tx, conversation, { ...destination, first: entry.id, entry: entry.id,
          ...(entry.byTaskId ? { generation: entry.byTaskId } : {}) });
      } else if (entry.kind === `${namespace}.message` && message?.role === "user" && data?.actor === "user" && data.source !== "slack") {
        const text = data.attachments?.length ? data.text ?? "" : typeof message.content === "string" ? message.content
          : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
        const label = data.source === "web" ? "Web" : data.source === "terminal" || data.source === "cli" ? "CLI" : "another client";
        const files = data.attachments?.length ? `\n\nAttachments: ${data.attachments.map(file => file.name).join(", ")}` : "";
        if (text || files) await queue(tx, conversation, { ...destination, first: entry.id, entry: entry.id,
          // Stop cancels inference, not delivery of a human message already saved.
          text: `${text}${files}`, attribution: `User · ${label}` }, owner);
      }
    }
    if (!page.next && stream && state.destination && allowedUser(state.destination.user))
      await queue(tx, conversation, { ...state.destination, ...stream });
    return { more: !!page.next, last: queued.last };
  }
  return { task: response, queueHistory };
}
