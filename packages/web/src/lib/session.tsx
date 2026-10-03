import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AuthEndpoints, AuthState } from "../shared/auth-contracts";
import { ApiError, errorMessage, request } from "./api";

type AuthRequest = <P extends keyof AuthEndpoints>(
  path: P,
  ...args: AuthEndpoints[P] extends { request: infer Body } ? [body: Body] : []
) => Promise<AuthEndpoints[P]["response"]>;

interface SessionContextValue {
  state: AuthState | null;
  setState: (state: AuthState) => void;
  api: typeof request;
  auth: AuthRequest;
  startupError: string | null;
  reload: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const enrollmentToken = useRef<string | null>(null);
  const readLocation = useRef(false);

  const api = useCallback<typeof request>(async (path, body, signal) => {
    try {
      return await request(path, body, signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setState(current => current?.state === "authenticated" || error.code === "FLOW_EXPIRED" ? { state: "signed_out" } : current);
      }
      throw error;
    }
  }, []);

  const auth = useCallback<AuthRequest>((path, ...args) => api(path, args[0]), [api]);

  useEffect(() => {
    if (!readLocation.current) {
      readLocation.current = true;
      if (window.location.pathname === "/enroll" && window.location.hash.length > 1) {
        enrollmentToken.current = window.location.hash.slice(1);
        window.history.replaceState(null, "", "/enroll");
      }
    }
    const controller = new AbortController();
    setStartupError(null);
    const load = async () => {
      if (!enrollmentToken.current) return api<AuthState>("/api/auth/session", undefined, controller.signal);
      try {
        return await api<AuthState>("/api/auth/enrollment/start", { token: enrollmentToken.current }, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // A lost response can follow a successful, one-time invitation claim.
        const restored = await api<AuthState>("/api/auth/session", undefined, controller.signal);
        if (restored.state === "enrollment" || restored.state === "authenticated") return restored;
        if (error instanceof ApiError && error.code === "INVALID_INVITATION") enrollmentToken.current = null;
        throw error;
      }
    };
    load().then(next => {
      if (controller.signal.aborted) return;
      enrollmentToken.current = null;
      setState(next);
    }).catch(error => {
      if (!controller.signal.aborted) setStartupError(errorMessage(error));
    });
    return () => controller.abort();
  }, [api, attempt]);

  useEffect(() => {
    if (state?.state !== "authenticated") return;
    const expires = window.setTimeout(() => setState({ state: "signed_out" }), Math.max(0, state.expiresAt - Date.now()));
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      auth("/api/auth/session").then(next => setState(current => {
        if (next.state === "authenticated" && current?.state === "authenticated" && current.user.id === next.user.id && current.recoveryCodes) {
          return { ...next, recoveryCodes: current.recoveryCodes };
        }
        return next;
      })).catch(() => {
        // The current expiry still applies while the network is unavailable.
      });
    };
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(expires);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [state, auth]);

  return <SessionContext.Provider value={{ state, setState, api, auth, startupError, reload: () => setAttempt(current => current + 1) }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("SessionProvider is required.");
  return context;
}
