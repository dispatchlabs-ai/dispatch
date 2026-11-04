import { terminalText } from "./terminal-output.js";
import type { WatchActivity } from "./watch-types.js";

export const clean = (value: string): string => terminalText(value).replace(/\t/g, "  ");
export const oneLine = (value: string): string => clean(value).replace(/\s+/g, " ").trim();
export const humanName = (value: string): string => oneLine(value).replace(/[-_]+/g, " ").replace(/^./, char => char.toUpperCase());
export const clock = (at?: number): string => at ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Time unavailable";
export function age(at?: number): string {
  if (!at) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

const shortPath = (value: string): string => oneLine(value).split("/").filter(Boolean).slice(-2).join("/");

/** Use recorded labels, never a model-generated interpretation of tool output. */
export function actionTitle(activity: WatchActivity): string {
  const args = activity.arguments && typeof activity.arguments === "object"
    ? activity.arguments as Record<string, unknown> : {};
  for (const key of ["title", "description"]) {
    if (typeof args[key] === "string" && args[key].trim()) return oneLine(args[key]);
  }
  const path = args.path ?? args.file_path;
  if (typeof path === "string") {
    const verb = ({ read: "Read", write: "Write", edit: "Edit" } as Record<string, string>)[activity.title];
    if (verb) return `${verb} ${shortPath(path)}`;
  }
  const command = args.command ?? args.cmd;
  if (typeof command === "string") {
    // Shell scripts commonly start each operation with a literal progress label.
    // Only display a quoted literal; substitutions and format strings stay raw.
    const label = command.match(/\b(?:printf|echo)\s+(['"])([^'"\n]+)\1/);
    if (label && !/[$`%]/.test(label[2])) {
      const text = label[2].replace(/\\[nrt]/g, " ").trim();
      if (text) return oneLine(text);
    }
    const first = command.trim().split(/\n|&&|;/)[0];
    if (first.length <= 90 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return oneLine(first);
    return "Run shell command";
  }
  if (typeof args.query === "string") return `Search: ${oneLine(args.query)}`;
  if (typeof args.url === "string") return `Open ${oneLine(args.url)}`;
  return humanName(activity.title);
}

export type FeedRow = {
  key: string;
  kind: "message" | "tool" | "group";
  activity: WatchActivity;
  tools?: WatchActivity[];
};
export type FeedFilter = "updates" | "all" | "errors";

export function toolState(activity: WatchActivity): "error" | "done" | "pending" {
  if (activity.kind === "tool-result") return activity.error ? "error" : "done";
  return activity.result ? activity.result.error ? "error" : "done" : "pending";
}

export function pairedActivity(entries: WatchActivity[]): WatchActivity[] {
  const key = (entry: WatchActivity) => `${entry.conversationKey}:${entry.toolCallId}`;
  const results = new Map(entries.filter(entry => entry.kind === "tool-result" && entry.toolCallId).map(entry => [key(entry), entry]));
  const calls = new Set(entries.filter(entry => entry.kind === "tool-call" && entry.toolCallId).map(key));
  return entries.flatMap(entry => {
    if (entry.kind === "tool-result" && entry.toolCallId && calls.has(key(entry))) return [];
    const result = entry.kind === "tool-call" && entry.toolCallId ? results.get(key(entry)) : undefined;
    return [{ ...entry, result: entry.result ?? (result ? { text: result.text, error: Boolean(result.error), at: result.at } : undefined) }];
  });
}

export function feedRows(entries: WatchActivity[], filter: FeedFilter, expanded: Set<string>, query: string): FeedRow[] {
  const rows: FeedRow[] = [];
  const search = query.trim().toLocaleLowerCase();
  for (const activity of pairedActivity(entries)) {
    const message = activity.kind === "message";
    if (filter === "errors" && (message || toolState(activity) !== "error")) continue;
    if (search && ![activity.text, actionTitle(activity), JSON.stringify(activity.arguments), activity.result?.text]
      .some(value => value?.toLocaleLowerCase().includes(search))) continue;
    if (message || filter !== "updates" || search) {
      rows.push({ key: activity.id, kind: message ? "message" : "tool", activity });
      continue;
    }
    const previous = rows.at(-1);
    if (previous?.kind === "group" && previous.activity.conversationKey === activity.conversationKey) previous.tools!.push(activity);
    else rows.push({ key: `group:${activity.id}`, kind: "group", activity, tools: [activity] });
  }
  return rows.flatMap(row => row.kind === "group" && expanded.has(row.key)
    ? [row, ...row.tools!.map(activity => ({ key: activity.id, kind: "tool" as const, activity }))] : [row]);
}
