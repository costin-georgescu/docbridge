import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AUDIENCE, ISSUER, JwksClient } from "@docbridge/auth-core";
import { PrismaClient } from "@docbridge/db-platform";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { PrismaService } from "../src/prisma/prisma.service";

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

export async function signToken(
  privateKey: CryptoKey,
  kid: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
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

export async function bootApp(
  kp: TestKeypair,
  prisma?: { db: PrismaClient },
): Promise<INestApplication> {
  const fake = fakeFetch(() => [kp.publicJwk]);
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JwksClient)
    .useValue(
      new JwksClient({
        jwksUrl: "http://auth.test/auth/.well-known/jwks.json",
        fetch: fake.fetch,
        cooldownMs: 0,
      }),
    );
  if (prisma) {
    builder = builder.overrideProvider(PrismaService).useValue(prisma);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}
