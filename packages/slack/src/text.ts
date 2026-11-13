import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import type { Nodes } from "mdast";

const parseMarkdown = (text: string) => fromMarkdown(text, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] });

export function fallbackText(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/&lt;@([UW][A-Z0-9]+)&gt;/g, "<@$1>");
}

// Code must remain byte-for-byte literal. Escaping the whole Markdown document
// would expose HTML entities inside code and disable blockquote markers.
export function markdownText(text: string) {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replace(/&lt;@([UW][A-Z0-9]+)>/g, "<@$1>");
  let result = "";
  let offset = 0;
  const visit = (node: Nodes) => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position!.start.offset!;
      const end = node.position!.end.offset!;
      result += escape(text.slice(offset, start)) + text.slice(start, end);
      offset = end;
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(parseMarkdown(text));
  return result + escape(text.slice(offset));
}

// Forward complete sentences or lines, while the final delivery retains every byte.
// A quiet provider should not leave a fragment such as "The latest" on screen.
export function progressText(text: string) {
  let end = text.lastIndexOf("\n") + 1;
  for (const match of text.matchAll(/[.!?](?:[*_~"'”’\])]*)(?=\s|$)/g))
    end = Math.max(end, match.index + match[0].length);
  return text.slice(0, end).trimEnd();
}

// Keep a partly generated mention out of the stream until its closing bracket
// arrives, so completing it does not change an already appended prefix.
export function streamText(text: string) {
  const opening = text.lastIndexOf("<");
  if (opening >= 0 && /^<(?:@(?:[UW][A-Z0-9]*)?)?$/.test(text.slice(opening))) text = text.slice(0, opening);
  return markdownText(text);
}

// Escaping can expand one character to five; stay within Markdown's 12,000.
export function replyChunk(text: string, offset: number, limit = 2400, markdown = true) {
  let end = Math.min(text.length, offset + limit);
  // Each final message is parsed separately. Prefer complete blocks; oversized
  // individual blocks use literal chunks in replyBlocks instead.
  if (markdown && end < text.length) {
    const blocks = parseMarkdown(text).children;
    const complete = blocks.filter(node => node.position!.end.offset! > offset && node.position!.end.offset! <= end);
    if (complete.length && end < text.length) end = complete.at(-1)!.position!.end.offset!;
    else {
      const next = blocks.find(node => node.position!.start.offset! > offset);
      if (next && next.position!.start.offset! < end && text.slice(offset, next.position!.start.offset!).trim()) {
        end = next.position!.start.offset!;
      }
    }
  }
  const opening = text.lastIndexOf("<@", end);
  if (opening > offset && opening < end && /^<@[UW][A-Z0-9]+>/.test(text.slice(opening))
    && text.indexOf(">", opening) >= end) end = opening;
  return text.slice(offset, end);
}

// Let Slack translate the model's Markdown, as it does for streamed chunks.
// A plain rich_text text element would display formatting markers literally.
export function replyBlocks(text: string, source = text, offset = 0) {
  const end = offset + text.length;
  const partial = parseMarkdown(source).children.some(node => {
    const start = node.position!.start.offset!;
    const stop = node.position!.end.offset!;
    return start < end && stop > offset && (start < offset || stop > end);
  });
  if (partial) return [{ type: "rich_text" as const, elements: [{
    type: "rich_text_section" as const, elements: [{ type: "text" as const, text }],
  }] }];
  return [{ type: "markdown" as const, text: markdownText(text) }];
}

export function userBlocks(text: string, source: string, offset: number, attribution: string) {
  const heading = { type: "rich_text" as const, elements: [{
    type: "rich_text_section" as const, elements: [{ type: "text" as const, text: attribution, style: { bold: true } }],
  }] };
  const [body] = replyBlocks(text, source, offset);
  // Wrap each delivered part so even a split paragraph/code block remains
  // visibly authored by the user. Complete blocks retain their Markdown.
  if (body.type !== "markdown") return [heading, { type: "rich_text" as const, elements: [{
      type: "rich_text_quote" as const, elements: [{ type: "text" as const, text }],
  }] }];
  // Slack renders tables inside blockquotes as raw pipes. Leave complete tables
  // at the top level under the same attribution, quoting the surrounding prose.
  const parts: string[] = [];
  const quote = (value: string) => { if (value.trim()) parts.push(value.split("\n").map(line => `> ${line}`).join("\n")); };
  let start = 0;
  for (const node of parseMarkdown(body.text).children) {
    if (node.type !== "table") continue;
    quote(body.text.slice(start, node.position!.start.offset!));
    start = node.position!.end.offset!;
    parts.push(body.text.slice(node.position!.start.offset!, start));
  }
  quote(body.text.slice(start));
  return [heading, { type: "markdown" as const, text: parts.join("\n\n") }];
}
