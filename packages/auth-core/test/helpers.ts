import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";
import { AUDIENCE, ISSUER } from "../src/constants";

export interface TestKeypair {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

export async function makeKeypair(kid: string): Promise<TestKeypair> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  const publicJwk: JWK = {
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
    kid,
    alg: "RS256",
    use: "sig",
  };
  return { privateKey: pair.privateKey as CryptoKey, publicJwk, kid };
}

export interface SignOptions {
  issuer?: string;
  audience?: string;
  ttlSeconds?: number;
  iat?: number;
  exp?: number;
}

export async function signToken(
  privateKey: CryptoKey,
  kid: string,
  payload: Record<string, unknown>,
  options: SignOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = options.iat ?? now;
  const exp = options.exp ?? iat + (options.ttlSeconds ?? 60);
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);
}

export function userPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sub: "11111111-2222-3333-a444-555555555555",
    name: "Test User",
    teams: ["66666666-7777-4888-8999-000000000000"],
    admin: false,
    ...overrides,
  };
}

export function servicePayload(
  scope: string[] = ["documents:write"],
): Record<string, unknown> {
  return { sub: "service:worker", scope };
}

export function fakeFetch(jwksProvider: () => JWK[]) {
  const calls: { url: string }[] = [];
  const impl = (async (url: string) => {
    calls.push({ url });
    return new Response(JSON.stringify({ keys: jwksProvider() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}
