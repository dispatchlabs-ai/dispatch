export type SearchSecret = {
  revision: number;
  source: "stored" | "environment" | "disconnected";
  status: "configured" | "missing" | "disconnected";
  agentIds: string[];
};
export type SaveSearchSecret = { revision: number; source: "stored" | "environment"; value?: string; agentIds: string[] };
