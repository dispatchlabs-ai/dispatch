import { randomUUID } from "node:crypto";
import type { Nodes, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { visit } from "unist-util-visit";

export type Cell = { text: string; bold?: boolean };
export type TableImage = {
  name: string;
  rows: Cell[][];
  align: ("left" | "center" | "right" | null)[];
};
export type MessagePart = { text: string } | { table: TableImage };

const parse = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

/** Split only real Markdown tables. The original answer remains in the conversation. */
export function messageParts(markdown: string): MessagePart[] {
  const root = parse(markdown);
  const links = new Map<string, string>();
  visit(root, "definition", node => { if (!links.has(node.identifier)) links.set(node.identifier, node.url); });

  function link(label: string, url?: string, destinations?: Set<string>) {
    if (!url || url === label || url === "mailto:" + label) {
      if (url) destinations?.add(url);
      return label;
    }
    if (destinations) { destinations.add(label ? label + " (" + url + ")" : url); return label || url; }
    return label ? label + " (" + url + ")" : url;
  }
  function blocks(nodes: Nodes[]) {
    const parts: string[] = [];
    let lastLine = 0;
    for (const node of nodes) {
      const value = render(node);
      if (!value) continue;
      if (parts.length) parts.push(node.position?.start.line === lastLine + 1 ? "\n" : "\n\n");
      parts.push(value);
      lastLine = node.position?.end.line ?? 0;
    }
    return parts.join("");
  }
  function render(node: Nodes, destinations?: Set<string>): string {
    const children = () => "children" in node ? node.children.map(child => render(child, destinations)).join("") : "";
    switch (node.type) {
      case "text": case "inlineCode": case "code": case "yaml": return node.value;
      case "html": return /^<br\s*\/?>$/i.test(node.value) ? "\n" : node.value;
      case "break": return "\n";
      case "thematicBreak": return "———";
      case "definition": return "";
      case "link": return link(children(), node.url, destinations);
      case "image": return link(node.alt ?? "", node.url, destinations);
      case "linkReference": return link(children(), links.get(node.identifier), destinations);
      case "imageReference": return link(node.alt ?? "", links.get(node.identifier), destinations);
      case "footnoteReference": return "[" + (node.label ?? node.identifier) + "]";
      case "footnoteDefinition": return "[" + (node.label ?? node.identifier) + "] " + blocks(node.children);
      case "delete": return "(deleted: " + children() + ")";
      case "blockquote": { const body = blocks(node.children); return body ? "“" + body + "”" : ""; }
      case "list": return node.children.flatMap((item, i) => {
        const body = blocks(item.children);
        if (!body) return [];
        const check = item.checked == null ? "" : item.checked ? "☑" : "☐";
        const marker = node.ordered ? [(node.start ?? 1) + i + ".", check].filter(Boolean).join(" ") : check || "•";
        return [marker + " " + body.replace(/\n(?=.)/g, "\n  ")];
      }).join(node.spread ? "\n\n" : "\n");
      default: return children();
    }
  }
  const tables: Table[] = [];
  visit(root, "table", table => { tables.push(table); });
  if (!tables.length) return [{ text: blocks(root.children) || markdown }];
  // Keep the parsed nodes on either side of a table so reference links and
  // nested list numbering still have the context of the complete answer.
  function slice(node: Nodes, from: number, to: number): Nodes[] {
    const start = node.position!.start.offset!, end = node.position!.end.offset!;
    if (end <= from || start >= to) return [];
    if (start >= from && end <= to) return [node];
    if (!("children" in node)) return [];
    const children = node.children.flatMap(child => slice(child, from, to));
    if (!children.length) return [];
    const copy = { ...node, children } as Nodes;
    if (node.type === "list" && node.ordered && copy.type === "list")
      copy.start = (node.start ?? 1) + node.children.filter(item => item.position!.end.offset! <= from).length;
    return [copy];
  }
  const textBetween = (from: number, to: number) => blocks(root.children.flatMap(node => slice(node, from, to)));
  const parts: MessagePart[] = [];
  const appendText = (value: string) => {
    if (!value.trim()) return;
    const last = parts.at(-1);
    if (last && "text" in last) last.text += "\n\n" + value;
    else parts.push({ text: value });
  };
  let offset = 0;
  for (const table of tables) {
    appendText(textBetween(offset, table.position!.start.offset!));
    const destinations = new Set<string>();
    const rows = table.children.map(row => row.children.map(cell => ({
      text: cell.children.map(child => render(child, destinations)).join("").trim(),
      ...(cell.children.some(child => child.type === "strong") &&
        cell.children.every(child => child.type === "strong" || (child.type === "text" && !child.value.trim())) ? { bold: true } : {}),
    })));
    parts.push({ table: { name: "Table-" + randomUUID() + ".png", rows, align: table.align ?? [] } });
    appendText([...destinations].join("\n"));
    offset = table.position!.end.offset!;
  }
  appendText(textBetween(offset, markdown.length));
  return parts;
}
