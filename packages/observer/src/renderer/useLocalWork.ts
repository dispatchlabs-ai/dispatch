import { useEffect, useState } from "react";
import type { LocalWork } from "../shared/contracts";

export function useLocalWork(enabled: boolean) {
  const [data, setData] = useState<LocalWork>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      setLoading(true);
      try {
        const next = await window.observer.localWork();
        if (!cancelled) {
          setData(next);
          setError("");
        }
      } catch (error) {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(refresh, 5000);
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, revision]);
  return {
    data,
    error,
    loading,
    refresh: () => setRevision((value) => value + 1),
  };
}
