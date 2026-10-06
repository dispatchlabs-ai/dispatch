import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./session";

/** Presence contains no draft text. Each composer has its own ordered, expiring signal. */
export function useComposingPresence(chatId: string, enabled: boolean) {
  const { api } = useSession();
  const [unavailable, setUnavailable] = useState(false);
  const [clientId] = useState(() => crypto.randomUUID());
  const sequence = useRef(0);
  const lastSent = useRef(0);
  const active = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  const path = `/api/chats/${encodeURIComponent(chatId)}/composing`;

  const publish = useCallback((composing: boolean, keepalive = false) => {
    const input = { clientId, sequence: ++sequence.current, active: composing };
    if (keepalive) {
      void fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), keepalive: true }).catch(() => {});
    } else {
      void api(path, input, AbortSignal.timeout(5_000)).then(() => { if (mounted.current) setUnavailable(false); }).catch(() => { if (mounted.current) setUnavailable(true); });
    }
  }, [api, clientId, path]);

  const clear = useCallback((keepalive = false) => {
    clearTimeout(idle.current);
    if (!active.current) return;
    active.current = false;
    lastSent.current = 0;
    publish(false, keepalive);
  }, [publish]);

  const pulse = useCallback(() => {
    if (!enabled || document.hidden) return;
    const now = Date.now();
    if (!active.current || now - lastSent.current >= 1_500) { publish(true); lastSent.current = now; }
    active.current = true;
    clearTimeout(idle.current);
    idle.current = setTimeout(() => clear(), 3_500);
  }, [enabled, publish, clear]);

  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.hidden) clear(true); };
    const leaving = () => clear(true);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    window.addEventListener("blur", leaving);
    return () => {
      mounted.current = false;
      clear(true);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("blur", leaving);
    };
  }, [clear]);
  useEffect(() => { if (!enabled) clear(); }, [enabled, clear]);
  return { pulse, clear, unavailable };
}
