import type { ConversationMessage } from "../../src/shared/contracts.js";
import { fromMarkdown } from "mdast-util-from-markdown";

/** Rewrite only real inline links, preserving code, escaped literals and all other Markdown bytes. */
export function resolveAgentMentionLinks(text: string, participants: Map<string, string>) {
  const nodes = [...fromMarkdown(text).children];
  const changes: { start: number; end: number; text: string }[] = [];
  for (const node of nodes) {
    if ("children" in node) nodes.push(...node.children);
    if (node.type !== "link" || !node.url.startsWith("mention:")) continue;
    let target: string;
    try { target = decodeURIComponent(node.url.slice(8)); } catch { continue; }
    const participantId = participants.get(target);
    const start = node.position?.start.offset; const end = node.position?.end.offset;
    if (!participantId || start === undefined || end === undefined) continue;
    const token = text.slice(start, end);
    const match = /^\[(@(?:\\.|[^\]\\])*)\]\((mention:[^\s)]+)\)$/.exec(token);
    if (match) changes.push({ start, end, text: `[${match[1]}](mention:${encodeURIComponent(participantId)})` });
  }
  for (const change of changes.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, change.start) + change.text + text.slice(change.end);
  }
  return text;
}

/** Only actual inline Markdown links can mention a known room participant. */
export function participantMentionLinks(text: string, participantIds: ReadonlySet<string>): string[] {
  const nodes = [...fromMarkdown(text).children];
  const mentions = new Set<string>();
  for (const node of nodes) {
    if ("children" in node) nodes.push(...node.children);
    if (node.type !== "link" || !node.url.startsWith("mention:")) continue;
    let target: string;
    try { target = decodeURIComponent(node.url.slice(8)); } catch { continue; }
    if (participantIds.has(target)) mentions.add(target);
  }
  return [...mentions];
}

const messageMentions = new WeakMap<ConversationMessage, { members: string; ids: string[] }>();
/** Read-only compatibility for older public messages; never rewrites their entries or emits notifications. */
export function projectedMessageMentions(message: ConversationMessage, participantIds: ReadonlySet<string>): string[] {
  const members = JSON.stringify([...participantIds].sort());
  const cached = messageMentions.get(message);
  if (cached?.members === members) return cached.ids;
  const ids = [...new Set([...message.mentions, ...participantMentionLinks(message.text, participantIds)])].sort();
  messageMentions.set(message, { members, ids });
  return ids;
}
