import { useCallback, useEffect, useState } from "react";
import type { ManagedConnection } from "../shared/contracts";
import { errorMessage } from "./api";
import { useSession } from "./session";

/** Load only for delegation inspection/editing; a grant does not need catalog polling. */
export function useApprovedConnections(active: boolean) {
  const { api } = useSession();
  const [connections, setConnections] = useState<ManagedConnection[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await api<{ connections: ManagedConnection[] }>("/api/connections", undefined, signal);
      if (!signal?.aborted) { setConnections(result.connections); setError(""); }
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [active, refresh]);
  return { connections, loading, error, refresh };
}
