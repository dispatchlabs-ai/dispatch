export type SearchSecret = {
  revision: number;
  source: "stored" | "environment" | "disconnected";
  status: "configured" | "missing" | "disconnected";
  agentIds: string[];
};
export type SaveSearchSecret = { revision: number; source: "stored" | "environment"; value?: string; agentIds: string[] };

export type NamedSecret = { id: string; name: string; revision: number; agentIds: string[] };
export type SaveNamedSecret = { name: string; value?: string; revision: number };
