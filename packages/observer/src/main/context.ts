import type {
  HandoffLabels,
  InstanceMessage,
  RecordData,
} from "../shared/contracts";

/** Runner's recorded envelope, not a sender inferred from message prose. */
export function instanceMessage(
  entry: RecordData,
): InstanceMessage | undefined {
  const data = entry.data;
  if (
    typeof entry.kind !== "string" ||
    !entry.kind.endsWith(".instance-message") ||
    !data ||
    typeof data.id !== "string" ||
    typeof data.from !== "string" ||
    typeof data.to !== "string"
  )
    return undefined;
  const reply = data.status === "answered" || data.status === "unanswered";
  if (!reply && data.status !== "received") return undefined;
  return {
    namespace: entry.kind.slice(0, -".instance-message".length),
    from: data.from,
    to: data.to,
    kind: reply ? "reply" : "message",
    // On a received assignment, reply=true asks for a future reply.
    replyRequested: data.status === "received" && data.reply === true,
  };
}

/** These are literal labels in a handoff, not native workflow/run identities. */
export function handoffLabels(text: string): HandoffLabels | undefined {
  const labels: HandoffLabels = {};
  for (const line of text.trimStart().split(/\r?\n/)) {
    const match = /^(workflow|cycle|assignment|phase):[ \t]*(\S.*)$/i.exec(
      line,
    );
    if (!match) break;
    const key = match[1].toLowerCase() as keyof typeof labels;
    if (labels[key]) return undefined;
    labels[key] = match[2].trim();
  }
  return Object.keys(labels).length ? labels : undefined;
}
