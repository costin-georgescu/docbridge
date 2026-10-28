import { createRemoteJWKSet, customFetch, type RemoteJWKSet } from "jose";

export interface JwksClientOptions {
  jwksUrl: string | URL;
  fetch?: typeof globalThis.fetch;
  cacheMaxAgeMs?: number;
  cooldownMs?: number;
  timeoutMs?: number;
}

const DEFAULT_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 5 * 1000;

export class JwksClient {
  private readonly jwks: RemoteJWKSet;

  constructor(options: JwksClientOptions) {
    this.jwks = createRemoteJWKSet(new URL(options.jwksUrl), {
      ...(options.fetch ? { [customFetch]: options.fetch } : {}),
      cacheMaxAge: options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS,
      cooldownDuration: options.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      timeoutDuration: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async warmUp(): Promise<void> {
    await this.jwks.reload();
  }

  get keyResolver(): RemoteJWKSet {
    return this.jwks;
  }
}
