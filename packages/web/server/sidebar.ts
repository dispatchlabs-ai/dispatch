import { runtimeSummary, type Runtime, type SidebarSnapshot } from "@dispatch/backend";

/** One coalesced native observation for every browser, not one discovery per tab. */
export function observeSidebar(runtime: Runtime) {
  const listeners = new Set<(value: SidebarSnapshot | null) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let cached: SidebarSnapshot | undefined;
  let previous = "";
  const tick = () => {
    if (pending) return pending;
    clearTimeout(timer);
    pending = (async () => {
      try {
        const value = await runtimeSummary(runtime);
        const encoded = JSON.stringify(value);
        cached = value;
        if (encoded !== previous) { previous = encoded; for (const listener of listeners) listener(value); }
      } catch { cached = undefined; previous = ""; for (const listener of listeners) listener(null); }
    })().finally(() => {
      pending = undefined;
      if (listeners.size) timer = setTimeout(() => void tick(), 2000);
    });
    return pending;
  };
  return {
    refresh: tick,
    subscribe(listener: (value: SidebarSnapshot | null) => void) {
      listeners.add(listener);
      if (cached && listeners.size > 1) listener(cached);
      else if (cached) { cached = undefined; previous = ""; }
      void tick();
      return () => { listeners.delete(listener); if (!listeners.size) clearTimeout(timer); };
    },
  };
}
