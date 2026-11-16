import { createRequire } from "node:module";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import type { TableImage } from "./text.js";

const require = createRequire(import.meta.url);
GlobalFonts.registerFromPath(require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"), "Dispatch Inter");
const family = '"Dispatch Inter", "Helvetica Neue", sans-serif';
const font = (bold: boolean) => (bold ? "700" : "400") + " 16px " + family;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const pad = 12;
const lineHeight = 22;

function wrap(ctx: SKRSContext2D, value: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (ctx.measureText(next).width <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      if (ctx.measureText(word).width <= width) continue;
      line = "";
      for (const { segment } of graphemes.segment(word)) {
        if (line && ctx.measureText(line + segment).width > width) { lines.push(line); line = ""; }
        line += segment;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Lay out in logical pixels and export at phone display density. */
export async function renderTable(table: TableImage): Promise<Buffer> {
  const measure = createCanvas(1, 1).getContext("2d");
  const columns = table.rows.reduce((width, row) => Math.max(width, row.length), 0);
  const natural = Array<number>(columns).fill(pad * 2);
  for (const [r, row] of table.rows.entries()) {
    row.forEach((cell, i) => {
      measure.font = font(!r || !!cell.bold);
      for (const line of cell.text.split("\n")) natural[i] = Math.max(natural[i], Math.ceil(measure.measureText(line).width) + 2 * pad);
    });
  }
  const minimum = natural.map(width => Math.min(width, 112));
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const floor = sum(minimum), ideal = sum(natural);
  const target = Math.max(330, floor, Math.min(480, ideal));
  const widths = natural.map((n, i) => Math.ceil(ideal > target
    ? minimum[i] + (n - minimum[i]) * (target - floor) / (ideal - floor)
    : n + (target - ideal) / columns));
  const rows = table.rows.map((row, r) => {
    const cells = row.map((cell, i) => {
      const bold = r === 0 || !!cell.bold;
      measure.font = font(bold);
      return { bold, lines: wrap(measure, cell.text, widths[i] - 2 * pad) };
    });
    return { cells, height: cells.reduce((n, cell) => Math.max(n, cell.lines.length), 1) * lineHeight + 18 };
  });
  const width = sum(widths) + 2, height = sum(rows.map(row => row.height)) + 2;
  const scale = 3;
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  let y = 1;
  rows.forEach((row, r) => {
    if (r === 0) { ctx.fillStyle = "#f6f7f8"; ctx.fillRect(1, y, width - 2, row.height); }
    let x = 1;
    row.cells.forEach((cell, col) => {
      const align = table.align[col] || "left";
      ctx.textAlign = align;
      ctx.font = font(cell.bold);
      ctx.fillStyle = "#181a1c";
      const anchor = align === "right" ? widths[col] - pad : align === "center" ? widths[col] / 2 : pad;
      cell.lines.forEach((line, i) => ctx.fillText(line, x + anchor, y + 24 + i * lineHeight));
      x += widths[col];
    });
    y += row.height;
    ctx.fillStyle = "#d9dbde"; ctx.fillRect(0, y - 1, width, 1);
  });
  ctx.strokeStyle = "#d9dbde"; ctx.strokeRect(.5, .5, width - 1, height - 1);
  return canvas.encode("png");
}
