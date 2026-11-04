import { TokenResponse, UserClaims } from "@docbridge/contracts";
import { ApiError, request } from "../lib/api";
import { decodeClaims } from "../lib/jwt";

export interface SessionState {
  status: "restoring" | "anonymous" | "authenticated";
  token: string | null;
  claims: UserClaims | null;
}

export interface SessionDeps {
  fetch?: typeof globalThis.fetch;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export interface Session {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  ready(): Promise<void>;
  restore(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  authFetch<T>(path: string, init?: RequestInit): Promise<T>;
}

// Only a definitive 401/403 from /auth/refresh ends the session. Transient
// failures (network drop, auth 5xx) keep the session and retry on a short
// timer: going anonymous aborts in-flight uploads and wipes the batch.
const REFRESH_RETRY_MS = 30_000;
const MIN_REFRESH_DELAY_MS = 5_000;
const RESTORE_ATTEMPTS = 3;
const RESTORE_RETRY_DELAY_MS = 2_000;

const isAuthRejection = (err: unknown): boolean =>
  err instanceof ApiError && (err.status === 401 || err.status === 403);

export function createSession(deps: SessionDeps = {}): Session {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const setTimeoutImpl = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutImpl = deps.clearTimeout ?? globalThis.clearTimeout;

  let state: SessionState = {
    status: "restoring",
    token: null,
    claims: null,
  };
  const listeners = new Set<() => void>();
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlightRefresh: Promise<void> | null = null;
  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const setState = (next: SessionState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  const clearRefreshTimer = () => {
    if (refreshTimer) {
      clearTimeoutImpl(refreshTimer);
      refreshTimer = null;
    }
  };

  const scheduleRefresh = (delayMs: number) => {
    clearRefreshTimer();
    refreshTimer = setTimeoutImpl(() => {
      void refresh().catch(() => {});
    }, delayMs);
  };

  const applyTokens = (tokens: TokenResponse) => {
    const claims = decodeClaims(tokens.accessToken);
    scheduleRefresh(
      Math.max(MIN_REFRESH_DELAY_MS, (tokens.expiresIn - 60) * 1000),
    );
    setState({
      status: "authenticated",
      token: tokens.accessToken,
      claims,
    });
  };

  const refresh = (): Promise<void> => {
    if (!inFlightRefresh) {
      inFlightRefresh = (async () => {
        try {
          const tokens = await request<TokenResponse>("/auth/refresh", {
            method: "POST",
            fetch: fetchImpl,
          });
          applyTokens(tokens);
        } catch (err) {
          if (isAuthRejection(err)) {
            clearRefreshTimer();
            setState({ status: "anonymous", token: null, claims: null });
          } else if (state.status === "authenticated") {
            scheduleRefresh(REFRESH_RETRY_MS);
          }
          throw err;
        } finally {
          inFlightRefresh = null;
        }
      })();
    }
    return inFlightRefresh;
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready: () => readyPromise,
    restore: async () => {
      for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
        try {
          await refresh();
          break;
        } catch (err) {
          if (isAuthRejection(err)) break;
          if (attempt + 1 < RESTORE_ATTEMPTS) {
            await new Promise<void>((r) =>
              setTimeoutImpl(r, RESTORE_RETRY_DELAY_MS),
            );
          }
        }
      }
      if (state.status === "restoring") {
        // Every attempt failed transiently (e.g. auth down at page load).
        // Nothing in-memory exists yet, so settling as anonymous only
        // costs a re-login once the service recovers.
        setState({ status: "anonymous", token: null, claims: null });
      }
      resolveReady();
    },
    login: async (email, password) => {
      const tokens = await request<TokenResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
        fetch: fetchImpl,
      });
      applyTokens(tokens);
    },
    logout: async () => {
      try {
        await request("/auth/logout", { method: "POST", fetch: fetchImpl });
      } catch {
        // best effort; the local session is dropped regardless
      }
      clearRefreshTimer();
      setState({ status: "anonymous", token: null, claims: null });
    },
    refresh,
    authFetch: async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const token = state.token;
      if (!token) {
        throw new ApiError(401, "unauthorized", "Not authenticated");
      }
      try {
        return await request<T>(path, { ...init, token, fetch: fetchImpl });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          try {
            await refresh();
          } catch {
            throw err;
          }
          return await request<T>(path, {
            ...init,
            token: state.token!,
            fetch: fetchImpl,
          });
        }
        throw err;
      }
    },
  };
}

export const session = createSession();
