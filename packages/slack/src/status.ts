import { createHash } from "node:crypto";
import { defineDoc, defineTask, type TaskId } from "@earendil-works/pi-durable";
import type { ReplyDestination, ReplySink } from "@dispatch/runner";
import type { SlackWebApi } from "./api.js";
import { fallbackText, replyBlocks } from "./text.js";

/** A durable, coalescing editable status. Narrative replies use the normal outbox. */
export function createStatusDelivery(namespace: string, client: SlackWebApi) {
  const Statuses = defineDoc<{ slots: Record<string, {
    text: string; revision: number; task: number | null; ts: string | null;
  }> }>({
    kind: `${namespace}.slack-status`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ slots: {} }), checkpointWhen: () => false,
  });
  const delivery = defineTask<ReplyDestination & { key: string; revision: number; previous: number | null },
    { phase: "deliver"; retryAt: number }, null>({
    name: `${namespace}.slack-status`, version: 1,
    initial: () => ({ phase: "deliver", retryAt: 0 }),
    phases: { async deliver(task, runtime, context) {
      if (task.state.checkpoint.retryAt > runtime.now())
        return runtime.sleepUntil(task.state.checkpoint.retryAt, task.state.checkpoint, context);
      if (task.input.previous) await runtime.waitForTask(task.input.previous as TaskId, context);
      const status = (await runtime.snapshot(Statuses, runtime.conversationId, context))!.slots[task.input.key]!;
      if (status.revision !== task.input.revision) {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
        return;
      }
      let ts = status.ts;
      try {
        const hash = createHash("sha256").update(`${runtime.conversationId}:${task.input.key}`).digest("hex");
        // Recover an uncertain initial post before retrying it. Once retained,
        // every heartbeat edits the same message, including after restart.
        if (!ts) {
          let cursor: string | undefined;
          do {
            const page = await client.conversations.replies({ channel: task.input.channel, ts: task.input.thread,
              cursor, limit: 100, include_all_metadata: true });
            ts = page.messages?.find(message => message.metadata?.event_type === `${namespace}_agent_status`
              && (message.metadata.event_payload as { key?: string } | undefined)?.key === hash)?.ts ?? null;
            cursor = page.response_metadata?.next_cursor || undefined;
          } while (!ts && cursor);
        }
        const payload = { channel: task.input.channel, text: fallbackText(status.text), blocks: replyBlocks(status.text),
          parse: "none" as const, link_names: false };
        if (ts) await client.chat.update({ ...payload, ts });
        else {
          const posted = await client.chat.postMessage({ ...payload, thread_ts: task.input.thread,
            metadata: { event_type: `${namespace}_agent_status`, event_payload: { key: hash } },
            unfurl_links: false, unfurl_media: false, mrkdwn: false });
          if (!posted.ts) throw new Error("Slack did not return a status timestamp.");
          ts = posted.ts;
        }
      } catch (error) {
        runtime.signal.throwIfAborted();
        const code = (error as { data?: { error?: string } }).data?.error;
        const retry = (error as { retryAfter?: number }).retryAfter;
        runtime.report(new Error(`Slack status update pending: ${code ?? "request failed"}.`));
        await runtime.commit(async tx => {
          if (code === "message_not_found") (await tx.doc(Statuses, runtime.conversationId)).slots[task.input.key]!.ts = null;
          return { status: "running", checkpoint: { phase: "deliver", retryAt: runtime.now() + (retry ? retry * 1000 : 30_000) } };
        }, context);
        return;
      }
      await runtime.commit(async tx => {
        (await tx.doc(Statuses, runtime.conversationId)).slots[task.input.key]!.ts = ts;
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    } },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  const queue: ReplySink = async (tx, conversationId, destination, text, key) => {
    const { slots } = await tx.doc(Statuses, conversationId);
    const previous = slots[key];
    if (previous?.text === text) return;
    const revision = (previous?.revision ?? 0) + 1;
    const task = await tx.createTask(delivery, { ...destination, key, revision, previous: previous?.task ?? null },
      { conversationId, ownership: { kind: "conversation" }, background: true });
    slots[key] = { text, revision, task, ts: previous?.ts ?? null };
  };
  return { task: delivery, queue };
}
