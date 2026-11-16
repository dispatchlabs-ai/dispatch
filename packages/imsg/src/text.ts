import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { visit } from "unist-util-visit";

function labelValue(label = "", value = "") {
  if (!label || !value) return label || value;
  return label + (label.endsWith(":") ? " " : ": ") + value;
}

function tableText(headers: string[], rows: string[][]) {
  const width = rows.reduce((count, row) => Math.max(count, row.length), headers.length);
  const caption = headers.filter(Boolean).join(" · ");
  if (!rows.length) return caption;
  if (width <= 2) {
    return [caption, ...rows.map(([label, value]) => "• " + labelValue(label, value))].filter(Boolean).join("\n");
  }

  // Consecutive rows with a shared category read naturally as a single list.
  const grouped = width === 3 && rows.some(([category, item], i) =>
    category && item && i > 0 && rows[i - 1][0] === category && rows[i - 1][1]);
  const sections: string[] = [];
  let previousCategory = "";
  for (const [title, ...values] of rows) {
    if (grouped && title && values[0]) {
      if (title !== previousCategory) sections.push(title);
      sections[sections.length - 1] += "\n• " + labelValue(values[0], values[1]);
      previousCategory = title;
    } else if (grouped && title && !values[0]) {
      sections.push([title, values[1]].filter(Boolean).join(" — "));
      previousCategory = "";
    } else {
      const fields = values.flatMap((value, i) => value ? [labelValue(headers[i + 1] || "Column " + (i + 2), value)] : []);
      const rowTitle = title && labelValue(headers[0], title);
      sections.push([rowTitle, ...fields].filter(Boolean).join("\n"));
      previousCategory = "";
    }
  }
  const body = sections.filter(Boolean).join("\n\n");
  return grouped && caption ? caption + "\n" + body : body;
}

/** Format the outgoing Messages body. The conversation keeps its original answer. */
export function messageText(markdown: string): string {
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const links = new Map<string, string>();
  visit(root, "definition", node => { if (!links.has(node.identifier)) links.set(node.identifier, node.url); });
  function link(label: string, url?: string) {
    if (!url || url === label || url === "mailto:" + label) return label;
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
  function render(node: Nodes): string {
    switch (node.type) {
      case "text": case "inlineCode": case "code": case "yaml": return node.value;
      case "html": return /^<br\s*\/?>$/i.test(node.value) ? "\n" : node.value;
      case "break": return "\n";
      case "thematicBreak": return "———";
      case "definition": return "";
      case "link": return link(node.children.map(render).join(""), node.url);
      case "image": return link(node.alt ?? "", node.url);
      case "linkReference": return link(node.children.map(render).join(""), links.get(node.identifier));
      case "imageReference": return link(node.alt ?? "", links.get(node.identifier));
      case "footnoteReference": return "[" + (node.label ?? node.identifier) + "]";
      case "footnoteDefinition": return "[" + (node.label ?? node.identifier) + "] " + blocks(node.children);
      case "delete": return "(deleted: " + node.children.map(render).join("") + ")";
      case "blockquote": return "“" + blocks(node.children) + "”";
      case "list": return node.children.map((item, i) => {
        const check = item.checked == null ? "" : item.checked ? "☑" : "☐";
        const marker = node.ordered ? [(node.start ?? 1) + i + ".", check].filter(Boolean).join(" ") : check || "•";
        return marker + " " + blocks(item.children).replace(/\n(?=.)/g, "\n  ");
      }).join(node.spread ? "\n\n" : "\n");
      case "table": {
        const [headers, ...rows] = node.children.map(row => row.children.map(cell => cell.children.map(render).join("").trim()));
        return tableText(headers, rows);
      }
      default: return node.children.map(render).join("");
    }
  }
  return blocks(root.children) || markdown;
}
