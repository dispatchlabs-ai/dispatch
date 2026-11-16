import { createHash } from "node:crypto";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantEntry, defineDoc, defineExtension, defineTask, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { context, publicAnswer, type Adapter, type ChatService, type ReplyDestination, type Runner } from "@dispatch/runner";
import { matchesPart, MessagesRpc, RpcError, scan, type Chat, type Message, type RpcCommand } from "./rpc.js";
import { stageTable } from "./attachments.js";
import { messageParts, type MessagePart } from "./text.js";

export type ImsgOptions = RpcCommand & {
  connection: string;
  agent: string;
  /** Exact Messages handles. Every remote member of a group must be included. */
  allowedHandles?: string[] | "users";
};

type Destination = ReplyDestination & { chatId: number };
type Delivery = { destination: Destination; key: string; text: string; previous?: number };
type SendState = { phase: "deliver"; parts?: MessagePart[]; index?: number; since?: number; attemptedAt?: number; sentText?: string };
const aborted = { status: "terminal", outcome: { status: "aborted" } } as const;
const done = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const failed = (message: string) => ({ status: "terminal", outcome: { status: "failed", error: { message } } }) as const;
const retryMs = 5_000;

export function createAdapter(options: ImsgOptions): Adapter {
  if (!options.connection?.trim() || !options.agent?.trim() ||
      (options.allowedHandles !== undefined && options.allowedHandles !== "users" && (!Array.isArray(options.allowedHandles) ||
        options.allowedHandles.some(handle => typeof handle !== "string" || !handle.trim()))) ||
      (options.command !== undefined && !options.command.trim()) ||
      (options.args !== undefined && (!Array.isArray(options.args) || options.args.some(arg => typeof arg !== "string"))))
    throw new Error("Invalid imsg connection, agent, allowed handles or RPC command.");
  return { prepare: async ({ runner }) => prepare(runner, options) };
}

function prepare(runner: Runner, options: ImsgOptions) {
  const { connection, agent } = options;
  const name = `${runner.namespace}.imsg.${createHash("sha256").update(connection).digest("hex")}`;
  const handles = Array.isArray(options.allowedHandles) ? new Set(options.allowedHandles.map(handle => handle.trim().toLowerCase())) : undefined;
  const identity = (handle: string) => ({ channel: "imsg", handle });
  const allowed = (handle: string) => !!handle && (!handles || handles.has(handle.toLowerCase())) &&
    (!service.users || !!service.users.find(identity(handle), agent));
  const membersAllowed = (chat: Chat) => (!handles && !service.users) || (chat.participants.length > 0 && chat.participants.every(allowed));
  const Inbox = defineDoc<{ cursor?: number; seen: Record<string, boolean> }>({
    kind: name + ".inbox", version: 1, scope: "session", initial: () => ({ seen: {} as Record<string, boolean> }),
    checkpointWhen: () => false,
  });
  const Thread = defineDoc<{ destination?: Destination; lastDelivery?: number; deliveries: Record<string, number>; receipts: Record<string, string> }>({
    kind: name + ".thread", version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ deliveries: {}, receipts: {} }), checkpointWhen: () => false,
  });
  let service: ChatService;
  let active: MessagesRpc | undefined;
  let child: MessagesRpc | undefined;
  let intake: Promise<void> | undefined;
  const stop = new AbortController();
  const requireRoute = (destination: ReplyDestination) => {
    if (destination.transport !== "imsg" || destination.channel !== connection || !allowed(destination.user))
      throw new Error("Unconfigured Messages destination.");
  };
  const delivery = defineTask<Delivery, SendState, null>({
    name: name + ".send", version: 1, initial: () => ({ phase: "deliver" }),
    phases: { async deliver(task, runtime, ctx) {
      const { destination, text, key, previous } = task.input;
      if (previous !== undefined) await runtime.waitForTask(previous as TaskId, ctx);
      const state = task.state.checkpoint;
      const rpc = active;
      if (!rpc) { await runtime.sleepUntil(runtime.now() + retryMs, state, ctx); return; }
      requireRoute(destination);
      // In-flight sends from earlier versions have only the original text or sentText.
      const parts = state.parts ?? (state.since === undefined ? messageParts(text) : [{ text: state.sentText ?? text }]);
      const index = state.index ?? 0;
      const part = parts[index]!;
      const ready: SendState = { phase: "deliver", parts, index };
      const sent = async (guid: string) => runtime.commit(async tx => {
        if (index + 1 < parts.length) return { status: "running", checkpoint: { ...ready, index: index + 1 } } as const;
        (await tx.doc(Thread, runtime.conversationId)).receipts[key] = guid;
        return done;
      }, ctx);
      let attempted: SendState = state.since === undefined ? ready : state;
      let attachment: Awaited<ReturnType<typeof stageTable>> | undefined;
      try {
        if (state.since === undefined && "table" in part) {
          if (!rpc.stagesFiles && basename(options.command ?? "imsg") === "ssh") {
            await runtime.commit(() => failed("Install dispatch-imsg-rpc on the remote Messages Mac to deliver table images."), ctx);
            return;
          }
          attachment = await stageTable(rpc, part.table);
        }
        const chat = await rpc.call<Chat>("chats.get", { chat_id: destination.chatId });
        if (chat.guid !== destination.thread || !membersAllowed(chat)) {
          await runtime.commit(() => failed("Messages chat identity or membership changed. Review delivery."), ctx);
          return;
        }
        if (state.since !== undefined) {
          const matches: string[] = [];
          await scan(rpc, state.since, async page => {
            for (const row of page.messages)
              if (matchesPart(row, part)) matches.push(row.guid);
          }, chat.id, "table" in part);
          if (matches.length === 1) { await sent(matches[0]!); return; }
          if (!matches.length && runtime.now() - state.attemptedAt! < 60_000) {
            await runtime.sleepUntil(runtime.now() + retryMs, state, ctx); return;
          }
          await runtime.commit(() => failed("Messages delivery is uncertain. Inspect the original chat before resending."), ctx);
          return;
        }
        const cursor = (await runtime.snapshot(Inbox, ctx))?.cursor ?? 0;
        const since = await scan(rpc, cursor, async () => {}, chat.id);
        attempted = { ...ready, since, attemptedAt: runtime.now() };
        await runtime.commit(() => ({ status: "running", checkpoint: attempted }), ctx);
        try {
          const payload = "text" in part ? { text: part.text } : { file: attachment!.file };
          const receipt = await rpc.call<{ ok: boolean; guid?: string }>("send", { chat_guid: chat.guid, ...payload });
          if (receipt.ok && receipt.guid) await sent(receipt.guid);
        } catch (error) {
          runtime.signal.throwIfAborted();
          if (error instanceof RpcError && error.data?.retry_safe === true && error.data.disposition === "not_started")
            await runtime.sleepUntil(runtime.now() + retryMs, ready, ctx);
          else runtime.report(new Error("Messages send outcome unknown. Checking outgoing history."));
        }
      } catch (error) {
        runtime.signal.throwIfAborted();
        runtime.report(error);
        // A receipt commit can fail after send. Retain the persisted attempt marker.
        await runtime.sleepUntil(runtime.now() + retryMs, attempted, ctx);
      } finally {
        if (attachment) await attachment.release().catch(error => runtime.report(error));
      }
    } },
    async abort(_task, runtime, ctx) { await runtime.commit(() => aborted, ctx); },
  });
  async function enqueue(tx: Tx, id: ConversationId, destination: ReplyDestination, text: string, key: string) {
    requireRoute(destination);
    const thread = await tx.doc(Thread, id);
    const origin = thread.destination;
    if (!origin || origin.channel !== destination.channel || origin.thread !== destination.thread)
      throw new Error("Messages reply must target the originating chat.");
    const receiptKey = JSON.stringify([connection, key]);
    if (thread.deliveries[receiptKey] === undefined)
      thread.lastDelivery = thread.deliveries[receiptKey] = await tx.createTask(delivery, { destination: { ...origin, user: destination.user },
        text, key: receiptKey, ...(thread.lastDelivery ? { previous: thread.lastDelivery } : {}) },
        { conversationId: id, ownership: { kind: "conversation" }, background: true });
  }
  const answer = defineTask<{ chat: string; submission: number; destination: Destination }, { phase: "answer" }, null>({
    name: name + ".answer", version: 1, initial: () => ({ phase: "answer" }),
    phases: { async answer(task, runtime, ctx) {
      const receipt = await service.wait(task.input.chat, task.input.submission, runtime.signal);
      if (receipt.status !== "done" || receipt.type !== "input") {
        await runtime.commit(() => failed("Messages input ended without an answer."), ctx); return;
      }
      const entry = await runtime.entry(AssistantEntry, receipt.answer, ctx);
      const reply = entry?.model?.[0];
      const text = reply?.role === "assistant" && !["aborted", "error"].includes(reply.stopReason) && publicAnswer(reply).trim();
      await runtime.commit(async tx => {
        if (!text) return failed("The model ended without a text reply.");
        await enqueue(tx, runtime.conversationId, task.input.destination, text, `answer:${receipt.answer}`);
        return done;
      }, ctx);
    } },
    async abort(_task, runtime, ctx) { await runtime.commit(() => aborted, ctx); },
  });
  async function receive(rpc: MessagesRpc, row: Message) {
    if (row.is_from_me !== false || row.is_reaction || row.unsent_at || !row.guid || !row.text?.trim() || !allowed(row.sender)) return;
    const host = service.host(agent);
    const key = JSON.stringify([connection, row.guid]);
    if ((await host.harness.snapshot(Inbox, context))?.seen[key]) return;
    const chat = await rpc.call<Chat>("chats.get", { chat_id: row.chat_id });
    if (!chat.guid || (row.chat_guid && row.chat_guid !== chat.guid) || !membersAllowed(chat)) return;
    const destination: Destination = { transport: "imsg", channel: connection, thread: chat.guid, chatId: chat.id, user: row.sender };
    const conversationKey = JSON.stringify(["imsg", connection, chat.guid]);
    const record = await service.create(agent, "imsg", conversationKey, row.text, { imsg: { connection, chatGuid: chat.guid } });
    const { conversation } = await service.resolve(record.id);
    const draft = await service.prepareInput(record.id, `Messages text from ${row.sender}:\n${row.text}`, key, {
      source: "imsg", identity: identity(row.sender),
      ...(chat.is_group ? { audience: chat.participants.map(identity) } : {}),
      metadata: { destination, text: row.text, user: row.sender, messageGuid: row.guid, service: chat.service, group: chat.is_group },
    });
    await host.harness.commit(async tx => {
      const inbox = await tx.doc(Inbox);
      if (inbox.seen[key]) return;
      (await tx.doc(Thread, conversation.id)).destination = destination;
      const submission = await conversation.submit(tx, draft);
      await tx.createTask(answer, { chat: record.id, submission, destination },
        { conversationId: conversation.id, ownership: { kind: "conversation" }, background: true });
      inbox.seen[key] = true;
    }, context);
    host.harness.resume();
  }
  async function listen() {
    const host = service.host(agent);
    while (!stop.signal.aborted) {
      let wake = Promise.withResolvers<void>();
      const rpc = new MessagesRpc(options, () => wake.resolve());
      child = rpc;
      try {
        const status = await rpc.call<{ database: { ready: boolean }; methods: string[] }>("initialize", { protocol_version: 1 });
        if (!status.database?.ready || !["messages.after", "watch.subscribe", "chats.get", "send"].every(m => status.methods.includes(m)))
          throw new Error("imsg needs a readable Messages database and the protocol 1 replay, watch and send methods.");
        rpc.stagesFiles = ["dispatch.attachments.put", "dispatch.attachments.remove"].every(m => status.methods.includes(m));
        const checkpoint = await host.harness.snapshot(Inbox, context);
        let cursor = checkpoint?.cursor;
        const save = async (next: number) => host.harness.commit(async tx => { (await tx.doc(Inbox)).cursor = next; }, context);
        if (cursor === undefined) {
          cursor = await scan(rpc, 0, async () => {});
          await save(cursor);
        }
        await rpc.call("watch.subscribe");
        active = rpc;
        console.info(`Messages connection ${connection} ready.`);
        while (!stop.signal.aborted) {
          wake = Promise.withResolvers<void>();
          cursor = await scan(rpc, cursor, async page => {
            for (const row of page.messages) await receive(rpc, row);
            if (page.next_rowid !== cursor) await save(page.next_rowid);
          });
          if (!stop.signal.aborted) await wake.promise;
        }
      } catch (error) {
        if (!stop.signal.aborted) console.error("Messages connection:", error instanceof Error ? error.message : "intake failed");
      } finally { active = undefined; child = undefined; rpc.close(); }
      if (!stop.signal.aborted) await delay(retryMs, undefined, { signal: stop.signal }).catch(() => {});
    }
  }
  return {
    transport: "imsg", extension: defineExtension({ name, tasks: [answer, delivery] }), queueReply: enqueue,
    async start(host: ChatService) {
      if (options.allowedHandles === "users" && !host.users) throw new Error("Messages requires a configured usersFile.");
      service = host; service.host(agent); intake = listen();
    },
    async close() { stop.abort(); child?.close(); await intake; },
  };
}
