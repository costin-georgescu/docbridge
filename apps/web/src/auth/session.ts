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

  const applyTokens = (tokens: TokenResponse) => {
    const claims = decodeClaims(tokens.accessToken);
    if (refreshTimer) {
      clearTimeoutImpl(refreshTimer);
    }
    refreshTimer = setTimeoutImpl(
      () => {
        void refresh().catch(() => {});
      },
      Math.max(0, (tokens.expiresIn - 60) * 1000),
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
          setState({ status: "anonymous", token: null, claims: null });
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
      try {
        await refresh();
      } catch {
        // anonymous state already applied by refresh()
      } finally {
        resolveReady();
      }
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
      if (refreshTimer) {
        clearTimeoutImpl(refreshTimer);
        refreshTimer = null;
      }
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
