import type { ToolActivity } from "../lib/tool-activity.js";

export type ActivityBlock =
  | { id: string; kind: "tool"; tool: ToolActivity }
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "event"; label: string; data: unknown }
  | { id: string; kind: "large"; label: string };
export interface ActivityPage { items: ActivityBlock[]; before: number | null; total: number }
