import { apply, type Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord";
import type {
  Activity,
  Connection,
  Conversation,
  Document,
  RawSnapshot,
  RecordData,
  Snapshot,
} from "../shared/contracts";
import { handoffLabels, instanceMessage } from "./context";

const secretKey =
  /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|authorization|cookie|private[-_]?key|connectionString)$/i;
export function redact(value: unknown): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKey.test(key) ||
        /^(?:thoughtSignature|thinkingSignature|encryptedContent)$/.test(key)
          ? "[redacted]"
          : key === "data" && (value as RecordData).type === "image"
            ? "[image bytes omitted]"
            : redact(item),
      ]),
    );
  if (typeof value !== "string") return value;
  return value
    .replace(/\b(?:sk-(?:proj-)?[\w-]{16,}|AKIA[A-Z0-9]{16})\b/g, "[redacted]")
    .replace(/(Bearer\s+)[\w.+/=-]+/gi, "$1[redacted]")
    .replace(
      /((?:postgres(?:ql)?|https?):\/\/)[^\s/@]+:[^\s/@]+@/gi,
      "$1[redacted]@",
    );
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) =>
        typeof part === "string"
          ? part
          : part?.type === "text"
            ? part.text
            : part?.type === "thinking"
              ? ""
              : part?.type === "image"
                ? "[retained image]"
                : "",
      )
      .filter(Boolean)
      .join("\n");
  return "";
}
const timestamp = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && Number.isFinite(Date.parse(value))
      ? Date.parse(value)
      : undefined;
export function project(raw: RawSnapshot, source: Connection): Snapshot {
  const safe = redact(raw) as RawSnapshot;
  const activities: Activity[] = [];
  const calls = new Map<string, Activity>();
  for (const { record: entry, sequence, inherited } of safe.entries) {
    const base = {
      entryId: entry.id,
      conversationId: entry.conversationId,
      sequence,
      kind: entry.kind,
      inherited,
      taskId: entry.byTaskId,
      record: entry,
    };
    let index = 0;
    for (const message of entry.model ?? []) {
      const sender =
        message.role === "user" ? instanceMessage(entry) : undefined;
      const messageText =
        sender && typeof entry.data?.text === "string"
          ? entry.data.text
          : text(message.content);
      if (message.role === "toolResult") {
        const key = `${entry.conversationId}:${message.toolCallId}`,
          call = calls.get(key);
        const truncated = Boolean(
          message.details?.truncated ||
          message.details?.truncation ||
          entry.data?.diagnostics?.some((item: RecordData) =>
            /truncat|omitted|dropped/i.test(`${item.code} ${item.message}`),
          ),
        );
        const result = {
          ...message,
          ...(entry.data?.diagnostics
            ? { diagnostics: entry.data.diagnostics }
            : {}),
        };
        const ending = {
          result,
          error: message.isError === true,
          durationMs: message.durationMs ?? message.details?.durationMs,
          missing: false,
          truncated,
        };
        if (call?.tool) Object.assign(call.tool, ending);
        calls.delete(key);
        activities.push({
          ...base,
          id: `entry:${entry.id}:${index++}`,
          category: "tool",
          title: message.toolName || "Tool result",
          text: messageText,
          at: timestamp(message.timestamp),
          tool: {
            callId: message.toolCallId,
            name: message.toolName ?? "Tool",
            phase: "result",
            arguments: call?.tool?.arguments,
            ...ending,
          },
        });
      } else {
        if (messageText)
          activities.push({
            ...base,
            id: `entry:${entry.id}:${index++}`,
            category: "message",
            role: message.role,
            sender,
            title:
              message.role === "user" ? "User message" : "Assistant response",
            text: messageText,
            at: timestamp(message.timestamp),
          });
        for (const call of Array.isArray(message.content)
          ? message.content
          : [])
          if (call.type === "toolCall") {
            const activity: Activity = {
              ...base,
              id: `entry:${entry.id}:${index++}`,
              category: "tool",
              title: call.name,
              text:
                typeof call.arguments?.command === "string"
                  ? call.arguments.command
                  : JSON.stringify(call.arguments ?? {}),
              at: timestamp(message.timestamp),
              tool: {
                callId: call.id,
                name: call.name,
                phase: "call",
                arguments: call.arguments,
                missing: true,
              },
            };
            calls.set(`${entry.conversationId}:${call.id}`, activity);
            activities.push(activity);
          }
      }
    }
    if (!index)
      activities.push({
        ...base,
        id: `entry:${entry.id}:0`,
        category:
          /compact|reset|context/.test(entry.kind) || entry.head
            ? "boundary"
            : "record",
        title: entry.kind,
        text:
          typeof entry.data === "string"
            ? entry.data
            : JSON.stringify(entry.data ?? entry.edits ?? {}),
        at: timestamp(entry.data?.timestamp),
      });
  }
  const documents: Document[] = safe.documents.map((doc) => {
    const base = doc.revisions.find((revision) => revision.kind === "base");
    const summary = {
      id: doc.record.id,
      kind: doc.record.kind,
      scope: doc.record.scope,
      history: doc.record.history,
    };
    if (!base)
      return {
        ...summary,
        unavailable: doc.record.retiredAt
          ? "Retired document; its contents were not retained."
          : "No retained base revision.",
      };
    try {
      let value = base.content as JsonValue,
        sequence = base.seq;
      for (const revision of doc.revisions)
        if (revision.seq > base.seq) {
          if (revision.kind !== "delta" || revision.version !== base.version)
            throw new Error("Unsupported revision boundary");
          value = apply(value, revision.content as Op[]);
          sequence = revision.seq;
        }
      return { ...summary, sequence, value: redact(value) };
    } catch {
      return {
        ...summary,
        unavailable:
          "This document's retained revisions cannot be reconstructed by this reader.",
      };
    }
  });
  const names = new Map<number, string>();
  const chats = new Map<
    number,
    Pick<Conversation, "agent" | "namespace" | "channel" | "createdAt">
  >();
  const live = documents
    .filter((doc) => doc.kind === "pi.live" && doc.value)
    .map((doc) => {
      const value = doc.value as RecordData;
      const scope = doc.scope as RecordData;
      return {
        conversationId: scope?.conversationId ?? scope?.id ?? 0,
        text: text(
          value.generation?.message?.content ??
            value.generation?.partial?.content ??
            value.generation?.partial,
        ),
        tools: [
          ...Object.values(value.tools ?? {}),
          ...Object.values(value.nestedTools ?? {}),
        ],
      };
    });
  for (const current of live)
    for (const slot of current.tools as RecordData[]) {
      const call = calls.get(`${current.conversationId}:${slot.callId}`);
      if (call?.tool) call.tool.live = slot;
    }
  for (const doc of documents) {
    const value = doc.value as RecordData | undefined;
    if (!value?.byId) continue;
    for (const chat of Object.values(value.byId) as RecordData[]) {
      if (typeof chat?.conversationId !== "number") continue;
      if (typeof (chat.title ?? chat.agent) === "string")
        names.set(chat.conversationId, chat.title ?? chat.agent);
      if (
        doc.kind.endsWith(".chats") &&
        typeof chat.agent === "string" &&
        chat.id === `${chat.agent}:${chat.conversationId}` &&
        typeof chat.source === "string"
      )
        chats.set(chat.conversationId, {
          agent: chat.agent,
          namespace: doc.kind.slice(0, -".chats".length),
          channel: chat.source,
          createdAt: timestamp(chat.createdAt),
        });
    }
  }
  for (const activity of activities) {
    const result = activity.tool?.result as RecordData | undefined;
    if (
      typeof result?.details?.conversationId === "number" &&
      typeof result.details.agent === "string"
    )
      names.set(result.details.conversationId, result.details.agent);
  }
  return {
    sequence: safe.sequence,
    observedAt: safe.observedAt,
    sourceId: source.id,
    storeId: source.kind === "postgres" ? source.postgres.storeId : undefined,
    conversations: safe.conversations.map((item) => {
      const last = item.latestEntry?.model?.at(-1);
      const responseEntry = item.latestResponseEntry;
      const response = responseEntry?.model?.findLast(
        (message: RecordData) =>
          message.role === "assistant" && text(message.content).trim(),
      );
      const first = item.firstEntry;
      const message = first?.model?.find(
        (message: RecordData) => message.role === "user",
      );
      const sender = message && first ? instanceMessage(first) : undefined;
      const openingText =
        sender && typeof first?.data?.text === "string"
          ? first.data.text
          : text(message?.content);
      const assignment = openingText.replace(/\s+/g, " ").trim();
      return {
        ...chats.get(item.record.id),
        id: item.record.id,
        title:
          names.get(item.record.id) ??
          (assignment
            ? assignment.slice(0, 110) + (assignment.length > 110 ? "…" : "")
            : `Conversation ${item.record.id}`),
        owner: item.record.owner,
        parent: item.record.parent,
        entryCount: item.entryCount,
        active: item.active,
        failed: item.failed,
        lastAt:
          timestamp(last?.timestamp) ??
          timestamp(item.latestEntry?.data?.timestamp),
        response:
          response && responseEntry
            ? {
                entryId: responseEntry.id,
                text: text(response.content),
                at: timestamp(response.timestamp),
              }
            : undefined,
        opening:
          first && openingText
            ? {
                entryId: first.id,
                text: openingText,
                at: timestamp(message?.timestamp),
                sender,
                labels:
                  sender?.kind === "message"
                    ? handoffLabels(openingText)
                    : undefined,
              }
            : undefined,
      };
    }),
    handoffs: (safe.handoffs ?? []).flatMap((entry) => {
      const sender = instanceMessage(entry);
      if (
        !sender ||
        sender.kind !== "message" ||
        typeof entry.data?.text !== "string"
      )
        return [];
      const message = entry.model?.find(
        (item: RecordData) => item.role === "user",
      );
      if (!message) return [];
      return [
        {
          conversationId: entry.conversationId,
          entryId: entry.id,
          text: entry.data.text,
          at: timestamp(message.timestamp),
          sender,
          labels: handoffLabels(entry.data.text),
        },
      ];
    }),
    activities,
    hasEarlier: safe.hasEarlier,
    earliestId: safe.entries[0]?.record.id,
    earliestSequence: safe.entries[0]?.sequence,
    tasks: safe.tasks.map((task) => ({
      id: task.id,
      conversationId: task.conversationId,
      owner: task.owner,
      kind: task.kind,
      status: task.state?.status ?? "unknown",
      outcome: task.state?.outcome?.status,
      startedAt: timestamp(task.startedAt),
      endedAt: timestamp(task.endedAt),
      phase: task.state?.checkpoint?.phase,
      attempt: task.state?.checkpoint?.attempt,
      waitingOn: task.state?.on ?? [],
      background: task.background === true,
      record: task,
    })),
    documents,
    live,
  };
}
