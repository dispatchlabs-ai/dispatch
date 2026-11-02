import type { AssistantMessage } from "@earendil-works/pi-ai";

function phase(signature?: string): unknown {
  if (signature?.startsWith("{")) {
    try { const value = JSON.parse(signature); if (value.v === 1) return value.phase; }
    catch { /* Other providers retain opaque text signatures. */ }
  }
}

/** Provider-designated public commentary, never thinking or tool contents. */
export function publicCommentary(message: AssistantMessage): string {
  if (["error", "aborted", "pending", "deferred"].includes(message.stopReason)) return "";
  return message.content.flatMap(part => {
    if (part.type !== "text") return [];
    const kind = phase(part.textSignature);
    return kind === "commentary" || (!kind && message.stopReason === "toolUse") ? [part.text] : [];
  }).join("\n").trim();
}

/** Completed answer text without repeating separately delivered commentary. */
export function publicAnswer(message: AssistantMessage): string {
  return message.content.flatMap(part => part.type === "text" && phase(part.textSignature) !== "commentary" ? [part.text] : []).join("\n");
}
