import { TokenResponse } from "@docbridge/contracts";

/** Renew when under 10 min remain; a 1 h token is fetched again at ~50 min. */
export const RENEW_BEFORE_MS = 10 * 60 * 1000;
/** A cached token closer to expiry than this is too risky to hand out. */
const USAGE_BUFFER_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export class ServiceTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceTokenError";
  }
}

export interface ServiceTokensOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

/**
 * Caches the auth-issued service token (ADR-21) and renews it ahead of
 * expiry. Concurrent callers share one in-flight request, and a cached
 * token keeps being served while a renewal fails in the background.
 */
export class ServiceTokens {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(options: ServiceTokensOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetch ?? fetch;
  }

  getToken(): Promise<string> {
    if (this.cached !== null) {
      const remaining = this.cached.expiresAt - Date.now();
      if (remaining > RENEW_BEFORE_MS) {
        return Promise.resolve(this.cached.token);
      }
      if (remaining > USAGE_BUFFER_MS) {
        // Still usable: refresh in the background so an auth blip does not
        // fail a delivery; the caller only blocks once the cached token is
        // too close to expiry.
        this.inflight ??= this.fetchToken().finally(() => {
          this.inflight = null;
        });
        void this.inflight.catch(() => undefined);
        return Promise.resolve(this.cached.token);
      }
    }
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/auth/service-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ServiceTokenError(
        `service token request failed: ${(e as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new ServiceTokenError(
        `service token request answered ${res.status}`,
      );
    }
    const parsed = TokenResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      throw new ServiceTokenError("service token response was invalid");
    }
    this.cached = {
      token: parsed.data.accessToken,
      expiresAt: Date.now() + parsed.data.expiresIn * 1000,
    };
    return parsed.data.accessToken;
  }
}
