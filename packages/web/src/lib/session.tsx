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
  refreshSession: () => Promise<void>;
  startupError: string | null;
  reload: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, updateState] = useState<AuthState | null>(null);
  const currentState = useRef<AuthState | null>(null);
  const generation = useRef(0);
  const mutation = useRef<Promise<unknown> | null>(null);
  const appliedResponses = useRef(new WeakSet<AuthState>());
  const [startupError, setStartupError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const enrollmentToken = useRef<string | null>(null);
  const readLocation = useRef(false);

  const setState = useCallback((next: AuthState) => {
    // A caller cannot replay an applied auth response after a newer action.
    if (appliedResponses.current.has(next)) return;
    generation.current += 1;
    currentState.current = next;
    updateState(next);
  }, []);

  const handleAuthError = useCallback((error: unknown, started: number) => {
    if (started !== generation.current || !(error instanceof ApiError) || error.status !== 401) return;
    if (error.code === "SIGN_IN_REQUIRED" || error.code === "unauthenticated" ||
        (error.code === "FLOW_EXPIRED" && currentState.current?.state !== "authenticated")) {
      setState({ state: "signed_out" });
    }
  }, [setState]);

  const api = useCallback<typeof request>(async (path, body, signal) => {
    const started = generation.current;
    try {
      return await request(path, body, signal);
    } catch (error) {
      if (!mutation.current) handleAuthError(error, started);
      throw error;
    }
  }, [handleAuthError]);

  const auth = useCallback<AuthRequest>((path, ...args) => {
    const changing = args.length > 0;
    const cancelled = () => new DOMException("A newer authentication action replaced this request.", "AbortError");
    if (!changing && mutation.current) return Promise.reject(cancelled());
    const started = changing ? ++generation.current : generation.current;
    const perform = async () => {
      let result: AuthEndpoints[typeof path]["response"];
      try {
        result = await request(path, args[0]);
      } catch (error) {
        if (started !== generation.current) throw cancelled();
        handleAuthError(error, started);
        throw error;
      }
      if (started !== generation.current) throw cancelled();
      if ("state" in result) {
        const current = currentState.current;
        let next: AuthState = result;
        if (!changing && next.state === "authenticated" && current?.state === "authenticated" &&
            next.user.id === current.user.id && next.user.companyId === current.user.companyId &&
            next.expiresAt === current.expiresAt) {
          if (current.recoveryCodes) next = { ...next, recoveryCodes: current.recoveryCodes };
          currentState.current = next;
          updateState(next);
        } else setState(next);
        appliedResponses.current.add(result);
        appliedResponses.current.add(next);
      }
      return result;
    };
    const operation = perform().finally(() => {
      if (mutation.current === operation) mutation.current = null;
    });
    if (changing) mutation.current = operation;
    return operation;
  }, [handleAuthError, setState]);

  const refreshSession = useCallback(async () => {
    // A stream can report the old session's revocation before the factor-change
    // response installs its replacement cookie and one-time recovery codes.
    while (mutation.current) await mutation.current.catch(() => {});
    try { await auth("/api/auth/session"); } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    }
  }, [auth]);

  useEffect(() => {
    if (!readLocation.current) {
      readLocation.current = true;
      if (window.location.pathname === "/enroll" && window.location.hash.length > 1) {
        enrollmentToken.current = window.location.hash.slice(1);
        window.history.replaceState(null, "", "/enroll");
      }
    }
    const controller = new AbortController();
    const started = ++generation.current;
    setStartupError(null);
    const load = async () => {
      if (!enrollmentToken.current) return request<AuthState>("/api/auth/session", undefined, controller.signal);
      try {
        return await request<AuthState>("/api/auth/enrollment/start", { token: enrollmentToken.current }, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || started !== generation.current) throw error;
        // A lost response can follow a successful, one-time invitation claim.
        const restored = await request<AuthState>("/api/auth/session", undefined, controller.signal);
        if (restored.state === "enrollment" || restored.state === "authenticated") return restored;
        if (error instanceof ApiError && error.code === "INVALID_INVITATION") enrollmentToken.current = null;
        throw error;
      }
    };
    load().then(next => {
      if (controller.signal.aborted || started !== generation.current) return;
      enrollmentToken.current = null;
      setState(next);
    }).catch(error => {
      if (!controller.signal.aborted && started === generation.current) setStartupError(errorMessage(error));
    });
    return () => controller.abort();
  }, [setState, attempt]);

  useEffect(() => {
    if (state?.state !== "authenticated") return;
    const expires = window.setTimeout(() => {
      if (currentState.current === state) setState({ state: "signed_out" });
    }, Math.max(0, state.expiresAt - Date.now()));
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void refreshSession().catch(() => {
        // The current expiry still applies while the network is unavailable.
      });
    };
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(expires);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [state, refreshSession, setState]);

  return <SessionContext.Provider value={{ state, setState, api, auth, refreshSession, startupError, reload: () => setAttempt(current => current + 1) }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("SessionProvider is required.");
  return context;
}
