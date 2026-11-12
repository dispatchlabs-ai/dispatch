import {
  AssistantEntry, ToolResultEntry, UsageDoc,
  type ConversationId, type Cursor, type EntryRecord, type ModelRef, type SettledSubmissionRecord,
  type ToolExecutionApi, type ToolExecutionResult, type Tx,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

type ModelUsage = {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  estimatedCostUsd: number;
};

export type DelegationReceipt = {
  kind: "dispatch.delegation";
  version: 1;
  agent: string;
  fingerprint?: string;
  model?: ModelRef;
  thinking: string;
  conversationId: ConversationId;
  submissionId: number;
  outcome: "answered" | "unanswered";
  elapsedMs: number;
  recordedAt: string;
  scope: "child_subtree";
  models: Record<string, ModelUsage>;
  reportedToolCostUsd: number;
  estimatedCostUsd: number;
};

type ReceiptApi = Pick<ToolExecutionApi, "snapshot" | "now"> & {
  commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<unknown>;
};

/** Read native ledgers; returning these as tool usage would count the same spend twice. */
async function childUsage(api: ReceiptApi, child: ConversationId, context: Context) {
  const ids = [child];
  await api.commit(async tx => {
    for (const id of ids) {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({ ownerConversationId: id }, 100, cursor);
        ids.push(...page.items.map(item => item.id));
        cursor = page.next;
      } while (cursor);
    }
    return undefined;
  }, context);
  const states = await Promise.all(ids.map(id => api.snapshot(UsageDoc, id, context)));
  const models: Record<string, ModelUsage> = Object.create(null);
  let reportedToolCostUsd = 0;
  for (const state of states) {
    if (!state) continue;
    for (const [model, usage] of Object.entries(state.models)) {
      const total = models[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimatedCostUsd: 0 };
      total.input += usage.input;
      total.output += usage.output;
      total.cacheRead += usage.cacheRead;
      total.cacheWrite += usage.cacheWrite;
      total.estimatedCostUsd += usage.cost.total;
    }
    for (const usage of Object.values(state.tools)) reportedToolCostUsd += usage.cost.total;
  }
  return {
    models, reportedToolCostUsd,
    estimatedCostUsd: reportedToolCostUsd + Object.values(models).reduce((sum, model) => sum + model.estimatedCostUsd, 0),
  };
}

export async function delegationResult(api: ReceiptApi, child: ConversationId,
  submission: SettledSubmissionRecord, selection: {
    agent: string; fingerprint?: string; model?: ModelRef; thinking: string; startedAt: number;
  }, context: Context, cancelled = false): Promise<ToolExecutionResult> {
  let entry: EntryRecord | undefined;
  await api.commit(async tx => {
    entry = submission.status === "done" && submission.type === "input"
      ? await tx.entry(AssistantEntry, submission.answer) : undefined;
    return undefined;
  }, context);
  const answer = entry?.model?.[0];
  const answered = !cancelled && answer?.role === "assistant" && answer.stopReason !== "error" && answer.stopReason !== "aborted";
  const { startedAt, ...identity } = selection;
  const receipt: DelegationReceipt = {
    kind: "dispatch.delegation", version: 1, ...identity,
    conversationId: child, submissionId: submission.id,
    outcome: answered ? "answered" : "unanswered", elapsedMs: api.now() - startedAt,
    recordedAt: new Date(api.now()).toISOString(), scope: "child_subtree",
    ...await childUsage(api, child, context),
  };
  const text = answered ? answer.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    : cancelled ? "Delegate was cancelled. Remaining work was not completed."
    : `Delegate did not return a successful answer: ${submission.status}${submission.status === "unanswered" ? ` (${submission.reason})` : ""}.`;
  const { kind: _kind, version: _version, fingerprint: _fingerprint, ...feedback } = receipt;
  return {
    ...(answered ? {} : { isError: true }),
    output: [
      { type: "text", text: `Recorded delegation receipt (estimated cost; answer quality is unscored):\n${JSON.stringify(feedback)}` },
      { type: "text", text: text || "Delegate completed without a text response." },
    ],
    details: { agent: selection.agent, conversationId: child,
      ...(submission.status === "done" ? { answer: submission.answer } : {}), receipt },
  };
}

/** Reuse retained tool receipts, including those preceding compaction; no second ledger. */
export async function delegationReceipts(api: ToolExecutionApi, context: Context): Promise<DelegationReceipt[]> {
  return api.commit(async tx => {
    const receipts: DelegationReceipt[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId: api.conversationId, order: "ascending" }, 100, cursor);
      for (const entry of page.items) {
        if (!ToolResultEntry.is(entry)) continue;
        const message = entry.model?.[0];
        if (message?.role !== "toolResult" || !["delegate", "clone_agent", "wait_for_child"].includes(message.toolName)) continue;
        const receipt = (message.details as { receipt?: DelegationReceipt } | undefined)?.receipt;
        if (receipt?.kind === "dispatch.delegation" && receipt.version === 1) receipts.push(receipt);
      }
      cursor = page.next;
    } while (cursor);
    return [...new Map(receipts.map(receipt => [`${receipt.conversationId}:${receipt.submissionId}`, receipt])).values()];
  }, context);
}

export function observations(receipts: DelegationReceipt[], agent: string, fingerprint: string) {
  const samples = receipts.filter(receipt => receipt.agent === agent && receipt.fingerprint === fingerprint);
  return {
    samples: samples.length,
    answered: samples.filter(receipt => receipt.outcome === "answered").length,
    unanswered: samples.filter(receipt => receipt.outcome === "unanswered").length,
    estimatedCostUsd: samples.reduce((sum, receipt) => sum + receipt.estimatedCostUsd, 0),
    meanElapsedMs: samples.length ? Math.round(samples.reduce((sum, receipt) => sum + receipt.elapsedMs, 0) / samples.length) : null,
    quality: "unscored",
  };
}
