export type WatchOptions = { stateRoot: string; namespace?: string; session?: string; signal?: AbortSignal };
export type WatchStore = { agent: string; path: string; namespace: string; pids: number[] };
export type WatchRun = {
  key: string; path: string; session: string; pids: number[]; stores: WatchStore[];
  observedAt: number; issues: string[];
};
export type WatchCursor = { sequence: number; entryId: number };
export type WatchConversation = {
  key: string; agent: string; conversationId: number; title: string; parentKey?: string;
  active: number; failed: number; status: "working" | "waiting" | "idle" | "unavailable";
  activity: string; updatedAt?: number; startedAt?: number; entryCount: number;
  latestMessage?: WatchActivity;
  currentTools?: WatchActivity[];
};
export type WatchActivity = {
  id: string; conversationKey: string; entryId: number; sequence: number; at?: number;
  kind: "message" | "tool-call" | "tool-result"; role?: "user" | "assistant";
  title: string; text: string; toolCallId?: string; error?: boolean; arguments?: unknown;
  result?: { text: string; error: boolean; at?: number };
};
export type WatchSnapshot = {
  run: WatchRun; conversations: WatchConversation[]; activity: WatchActivity[];
  unavailableAgents: string[]; issues: string[]; observedAt: number;
};
export type WatchPage = {
  entries: WatchActivity[]; hasEarlier: boolean; before?: WatchCursor; observedAt: number;
};
