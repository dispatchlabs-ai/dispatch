import { useCallback, useEffect, useState } from "react";
import type { AgentDefinition } from "../shared/contracts";
import { ApiError, errorMessage } from "./api";
import { useSession } from "./session";

export type ManagementField = "instructions" | "provider" | "modelId" | "thinkingLevel";
export type ManagementPolicy = {
  editorRevision: number;
  action: "read" | "save";
  fields: ManagementField[];
  maxSavesPerHour: number;
};
export type ManagementGrant = {
  editorId: string;
  targetId: string;
  version: number;
  policy: ManagementPolicy | null;
};
export type GrantRequest = {
  editorId: string;
  targetId: string;
  expectedVersion: number;
  requestId: string;
  reason: string;
  policy: ManagementPolicy | null;
};

export function useAgentGrants(editorId: string) {
  const { api } = useSession();
  const [grants, setGrants] = useState<ManagementGrant[] | null>(null);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [result, catalog] = await Promise.all([
        api<{ grants: ManagementGrant[] }>("/api/agent-management/grants", undefined, signal),
        api<{ agents: AgentDefinition[] }>("/api/agents", undefined, signal),
      ]);
      if (signal?.aborted) return false;
      setGrants(result.grants.filter(grant => grant.editorId === editorId));
      setAgents(catalog.agents);
      setError("");
      return true;
    } catch (error) {
      if (!signal?.aborted) setError(errorMessage(error));
      return false;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, editorId]);
  useEffect(() => {
    const controller = new AbortController();
    setGrants(null);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const save = async (input: GrantRequest) => {
    const { grant } = await api<{ grant: ManagementGrant }>("/api/agent-management/grants", input);
    const result = await api<{ grants: ManagementGrant[] }>("/api/agent-management/grants");
    setGrants(result.grants.filter(item => item.editorId === editorId));
    const persisted = result.grants.find(item => item.editorId === grant.editorId && item.targetId === grant.targetId);
    if (!persisted || persisted.version !== grant.version || JSON.stringify(persisted.policy) !== JSON.stringify(grant.policy)) {
      throw new ApiError(409, "GRANT_READBACK_CONFLICT", "Access was saved, but changed again before confirmation. Review latest before continuing.");
    }
    return grant;
  };
  return { grants, agents, error, loading, refresh, save };
}
