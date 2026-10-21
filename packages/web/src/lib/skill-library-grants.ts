import { useCallback, useEffect, useState } from "react";
import { ApiError, errorMessage } from "./api";
import { useSession } from "./session";

export type SkillLibraryPolicy = { editorRevision: number; action: "read" | "save"; maxSavesPerHour?: number };
export type SkillLibraryGrant = { editorId: string; version: number; policy: SkillLibraryPolicy | null };
export type SkillLibraryGrantRequest = { editorId: string; expectedVersion: number; requestId: string; reason?: string; policy: SkillLibraryPolicy | null };

export function useSkillLibraryGrant(editorId: string) {
  const { api } = useSession();
  const [grant, setGrant] = useState<SkillLibraryGrant | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await api<{ grants: SkillLibraryGrant[] }>("/api/skill-library/grants", undefined, signal);
      if (signal?.aborted) return false;
      setGrant(result.grants.find(item => item.editorId === editorId) ?? null);
      setError("");
      return true;
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
      return false;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, editorId]);
  useEffect(() => {
    const controller = new AbortController();
    setGrant(null);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  const save = async (input: SkillLibraryGrantRequest) => {
    const { grant: saved } = await api<{ grant: SkillLibraryGrant }>("/api/skill-library/grants", input);
    const result = await api<{ grants: SkillLibraryGrant[] }>("/api/skill-library/grants");
    const persisted = result.grants.find(item => item.editorId === editorId);
    setGrant(persisted ?? null);
    if (!persisted || persisted.version !== saved.version || JSON.stringify(persisted.policy) !== JSON.stringify(saved.policy)) {
      throw new ApiError(409, "LIBRARY_GRANT_READBACK_CONFLICT", "Library access was saved, but changed again before confirmation. Review latest before continuing.");
    }
    return saved;
  };
  return { grant, loading, error, refresh, save };
}
