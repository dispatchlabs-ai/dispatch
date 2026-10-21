type ReplyElement = { type: "text"; text: string } | { type: "user"; user_id: string };

export function fallbackText(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/&lt;@([UW][A-Z0-9]+)&gt;/g, "<@$1>");
}

// Keep a partly generated mention out of the stream until its closing bracket
// arrives, so completing it does not change an already appended prefix.
export function streamText(text: string) {
  const opening = text.lastIndexOf("<");
  if (opening >= 0 && /^<(?:@(?:[UW][A-Z0-9]*)?)?$/.test(text.slice(opening))) text = text.slice(0, opening);
  return fallbackText(text);
}

export function replyChunk(text: string, offset: number, limit = 2900) {
  let end = Math.min(text.length, offset + limit);
  const opening = text.lastIndexOf("<@", end);
  if (opening > offset && opening < end && /^<@[UW][A-Z0-9]+>/.test(text.slice(opening))
    && text.indexOf(">", opening) >= end) end = opening;
  return text.slice(offset, end);
}

// Native user elements resolve names in Slack. Everything else remains literal
// text, including broadcast tags, rather than becoming notification markup.
export function replyBlocks(text: string) {
  const elements: ReplyElement[] = [];
  let offset = 0;
  for (const match of text.matchAll(/<@([UW][A-Z0-9]+)>/g)) {
    if (match.index > offset) elements.push({ type: "text", text: text.slice(offset, match.index) });
    elements.push({ type: "user", user_id: match[1] });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) elements.push({ type: "text", text: text.slice(offset) });
  return [{ type: "rich_text" as const, elements: [{ type: "rich_text_section" as const, elements }] }];
}
