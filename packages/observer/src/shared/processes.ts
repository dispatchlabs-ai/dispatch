import { z } from "zod";
import type { Activity } from "./contracts";

export type ProcessAgent = {
  key: string;
  sourceId: string;
  conversationId: number;
  name: string;
  title: string;
  parentKey?: string;
  startedAt?: number;
  lastAt?: number;
  response?: { entryId: number; at?: number; excerpt: string };
  active: number;
  failed: number;
  turns: number;
  parallelKeys: string[];
};
export type AgentProcess = {
  key: string;
  pid: number;
  name: string;
  application: string;
  startedAt?: number;
  agents: ProcessAgent[];
  issues: string[];
};
export type ProcessCatalog = {
  host: string;
  observedAt: string;
  processes: AgentProcess[];
  issues: string[];
};
export const processConversationSchema = z.object({
  sourceId: z.string().uuid(),
  conversationId: z.number().int().positive().safe(),
});
export const processTurnSchema = processConversationSchema.extend({
  entryId: z.number().int().positive().safe(),
});
export const processToolSchema = processTurnSchema.extend({
  callId: z.string(),
});
export type ProcessConversationRequest = z.infer<
  typeof processConversationSchema
>;
export type ProcessTurnRequest = z.infer<typeof processTurnSchema>;
export type ProcessToolRequest = z.infer<typeof processToolSchema>;
export type RecordedTurn = {
  entryId: number;
  number: number;
  at?: number;
  summary: string;
  tools: number;
  error: boolean;
};
export type ProcessTurns = {
  sequence: number;
  turns: RecordedTurn[];
};
export type TurnEvent = Omit<Activity, "record"> & {
  resultAt?: number;
  hasResult?: boolean;
};
export type TurnTranscript = {
  sequence: number;
  events: TurnEvent[];
};

export const readable = (value: string) =>
  value.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
export const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

export function processActivity(process: AgentProcess): string {
  if (process.issues.length) return "Activity unavailable";
  const pending = process.agents.filter((agent) => agent.active > 0).length;
  return pending
    ? `${pending} ${pending === 1 ? "agent" : "agents"} with pending work`
    : "No active agents";
}

export function lastProcessActivity(process: AgentProcess): number | undefined {
  const times = process.agents.flatMap((agent) =>
    agent.lastAt === undefined ? [] : [agent.lastAt],
  );
  return times.length ? Math.max(...times) : undefined;
}

/** A literal opening excerpt; it does not classify or infer a workflow outcome. */
export function responseExcerpt(text: string): string {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .slice(0, 3)
    .join("\n\n");
  if (paragraphs.length <= 600) return paragraphs;
  return `${paragraphs
    .slice(0, 600)
    .replace(/\s+\S*$/, "")
    .trimEnd()}…`;
}

/** A recorded label or a short literal path, never an inferred outcome. */
export function toolLabel(event: {
  tool?: { name: string; arguments?: unknown };
  title: string;
}): string {
  const args = event.tool?.arguments as Record<string, unknown> | undefined;
  const name = readable(event.tool?.name ?? event.title);
  if (!args) return name;
  const path = args.path ?? args.file_path;
  const shortPath =
    typeof path === "string"
      ? path.split(/[\\/]/).slice(-2).join("/")
      : undefined;
  const label =
    args.description ??
    args.title ??
    shortPath ??
    args.skill ??
    args.url ??
    args.query;
  if (typeof label === "string")
    return `${name} · ${oneLine(label).slice(0, 150)}`;
  const command = args.command ?? args.cmd;
  if (typeof command === "string") {
    const first = command.trim().split("\n")[0];
    return `${name} · ${oneLine(first).slice(0, 150)}`;
  }
  return name;
}
